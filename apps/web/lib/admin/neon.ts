import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'

/**
 * The Neon usage card (spec §5.1, plan gap G14) — card **B27**.
 *
 * ## What this card used to say, and why all of it was wrong
 *
 * It was written against the **Free** plan: `FREE_STORAGE_BYTES = 500_000_000`,
 * `FREE_COMPUTE_HOURS = 100`, and a row per metric reading *value* **de**
 * *limit* · *percent* with an alert at 80%. Spec §5.1 specified exactly that.
 *
 * The project is on **Launch** (confirmed by Sci, 2026-09-30, from the Neon
 * billing page: *"Free limits are removed"*). At 1,69 GB the old card would
 * have rendered **338% and a red alert** on a database in no danger at all —
 * a false alarm on the one screen whose entire purpose is warning before Neon
 * stops the database, and the spec is blunt that a wrong number here is worse
 * than a missing one.
 *
 * **The fix is not a bigger constant.** Launch has no storage ceiling and no
 * CU-hour ceiling; it prices storage per GB-month. Swapping 0.5 GB for some
 * remembered "10 GB" would have hardcoded a second fiction — which is what the
 * first draft of B27 did, and it is the reason this comment exists. A
 * usage-based plan has a **cost**, not a ceiling, so:
 *
 * - a metric with no limit renders as a figure, with **no ratio, no bar and no
 *   alert** — {@link Measured.limit} is nullable and that is load-bearing;
 * - what the card can honestly warn about is **spend**, against the threshold
 *   Sci set himself ($10, 79% of which was used on 2026-09-30). That number
 *   comes from Neon's consumption endpoint, which is a job's work, not a web
 *   request's (§3) — see {@link NeonSpend} and B27's remaining half.
 *
 * ## What is measurable from inside Postgres, and what is not
 *
 * Exactly one figure: `pg_database_size()`, the logical size of this database.
 * It is **not** what Neon bills — Neon's storage metric covers the whole
 * project, every branch plus the history kept for restore — but on a
 * usage-priced plan it is a sound *lower bound* on the storage line, and
 * multiplying it by the published rate is arithmetic rather than estimation.
 * CU-hours are metered by the control plane and are invisible from SQL;
 * `pg_stat_database` knows how long sessions lasted since the last stats reset,
 * which is a different thing and would be a lie dressed as a measurement.
 */

/** Neon API credentials. Both are needed; `neonApiConfigured` says whether they are there. */
export const NEON_API_KEY_VAR = 'NEON_API_KEY'
export const NEON_PROJECT_ID_VAR = 'NEON_PROJECT_ID'

/**
 * Launch's published storage price, in US dollars per GB-month.
 *
 * From the billing page Sci sent on 2026-09-30. `GB` here is Neon's decimal
 * GB, matching {@link formatBytes}. Instant restore is billed separately at
 * $0.20/GB-month and is **not** folded in: this database's logical size says
 * nothing about how much history the project keeps, and inventing that number
 * is the mistake this file is a monument to.
 */
export const LAUNCH_STORAGE_USD_PER_GB_MONTH = 0.35

/** The plan the project is on. Named so the card cannot silently describe another. */
export const PLAN_NAME = 'Launch'

/**
 * Where the spend alert sits, as a fraction of the threshold.
 *
 * Kept from the old card because the *shape* was right — warn before the line,
 * not at it. What changed is what it is a fraction **of**: a spending
 * threshold somebody chose, not a quota somebody imagined.
 */
export const ALERT_AT = 0.8

export type Measured = {
  state: 'measured'
  /** The value, in the unit of its limit. */
  value: number
  /**
   * The ceiling this value is approaching, or `null` when there is none.
   *
   * **Null is the normal case on Launch.** A renderer must not print a
   * percentage, draw a bar, or raise an alert when this is null — there is
   * nothing to be a percentage of.
   */
  limit: number | null
  /** `value / limit`, unclamped so that over 100% looks like over 100%. `null` with no limit. */
  ratio: number | null
  /** `ratio >= ALERT_AT`. Always `false` when there is no limit. */
  alert: boolean
}

export type NotConfigured = {
  state: 'not_configured'
  limit: number | null
  /** The environment variables that would turn this into a number. */
  missing: readonly string[]
}

export type Pending = {
  state: 'pending'
  limit: number | null
  /**
   * Credentials are present and nothing has written the figure yet.
   *
   * A different answer from `not_configured`, and the distinction is the whole
   * point: for days this card said *"not configured"* while `NEON_API_KEY` and
   * `NEON_PROJECT_ID` sat in the environment, because `readNeonUsage` never
   * called its own `neonApiConfigured()`. "Nothing to read yet" and "nobody
   * told me where to read" need different fixes from whoever is looking.
   */
  writtenBy: string
}

export type Unavailable = {
  state: 'unavailable'
  limit: number | null
  /** A short code, never a connection string or a driver message. */
  reason: string
}

export type UsageMetric = Measured | NotConfigured | Pending | Unavailable

export type NeonUsage = {
  /** Real: `pg_database_size(current_database())`, this database only. */
  databaseSize: UsageMetric
  /** What that size costs per month at Launch's published rate. Arithmetic, not an estimate. */
  storageUsdPerMonth: number | null
  /** Neon's billed storage for the whole project. Needs the Neon API. */
  projectStorage: UsageMetric
  /** CU-hours this billing period. Needs the Neon API. */
  computeHours: UsageMetric
  /** The plan the figures above are read against. */
  plan: string
}

/** A measurement with a ceiling — the shape the card can draw a bar for. */
function bounded(value: number, limit: number): Measured {
  const ratio = limit > 0 ? value / limit : 0
  return { state: 'measured', value, limit, ratio, alert: ratio >= ALERT_AT }
}

/** A measurement with no ceiling, which on Launch is most of them. */
function unbounded(value: number): Measured {
  return { state: 'measured', value, limit: null, ratio: null, alert: false }
}

export { bounded as boundedMetric, unbounded as unboundedMetric }

/**
 * The variables that are genuinely absent — not the whole pair.
 *
 * Production on 2026-09-30 had `NEON_PROJECT_ID` set and `NEON_API_KEY` not,
 * and the card told Sci to configure **both**. A screen whose job is telling
 * you what to do must not send you to fix something already done; naming the
 * one that is missing is the difference between a task and a scavenger hunt.
 */
function missingNeonVars(env: Record<string, string | undefined>): readonly string[] {
  return [NEON_API_KEY_VAR, NEON_PROJECT_ID_VAR].filter((name) => !env[name]?.trim())
}

/** True once both Neon API variables are set — nothing here reads their values. */
export function neonApiConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env[NEON_API_KEY_VAR]?.trim() && env[NEON_PROJECT_ID_VAR]?.trim())
}

/** The logical size of this database, in bytes. The one figure Postgres can answer. */
export async function databaseSizeBytes(database: Executor = db()): Promise<number> {
  const { rows } = await database.execute<{ bytes: string }>(
    sql`select pg_database_size(current_database())::text as bytes`,
  )
  return Number(rows[0]?.bytes ?? 0)
}

/** What a number of bytes costs per month at Launch's storage rate. */
export function storageCostUsd(bytes: number): number {
  return (bytes / 1_000_000_000) * LAUNCH_STORAGE_USD_PER_GB_MONTH
}

export async function readNeonUsage(
  database: Executor = db(),
  env: Record<string, string | undefined> = process.env,
): Promise<NeonUsage> {
  let size: UsageMetric
  let cost: number | null = null
  try {
    const bytes = await databaseSizeBytes(database)
    // **No limit.** Launch removes Free's 0.5 GB ceiling, so there is nothing
    // for this to be a percentage of and the card must not invent one.
    size = unbounded(bytes)
    cost = storageCostUsd(bytes)
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'unknown'
    size = { state: 'unavailable', limit: null, reason: code }
  }

  // Still not fetched even when the variables exist: §3 forbids an external
  // call inside a web request. But the card now distinguishes "no credentials"
  // from "credentials present, no job has written the figure" — it spent days
  // saying the first while the second was true.
  const fromApi: UsageMetric = neonApiConfigured(env)
    ? { state: 'pending', limit: null, writtenBy: 'neon_consumption (B27)' }
    : { state: 'not_configured', limit: null, missing: missingNeonVars(env) }

  return {
    databaseSize: size,
    storageUsdPerMonth: cost,
    projectStorage: fromApi,
    computeHours: fromApi,
    plan: PLAN_NAME,
  }
}

/** `412,5 MB` — pt-BR, decimal units, matching how Neon prices a GB. */
export function formatBytes(bytes: number): string {
  const units = ['B', 'kB', 'MB', 'GB', 'TB'] as const
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit += 1
  }
  const decimals = unit === 0 ? 0 : value < 10 ? 2 : 1
  return `${value.toLocaleString('pt-BR', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })} ${units[unit]}`
}

/** `US$ 0,59` — the storage line, in the currency Neon bills in. */
export function formatUsd(value: number): string {
  return `US$ ${value.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

/** `62%`. Rounded to a whole number: the card is a warning light, not a gauge. */
export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100).toLocaleString('pt-BR')}%`
}
