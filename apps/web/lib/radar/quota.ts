import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'
import type { QuotaView } from './contract'

/**
 * Quotas: `plan_limits` says what the plan allows, `usage` says what has been
 * spent (spec §6.2, §8, §10).
 *
 * > **Quota checks:** always server-side, in a transaction (`usage` in the
 * > period + `plan_limits`).
 *
 * Four rules the rest of the code must not re-invent:
 *
 *  - **`quantity is null` means unlimited**, not zero and not "unset". A plan
 *    with no row at all for a feature means the feature is *not included*,
 *    which is a different answer and yields a limit of 0.
 *  - **The period is part of the limit.** `total` counts every row ever;
 *    `month` counts the current calendar month in Brasília, `week` the current
 *    Monday-to-Sunday one. Counting in UTC would reset a Brazilian user's month
 *    three hours early, which is the same class of mistake as reading PNCP's
 *    naive timestamps as UTC.
 *  - **The check and the write are one statement.** `spend()` inserts the
 *    `usage` row with the count in its `where`, so two requests racing on the
 *    last screening cannot both see "1 left".
 *  - **The allowance is per spender, not per CNPJ.** §17's decision 5 scopes
 *    "per device *and* per CNPJ" to the visitor's **3 days** and to nothing
 *    else, and the terms say the same ("Uso por até 3 dias, contado por
 *    aparelho e por CNPJ; …; 2 triagens por IA"). So the window is what an
 *    incognito session cannot reset (`visitor.windowStartedAt`); the two
 *    screenings are counted per device. U1 tried widening this to the CNPJ and
 *    put it back: it is a commercial call, not an engineering one, and it is
 *    written up on the U1 PR.
 */

/** §10's features, as `plan_limits.feature` spells them. */
export const FEATURES = {
  screening: 'screening',
  deepAnalysis: 'deep_analysis',
  /**
   * How many alert messages a plan includes per period. Read by the menu's
   * plan strip; `plan_limits` has carried the row since 0002 and nothing in
   * the web had ever asked for it, which is part of why `/fundadores` could
   * advertise a cadence no plan entitles (card D6).
   */
  alert: 'alert',
  /** Not a quota: the number of days the visitor window lasts. */
  days: 'days',
} as const

export type Feature = (typeof FEATURES)[keyof typeof FEATURES]

/** Who is spending. Exactly one of the two is set. */
export type Spender = { userId: number; visitorId?: undefined } | { visitorId: string; userId?: undefined }

export type Limit = {
  plan: string
  feature: string
  period: string | null
  /** `null` is unlimited; `0` is "the plan does not include this". */
  quantity: number | null
}

/** Brasília, so a month rolls over at midnight where the users are. */
const BRT = 'America/Sao_Paulo'

/**
 * The `usage.created_at` predicate for a period. `total` has none.
 *
 * `date_trunc` at a named zone is the whole trick: `at time zone 'America/Sao_Paulo'`
 * converts the timestamptz to Brasília wall-clock, truncates there, and the
 * second `at time zone` puts the boundary back on the absolute timeline.
 */
export function periodStart(period: string | null) {
  if (period === 'month') {
    return sql`date_trunc('month', now() at time zone ${BRT}) at time zone ${BRT}`
  }
  if (period === 'week') {
    return sql`date_trunc('week', now() at time zone ${BRT}) at time zone ${BRT}`
  }
  return null
}

export async function readLimit(
  plan: string,
  feature: Feature,
  database: Executor = db(),
): Promise<Limit> {
  const found = await database.execute<{ period: string | null; quantity: number | null }>(sql`
    select period, quantity from plan_limits where plan = ${plan} and feature = ${feature}
  `)
  const row = found.rows[0]
  // No row: the plan does not include the feature. Not "unlimited".
  if (!row) return { plan, feature, period: null, quantity: 0 }
  return {
    plan,
    feature,
    period: row.period,
    quantity: row.quantity === null ? null : Number(row.quantity),
  }
}

/**
 * Exported so a caller that needs "has this spender paid for X?" *alongside*
 * another fact can ask both in one statement rather than two round trips —
 * `screeningAvailability` does, on a route Neon may have to wake up for.
 */
export function spenderPredicate(spender: Spender) {
  return spender.userId !== undefined
    ? sql`user_id = ${spender.userId}::bigint`
    : sql`visitor_id = ${spender.visitorId}::uuid`
}

export async function countUsage(
  spender: Spender,
  limit: Limit,
  database: Executor = db(),
): Promise<number> {
  const since = periodStart(limit.period)
  const found = await database.execute<{ used: string | number }>(sql`
    select count(*) as used
      from usage
     where ${spenderPredicate(spender)}
       and feature = ${limit.feature}
       ${since ? sql`and created_at >= ${since}` : sql``}
  `)
  return Number(found.rows[0]?.used ?? 0)
}

export function quotaView(limit: Limit, used: number): QuotaView {
  return {
    feature: limit.feature,
    plan: limit.plan,
    period: limit.period,
    limit: limit.quantity,
    used,
    left: limit.quantity === null ? null : Math.max(0, limit.quantity - used),
  }
}

/**
 * Has this spender already paid for `reference` in the current period?
 *
 * The read side of `spend()`'s "the same tender twice is free" rule, for the
 * poll route: `GET /api/tenders/:id/screening` may hand back an analysis only
 * to someone who has already spent a screening on that tender. Without it the
 * `GET` would be a way to read every cached analysis in the database for free,
 * which is the whole of §10 undone by the endpoint that was meant to save the
 * `POST` from being polled twenty times a minute.
 */
export async function hasSpentOn(
  spender: Spender,
  limit: Limit,
  reference: string,
  database: Executor = db(),
): Promise<boolean> {
  const since = periodStart(limit.period)
  const found = await database.execute<{ n: string | number }>(sql`
    select count(*) as n
      from usage
     where ${spenderPredicate(spender)}
       and feature = ${limit.feature}
       and reference = ${reference}
       ${since ? sql`and created_at >= ${since}` : sql``}
  `)
  return Number(found.rows[0]?.n ?? 0) > 0
}

export type SpendOutcome = { allowed: boolean; quota: QuotaView; charged: boolean }

/**
 * Charge one unit of `feature` against `reference`, or refuse.
 *
 * `reference` is the tender id, and a second request for the **same** tender
 * does not charge again: the screening it asks for is cached and shared (§3.2),
 * so making a user pay twice for one answer would turn a poll — which §3.1 tells
 * the client to do every 3 s — into a way to burn their five monthly
 * screenings in fifteen seconds. `charged` says which happened.
 *
 * The insert's `where` re-counts inside the same statement, so the limit holds
 * under concurrency without a second round trip or a table lock.
 */
export async function spend(
  spender: Spender,
  limit: Limit,
  reference: string,
  database: Executor = db(),
): Promise<SpendOutcome> {
  const who = spenderPredicate(spender)
  const since = periodStart(limit.period)
  const inPeriod = since ? sql`and u.created_at >= ${since}` : sql``
  const unlimited = limit.quantity === null

  const result = await database.execute<{ charged: boolean; repeat: boolean; used: string | number }>(sql`
    with already as (
      select count(*) as n
        from usage u
       where ${who} and u.feature = ${limit.feature} and u.reference = ${reference} ${inPeriod}
    ),
    spent as (
      select count(*) as n
        from usage u
       where ${who} and u.feature = ${limit.feature} ${inPeriod}
    ),
    charged as (
      insert into usage (user_id, visitor_id, feature, reference)
      select ${spender.userId ?? null}::bigint, ${spender.visitorId ?? null}::uuid,
             ${limit.feature}::text, ${reference}::text
        from already a, spent s
       where a.n = 0
         and (${unlimited}::boolean or s.n < ${limit.quantity ?? 0}::int)
      returning 1
    )
    select exists (select 1 from charged) as charged,
           (select n from already) > 0 as repeat,
           (select n from spent) + (case when exists (select 1 from charged) then 1 else 0 end) as used
  `)

  const row = result.rows[0]
  const charged = Boolean(row?.charged)
  // The same tender asked for twice. Already paid for, so it is allowed and
  // free — this is what keeps §3.1's 3-second poll from spending a quota.
  const repeat = Boolean(row?.repeat)
  const used = Number(row?.used ?? 0)
  return { allowed: charged || repeat, quota: quotaView(limit, used), charged }
}
