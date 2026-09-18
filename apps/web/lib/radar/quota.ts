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
 * Three rules the rest of the code must not re-invent:
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
 */

/** §10's features, as `plan_limits.feature` spells them. */
export const FEATURES = {
  screening: 'screening',
  deepAnalysis: 'deep_analysis',
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
function periodStart(period: string | null) {
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

function spenderPredicate(spender: Spender) {
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
