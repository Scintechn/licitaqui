import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'
import { enqueueJob, JOB_KINDS, PRIORITY_USER_WAITING, screeningJobKey, type EnqueuedJob } from '@/lib/jobs'
import type { ScreeningAvailability, ScreeningOk, QuotaView } from './contract'
import {
  FEATURES,
  periodStart,
  readLimit,
  spend,
  spenderPredicate,
  type Limit,
  type Spender,
} from './quota'

/**
 * `POST /api/tenders/:id/screening` — the triagem (spec §8, §3.2).
 *
 * > Checks quota → if an analysis for the current version exists, returns it
 * > and records usage; otherwise priority-1 job → 202.
 *
 * ## "The current version"
 *
 * An `ai_analyses` row is keyed by `(tender_id, mode, prompt_version,
 * extraction_version, files_hash)` and is kept for ever (§3.2): a new prompt or
 * a republished edital produces a **new row**, never an overwrite. Which of
 * those rows is current is therefore a fact only the worker holds — the prompt
 * version lives in `licitaqui/prompts.py` and the web cannot import it.
 *
 * So "current" is read as **the newest usable row for this tender and mode**.
 * That is right whenever versions only move forward, which is the only
 * direction they move: a bumped prompt makes the new row the newest, and the
 * old one keeps serving nobody. It would be wrong only if someone rolled a
 * prompt version back without deleting the newer rows, and the honest fix for
 * that day is a `prompt_version` the two sides share — noted on the PR.
 *
 * ## …except for `files_hash`, which does not only move forward
 *
 * `files_hash` is the one part of the key that can go backwards, and it is the
 * one that matters most: spec §3.2 says an amendment *invalidates* the
 * screening. The worker (`licitaqui.files.files_hash`) digests the tender's
 * active document list, so when PNCP publishes an errata the digest moves and
 * every analysis of the old documents stops being this tender's answer — while
 * staying on its row, because §3.2 also keeps AI results for ever and a cached
 * `ok` is never overwritten.
 *
 * "Newest usable row" cannot see that: right after an amendment the newest row
 * is precisely the superseded one, so it would be served as `ready` and no job
 * would ever be queued. A company would read an analysis of an edital that no
 * longer exists. So the read is narrowed to rows keyed on the **current** list.
 *
 * Which digest is current is, again, a fact only the worker can compute — the
 * recipe (`MANIFEST_VERSION`, tab-separated fields, UTC ISO-8601) lives in
 * `licitaqui/files.py`, and a second implementation of it here would have to
 * agree byte for byte for ever; the day the two disagreed, every screening
 * would miss its cache and be paid for again. So this reads the digest the
 * worker itself published: `sync_files` writes it to the `events` marker
 * `sync_files:<tender_id>` in the same job that writes `tender_files`, which
 * makes `tender_files` the single source of truth and the marker its copy.
 *
 * **No marker means no filter.** A tender whose list has never been synced
 * (seed data, a tender the collector has not reached) reads exactly as it did
 * before — newest usable row. The filter can therefore only ever hide a row
 * that is genuinely superseded; it cannot make a tender un-analysable.
 *
 * The honest fix is for the worker to expose the current digest as a column or
 * an endpoint rather than through a marker row — noted on the PR.
 *
 * `status in ('ok','no_text')` is the "usable" part. `no_text` is a scanned PDF
 * (§7.2) — a real, permanent answer meaning "there is nothing to read here",
 * not a failure to retry. A `failed` or abandoned `running` row is neither an
 * answer nor a reason to refuse, so it is skipped and a fresh job is queued.
 *
 * ## The quota is spent before the job, and only once per tender
 *
 * The check and the `usage` row are one statement (`quota.spend`), so two
 * requests racing on a visitor's second and last screening cannot both win.
 * Asking for the **same** tender again is free: §3.1 tells the client to poll
 * every 3 s, and a poll that cost a screening would spend a Básico user's whole
 * month in fifteen seconds.
 */

export const SCREENING_MODE = 'lite'

/** Rows the worker considers a finished answer. `failed` is not one. */
const USABLE = ['ok', 'no_text'] as const

export type CachedAnalysis = {
  status: 'ok' | 'no_text'
  result: unknown
  citationCheck: unknown
  rules: unknown
  createdAt: Date
}

type AnalysisRow = {
  status: 'ok' | 'no_text'
  result: unknown
  citation_check: unknown
  rules: unknown
  created_at: Date | string
}

/**
 * Mirrors `licitaqui.files.sync_event_name`: the per-tender marker `sync_files`
 * rewrites on every run, whose `props.files_hash` is the digest of the list as
 * that job left it. Keep the two spellings in step.
 */
function syncMarkerName(tenderId: string) {
  return `sync_files:${tenderId}`
}

/**
 * **Which row is this tender's current analysis** — the whole rule above, in
 * one place, because it is the definition of "we have read this edital" and a
 * second copy of it would be a second definition.
 *
 * The `coalesce` is the "no marker means no filter" rule: with a marker the
 * row's `files_hash` must equal it, without one the row is compared to itself
 * and every usable row stays eligible. `is not distinct from` so that a row
 * written with no hash at all is excluded once a real digest is known, instead
 * of vanishing into a NULL comparison.
 */
function currentAnalysis(tenderId: string) {
  return sql`
      from ai_analyses a
     where a.tender_id = ${tenderId}
       and a.mode = ${SCREENING_MODE}
       and a.status = any(${sql.raw(`array[${USABLE.map((s) => `'${s}'`).join(',')}]::text[]`)})
       and a.files_hash is not distinct from coalesce(
             (select e.props->>'files_hash'
                from events e
               where e.name = ${syncMarkerName(tenderId)}
               order by e.created_at desc
               limit 1),
             a.files_hash)
     order by extraction_version desc nulls last, created_at desc
     limit 1
  `
}

export async function readScreening(
  tenderId: string,
  database: Executor = db(),
): Promise<CachedAnalysis | null> {
  const found = await database.execute<AnalysisRow>(sql`
    select status, result, citation_check, rules, created_at
    ${currentAnalysis(tenderId)}
  `)
  const row = found.rows[0]
  if (!row) return null
  return {
    status: row.status,
    result: row.result,
    citationCheck: row.citation_check,
    rules: row.rules,
    createdAt: new Date(row.created_at),
  }
}

/**
 * What the Opportunity screen has to know before it can name its own button.
 *
 * Sci, on production: *"I already have the AI Triage for this item … but the
 * button remains like the first time."* It did, because nothing in the tender
 * payload knew anything about screenings — `opportunity-view.tsx` rendered one
 * fixed string — so "Ver triagem por IA" was shown to someone who had already
 * read it, and to someone about to spend one of two, in the same words.
 *
 * Two facts, and deliberately not one:
 *
 * | | |
 * |---|---|
 * | `ready` | a reading **of the edital as it stands now** exists. Shared across users (§3.2) — there is no `user_id` on `ai_analyses` — so this is a fact about the tender, not about the caller |
 * | `spent` | **this** caller already has a `usage` row for this tender, so opening it costs nothing (`quota.spend` de-duplicates on the reference) |
 *
 * They come apart in both directions and the button has to tell them apart. A
 * reading can exist that this user has not paid for: §3.2 shares the analysis,
 * §10 allocates the *reading* per user, and `requestScreening` spends **before**
 * it looks in the cache — deliberately, and documented on the route: "if an
 * analysis for the current version exists, returns it and records usage". And a
 * user can have paid with no reading to show for it: the job is still running,
 * or the agency republished the edital and `files_hash` moved, which is exactly
 * the case `ready` must answer `false` to. Nothing new decides that — it is
 * `currentAnalysis`, the same predicate `readScreening` hands the triagem
 * screen, so the button can never promise something the next screen will not do.
 *
 * One statement, because this rides on `GET /api/tenders/:id` and Neon may have
 * to wake up for it.
 */
// The shape lives in `contract.ts` — it crosses the wire. It was declared a
// second time here and the two drifted the moment a field was added to one:
// `metered` existed on the contract and not on this copy, so the route could
// not return what this function produced. Re-exported rather than redeclared.
export type { ScreeningAvailability } from './contract'

export async function screeningAvailability(
  tenderId: string,
  spender: Spender | null,
  limit: Limit,
  database: Executor = db(),
): Promise<ScreeningAvailability> {
  const since = spender ? periodStart(limit.period) : null
  const found = await database.execute<{ ready: boolean; spent: boolean }>(sql`
    select
      exists (select 1 ${currentAnalysis(tenderId)}) as ready,
      ${
        spender
          ? sql`exists (
              select 1
                from usage u
               where ${spenderPredicate(spender)}
                 and u.feature = ${limit.feature}
                 and u.reference = ${tenderId}
                 ${since ? sql`and u.created_at >= ${since}` : sql``}
            )`
          : sql`false`
      } as spent
  `)
  const row = found.rows[0]
  return {
    ready: Boolean(row?.ready),
    spent: Boolean(row?.spent),
    // `plan_limits.quantity` is null for the paid plans. Without this the
    // screen tells a founder who just bought "Triagens de edital sem limite"
    // that each one uses up an allowance.
    metered: limit.quantity !== null,
  }
}

export type ScreeningOutcome =
  | { state: 'ready'; body: Omit<ScreeningOk, 'state'> }
  | { state: 'analyzing'; job: EnqueuedJob; quota: QuotaView }
  | { state: 'quota_exceeded'; quota: QuotaView }

export async function requestScreening(
  tenderId: string,
  spender: Spender,
  plan: string,
  database: Executor = db(),
): Promise<ScreeningOutcome> {
  const limit = await readLimit(plan, FEATURES.screening, database)
  const outcome = await spend(spender, limit, tenderId, database)
  if (!outcome.allowed) {
    return { state: 'quota_exceeded', quota: outcome.quota }
  }

  const cached = await readScreening(tenderId, database)
  if (cached) {
    return {
      state: 'ready',
      body: {
        tenderId,
        status: cached.status,
        result: cached.result,
        citationCheck: cached.citationCheck,
        rules: cached.rules,
        createdAt: cached.createdAt.toISOString(),
        quota: outcome.quota,
      },
    }
  }

  // §3.1 step 4 and §7.3: priority 1, because someone is watching a spinner.
  const job = await enqueueJob(
    {
      kind: JOB_KINDS.aiScreening,
      key: screeningJobKey(tenderId),
      priority: PRIORITY_USER_WAITING,
      payload: { tender_id: tenderId },
    },
    database,
  )
  return { state: 'analyzing', job, quota: outcome.quota }
}
