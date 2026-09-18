import { db, type Executor } from '@/lib/db'
import { enqueueJob, PRIORITY_REFRESH, PRIORITY_USER_WAITING, type EnqueuedJob, type JobRequest } from '@/lib/jobs'

/**
 * `readOrEnqueue()` — spec §3.1, the rule the whole product is shaped around.
 *
 * > **Golden rule:** no screen waits on PNCP, BrasilAPI or the AI inside a
 * > request. If data does not exist yet, the UI shows the "analyzing" state and
 * > updates when the job finishes.
 *
 * Every read route funnels through here, so there are exactly three answers a
 * screen can get and the client only has to know those three:
 *
 * | state | what we hold | what we do | status |
 * |---|---|---|---|
 * | `fresh` | a row inside its TTL | serve it | 200 |
 * | `stale` | a row past its TTL | serve it **and** queue a refresh | 200 |
 * | `absent` | nothing | queue at priority 1 | 202 |
 *
 * `stale` is the interesting one and the reason this is not `if (!row) 404`.
 * PNCP answers in seconds or minutes and returns 500s (§2); a route that
 * refused to answer without a fresh read would hand the user PNCP's latency and
 * PNCP's outages. So a stale row is a good answer with a caveat — the response
 * carries `ageSeconds` for the "atualizado há X min" line the design system
 * already draws — and the refresh happens behind the screen.
 *
 * ## Priority
 *
 * `absent` enqueues at 1 because a person is watching a spinner; `stale`
 * enqueues at 5 because they are reading data. §7.3 defines 1 as "a user
 * waiting on screen", and a stale refresh that jumped the queue would delay
 * somebody else's blank screen for the sake of somebody else's already-answered
 * one.
 *
 * ## De-duplication
 *
 * Two hundred people opening the same tender the minute it goes stale produce
 * one job, not two hundred: the partial unique index `jobs_dedupe` allows one
 * live row per `(kind, key)` and `enqueueJob` reports the rejection as
 * `deduped`, not as an error. The caller never needs to check first.
 */

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * Permanent: the row can never go stale, so nothing is ever enqueued for it.
 *
 * §3.2 gives this to a closed tender ("After closing: permanent"), to an award
 * once made, and to an AI analysis, which is keyed by prompt version +
 * extraction version + file hash and so is replaced by a *different row* rather
 * than refreshed.
 */
export const PERMANENT = null
export type Ttl = number | typeof PERMANENT

/**
 * The TTL table of spec §3.2, in milliseconds. Changing a number here changes
 * how often the worker is asked to go back to PNCP; nothing else reads §3.2.
 */
export const TTL = {
  /** Tenders receiving proposals — the continuous 30-minute sweep. */
  openTenderList: 30 * MINUTE,
  /** Tender header, "or when `data_atualizacao_pncp` changes". */
  tenderHeader: 6 * HOUR,
  /** Items. Per-item `tipoBeneficioNome` is what defines ME/EPP. */
  tenderItems: 12 * HOUR,
  /** File list. An amendment adds a file, which invalidates text and screening. */
  tenderFiles: 12 * HOUR,
  /** Company (CNPJ → CNAEs, size, MEI) from BrasilAPI. */
  company: 30 * DAY,
  /**
   * A company row that exists but has no CNAEs — BrasilAPI was down or said
   * "not found". §3.2 does not name it, because §3.2 describes the happy path;
   * a failed lookup is not a 30-day fact. Mirrors
   * `licitaqui.company.FALLBACK_TTL`, which is the value the worker will honour
   * when the job runs, so a shorter one here would only enqueue jobs that
   * decline to do anything.
   */
  companyUnresolved: 6 * HOUR,
  /** Award per item: permanent once awarded. */
  award: PERMANENT,
  /** AI screening and deep analysis: permanent per version triple. */
  aiAnalysis: PERMANENT,
  /** Market price (Pro, phase 2). */
  marketPrice: 7 * DAY,
} as const satisfies Record<string, Ttl>

export type CacheState = 'fresh' | 'stale' | 'absent'

/** What a `read` gives `readOrEnqueue`: the row, and when it was written. */
export type CacheRead<T> = {
  data: T
  /** `updated_at`. `null` is treated as "written at an unknown time" — stale. */
  updatedAt: Date | null
  /**
   * Overrides the TTL for this row alone. A closed tender is `PERMANENT`
   * however old its `updated_at` is (§3.2), and a company with no CNAEs gets
   * the shorter `companyUnresolved` window.
   */
  ttl?: Ttl
}

export type Cached<T> = {
  state: CacheState
  /** `null` only when `state` is `absent`. */
  data: T | null
  updatedAt: Date | null
  /** Age in whole seconds, for "atualizado há X min". `null` when absent. */
  ageSeconds: number | null
  /** The refresh that was queued, or `null` when none was needed. */
  job: EnqueuedJob | null
  /** 200 for `fresh` and `stale`, 202 for `absent` — §3.1, step 4. */
  status: 200 | 202
}

export type ReadOrEnqueueOptions<T> = {
  /** Reads the cache. Returns `null` when the row is not there at all. */
  read: (executor: Executor) => Promise<CacheRead<T> | null>
  /** The default TTL, overridable per row by `CacheRead.ttl`. */
  ttl: Ttl
  /** The job to queue when the row is stale or absent. */
  refresh: Omit<JobRequest, 'priority'>
  /** Defaults to the pool. */
  executor?: Executor
  /** Injected by the tests, which must be able to age a row by hours. */
  now?: Date
  /**
   * Set when nothing may be enqueued for this read — a keyword-only search
   * that has no entity behind it, or a request we have already decided not to
   * spend a worker cycle on. The state is still reported honestly.
   */
  enqueue?: boolean
  /**
   * Whether `absent` may enqueue. Default `true`, which is §3.1 step 4.
   *
   * `false` is for an entity the worker cannot conjure from its key alone. A
   * tender header only ever arrives through the sweep, so a request for an id
   * we hold no row for would queue a `sync_items` that logs "unknown tender"
   * and stops — four times, at priority 1, ahead of jobs somebody is waiting
   * on. An unguessable key protects nothing here: PNCP ids are public and
   * well-formed ones are trivial to generate.
   */
  enqueueWhenAbsent?: boolean
}

export async function readOrEnqueue<T>(options: ReadOrEnqueueOptions<T>): Promise<Cached<T>> {
  const executor = options.executor ?? db()
  const now = options.now ?? new Date()
  const mayEnqueue = options.enqueue ?? true

  const found = await options.read(executor)

  if (!found) {
    // §3.1 step 4: nothing to show, so the job is what the user is waiting on.
    const job =
      mayEnqueue && (options.enqueueWhenAbsent ?? true)
        ? await enqueueJob({ ...options.refresh, priority: PRIORITY_USER_WAITING }, executor)
        : null
    return { state: 'absent', data: null, updatedAt: null, ageSeconds: null, job, status: 202 }
  }

  const ttl = found.ttl === undefined ? options.ttl : found.ttl
  const updatedAt = found.updatedAt
  const ageSeconds =
    updatedAt === null ? null : Math.max(0, Math.floor((now.getTime() - updatedAt.getTime()) / SECOND))

  // Permanent data is never stale, whatever its age. An unknown `updated_at` is
  // the opposite: we cannot claim it is fresh, so we serve it and refresh it.
  const fresh =
    ttl === PERMANENT || (updatedAt !== null && updatedAt.getTime() + ttl > now.getTime())

  if (fresh) {
    return { state: 'fresh', data: found.data, updatedAt, ageSeconds, job: null, status: 200 }
  }

  // §3.1 step 3: respond with what we have, and queue the refresh behind it.
  const job = mayEnqueue
    ? await enqueueJob({ ...options.refresh, priority: PRIORITY_REFRESH }, executor)
    : null
  return { state: 'stale', data: found.data, updatedAt, ageSeconds, job, status: 200 }
}

/**
 * `Cache-Control` for a Radar response. §3.3: user data is dynamic and must
 * never sit in a CDN, because the next visitor would be served the previous
 * one's company.
 */
export const PRIVATE_NO_STORE = 'private, no-store'
