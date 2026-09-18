import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'
import { enqueueJob, JOB_KINDS, PRIORITY_USER_WAITING, screeningJobKey, type EnqueuedJob } from '@/lib/jobs'
import type { ScreeningOk, QuotaView } from './contract'
import { FEATURES, readLimit, spend, type Spender } from './quota'

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

export async function readScreening(
  tenderId: string,
  database: Executor = db(),
): Promise<CachedAnalysis | null> {
  const found = await database.execute<AnalysisRow>(sql`
    select status, result, citation_check, rules, created_at
      from ai_analyses
     where tender_id = ${tenderId}
       and mode = ${SCREENING_MODE}
       and status = any(${sql.raw(`array[${USABLE.map((s) => `'${s}'`).join(',')}]::text[]`)})
     order by extraction_version desc nulls last, created_at desc
     limit 1
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
