import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'

/**
 * The Neon Free usage card (spec §5.1, plan gap G14):
 *
 * > `/admin` shows storage used and CU-hours this month, with an alert at 80%
 * > of each limit.
 *
 * ## What is real here, and what is not
 *
 * Exactly one of the three numbers can be read from inside the database:
 * `pg_database_size()`, the logical size of this database right now. It is
 * **not** the figure Neon bills. Neon's storage metric covers the whole
 * project — every branch, plus the history it keeps for point-in-time restore —
 * and only Neon's own API reports it. The same is true of compute: CU-hours are
 * metered by the control plane and are invisible from SQL; `pg_stat_database`
 * knows how long sessions lasted since the last stats reset, which is not the
 * same thing and would be a lie dressed as a measurement.
 *
 * So the card shows the real number as itself, and the two it cannot see as an
 * explicit "not configured", naming the variables that would enable them. No
 * estimate, no extrapolation, no plausible-looking figure. A wrong number on
 * this card is worse than a missing one: the whole point of it is to notice
 * before Neon stops the database.
 *
 * Wiring it up later is `NEON_API_KEY` + `NEON_PROJECT_ID` and a fetch of the
 * consumption endpoint from a background job — never from a web request (§3).
 */

/** Neon API credentials. Neither is configured today; both are needed. */
export const NEON_API_KEY_VAR = 'NEON_API_KEY'
export const NEON_PROJECT_ID_VAR = 'NEON_PROJECT_ID'

/**
 * Free plan limits (spec §5.1: "0.5 GB storage and 100 CU-hours per project").
 *
 * 0.5 GB is read as 500 MB decimal rather than 512 MiB: it is the smaller of
 * the two possible readings, so the 80% alert fires no later than Neon's own
 * would. Better a week early than a day late.
 */
export const FREE_STORAGE_BYTES = 500_000_000
export const FREE_COMPUTE_HOURS = 100

/** Spec §5.1: "with an alert at 80% of each limit". */
export const ALERT_AT = 0.8

export type Measured = {
  state: 'measured'
  /** The value, in the unit of its limit. */
  value: number
  limit: number
  /** `value / limit`, unclamped: over 100% must look like over 100%. */
  ratio: number
  /** `ratio >= 0.8`. */
  alert: boolean
}

export type NotConfigured = {
  state: 'not_configured'
  limit: number
  /** The environment variables that would turn this into a number. */
  missing: readonly string[]
}

export type Unavailable = {
  state: 'unavailable'
  limit: number
  /** A short code, never a connection string or a driver message. */
  reason: string
}

export type UsageMetric = Measured | NotConfigured | Unavailable

export type NeonUsage = {
  /** Real: `pg_database_size(current_database())`, this database only. */
  databaseSize: UsageMetric
  /** Neon's billed storage for the whole project. Needs the Neon API. */
  projectStorage: UsageMetric
  /** CU-hours this month. Needs the Neon API. */
  computeHours: UsageMetric
}

function measured(value: number, limit: number): Measured {
  const ratio = limit > 0 ? value / limit : 0
  return { state: 'measured', value, limit, ratio, alert: ratio >= ALERT_AT }
}

const NEON_API_MISSING = [NEON_API_KEY_VAR, NEON_PROJECT_ID_VAR] as const

/** True once both Neon API variables are set — nothing here reads their values. */
export function neonApiConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env[NEON_API_KEY_VAR]?.trim() && env[NEON_PROJECT_ID_VAR]?.trim())
}

/** The logical size of this database, in bytes. The one honest number on the card. */
export async function databaseSizeBytes(database: Executor = db()): Promise<number> {
  const { rows } = await database.execute<{ bytes: string }>(
    sql`select pg_database_size(current_database())::text as bytes`,
  )
  return Number(rows[0]?.bytes ?? 0)
}

export async function readNeonUsage(database: Executor = db()): Promise<NeonUsage> {
  let size: UsageMetric
  try {
    size = measured(await databaseSizeBytes(database), FREE_STORAGE_BYTES)
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'unknown'
    size = { state: 'unavailable', limit: FREE_STORAGE_BYTES, reason: code }
  }

  // Deliberately not fetched even when the variables exist: §3 forbids an
  // external call inside a web request. When the key arrives, a job writes the
  // consumption figures somewhere this function reads.
  const pending: NotConfigured = {
    state: 'not_configured',
    limit: FREE_STORAGE_BYTES,
    missing: NEON_API_MISSING,
  }

  return {
    databaseSize: size,
    projectStorage: pending,
    computeHours: { ...pending, limit: FREE_COMPUTE_HOURS },
  }
}

/** `412,5 MB` — pt-BR, decimal units, matching how the limit is read above. */
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

/** `62%`. Rounded to a whole number: the card is a warning light, not a gauge. */
export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100).toLocaleString('pt-BR')}%`
}
