import { sql } from 'drizzle-orm'
import { cnpjRef } from '@/lib/cnpj'
import { db, type Executor } from '@/lib/db'

/**
 * Writing a row into `jobs` from the web (spec §6.3, §7.3).
 *
 * The queue is the seam between the two halves of the product: the worker
 * fetches PNCP, BrasilAPI and the AI, and a Next.js route never does (§3's
 * golden rule). A route that finds the cache empty or stale therefore has
 * exactly one thing it may do about it — add a row here — and this module is
 * the only place that knows how.
 *
 * ## Why this is not an import from `worker/`
 *
 * It cannot be: one is Python on EC2, the other TypeScript on Vercel. So the
 * statement below is `licitaqui.queue.ENQUEUE_SQL` written out again, and the
 * key builders are `company.job_key` / `ai_screening.job_key` written out
 * again. Both sides are pinned by the same partial unique index —
 * `jobs_dedupe on jobs (kind, key) where status in ('queued','running')` — so a
 * key that drifts does not fail loudly; it quietly puts two live jobs on the
 * queue for one CNPJ. That is why each builder below names the Python function
 * it mirrors, and why `cnpjRef()` documents the digest it must reproduce.
 *
 * ## De-duplication is not an error
 *
 * `on conflict … do nothing` means the insert returns no row when a job for
 * this `(kind, key)` is already queued or running. That is the index doing its
 * job: the caller gets `deduped: true` and the existing job stays. Nothing
 * retries, nothing raises.
 *
 * ## Logging
 *
 * A job key may be derived from a CNPJ but never contains one (§12), which is
 * the whole point of `cnpjRef`. Tender ids are public PNCP identifiers and are
 * safe to log.
 */

/**
 * The job kinds the web may create. Each one has a handler in the worker —
 * enqueuing a kind nothing can run fills the queue with rows that fail four
 * times over forty minutes and land in `failed` (the worker makes the same
 * check before enqueuing its own follow-ups).
 */
export const JOB_KINDS = {
  /** BrasilAPI → CNAEs → segments. `licitaqui/company.py`. */
  companyLookup: 'company_lookup',
  /** Items + segments + the ME/EPP roll-up for one tender. `licitaqui/sync_items.py`. */
  syncItems: 'sync_items',
  /** The lite AI screening of one tender. `licitaqui/ai_screening.py`. */
  aiScreening: 'ai_screening',
  /**
   * One outbound Telegram message. `licitaqui/telegram_alerts.py`.
   *
   * The only kind the web enqueues that is not a cache refresh: it is how
   * `POST /api/telegram/webhook` answers a `/start` without calling the Bot
   * API from a request (§3). The payload is `{template, user_id | chat_id}`
   * and the key is `reply:<update_id>`, so Telegram redelivering an update
   * dedupes instead of greeting somebody twice.
   */
  sendTelegram: 'send_telegram',
} as const

export type JobKind = (typeof JOB_KINDS)[keyof typeof JOB_KINDS]

/**
 * Priority 1 is reserved for "a user is on screen waiting" (§7.3) — the
 * `absent` branch of `readOrEnqueue`, where the screen has nothing to show.
 */
export const PRIORITY_USER_WAITING = 1
/**
 * A background refresh behind data we have already served. It must not jump the
 * queue ahead of another user's blank screen, so it sits with the syncs at 5.
 */
export const PRIORITY_REFRESH = 5

/** Mirrors `licitaqui.company.job_key`: `company:` + `sha256(cnpj)[:16]`. */
export function companyJobKey(cnpj: string): string {
  return `company:${cnpjRef(cnpj)}`
}

/** Mirrors `licitaqui.ai_screening.job_key`: one live screening per tender. */
export function screeningJobKey(tenderId: string): string {
  return `screening:${tenderId}`
}

/**
 * Mirrors the follow-up key `licitaqui.sync_tenders._enqueue_followups` uses:
 * the bare tender id, which `sync_items` also reads as its default payload.
 */
export function syncItemsJobKey(tenderId: string): string {
  return tenderId
}

export type JobRequest = {
  kind: JobKind
  key: string
  priority?: number
  payload?: Record<string, unknown>
}

export type EnqueuedJob = {
  kind: JobKind
  key: string
  /** The new row's id, or `null` when an identical job was already live. */
  id: number | null
  /** Whether the dedupe index rejected the insert. Not a failure. */
  deduped: boolean
}

/**
 * Add a job unless one with the same `(kind, key)` is already queued or
 * running. Runs on the pool, or inside the transaction you hand it.
 */
export async function enqueueJob(
  request: JobRequest,
  database: Executor = db(),
): Promise<EnqueuedJob> {
  const { kind, key, priority = PRIORITY_REFRESH, payload } = request
  const result = await database.execute<{ id: string | number }>(sql`
    insert into jobs (kind, key, priority, payload)
    values (${kind}::text, ${key}::text, ${priority}::int,
            ${payload === undefined ? null : JSON.stringify(payload)}::jsonb)
    -- The dedupe index is partial, so ON CONFLICT has to name its predicate
    -- for Postgres to infer it: one live job per (kind, key).
    on conflict (kind, key) where status in ('queued','running') do nothing
    returning id
  `)
  const row = result.rows[0]
  return { kind, key, id: row ? Number(row.id) : null, deduped: !row }
}

/** What `GET /api/jobs/:id` may say about a job. Nothing else is exposed. */
export type JobStatus = 'queued' | 'running' | 'done' | 'failed'

export type JobView = {
  id: number
  kind: JobKind
  status: JobStatus
  /** Attempts made so far; 4 is the budget (§7.2). */
  attempts: number
  createdAt: string
  updatedAt: string
}

/**
 * One job, for the client polling after a `202` (§3.1: "polls every 3 s, max
 * 60 s"). Returns `null` for an unknown id **and** for a kind the web never
 * creates, so the route cannot be turned into a window onto the worker's
 * internal queue.
 *
 * Deliberately absent from the projection: `payload`, `key` and `error`. The
 * payload carries the CNPJ that a `company_lookup` was asked about and the
 * error carries whatever an upstream service said, which is the last text in
 * the system that should be handed to an unauthenticated poller (§12).
 */
export async function readJob(id: number, database: Executor = db()): Promise<JobView | null> {
  const kinds = Object.values(JOB_KINDS)
  const result = await database.execute<{
    id: string | number
    kind: JobKind
    status: JobStatus
    attempts: number
    created_at: Date | string
    updated_at: Date | string
  }>(sql`
    select id, kind, status, attempts, created_at, updated_at
      from jobs
     where id = ${id}::bigint
       and kind = any(${sql.raw(`array[${kinds.map((k) => `'${k}'`).join(',')}]::text[]`)})
  `)
  const row = result.rows[0]
  if (!row) return null
  return {
    id: Number(row.id),
    kind: row.kind,
    status: row.status,
    attempts: Number(row.attempts),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }
}
