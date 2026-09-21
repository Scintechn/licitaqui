import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'

/**
 * What §10 lets this plan have in a Telegram alert, read from `plan_limits`.
 *
 * ## Why not `lib/radar/quota.ts`
 *
 * That module answers a different question: *has this account spent one of its
 * N screenings this month*, which it counts in `usage` and charges for. These
 * three are not spends at all — they are **shapes**: how many keywords a
 * person may configure, how many states, and how many messages a week the
 * digest may send. Nothing is written to `usage`, and the weekly count comes
 * from the worker's own delivery log (`licitaqui/telegram_alerts.py`), because
 * the worker is what sends and a message the worker did not send must not
 * consume a quota.
 *
 * So this reads the same table through its own two-line query rather than
 * widening `FEATURES` with entries nothing charges against.
 *
 * ## Absence
 *
 * `plan_limits` today has `alert`, `keywords` and `states` rows for **basico**
 * and nothing else, because §10 gives the paid plans *daily* alerts, which are
 * the `daily_alerts` job and not this feature. A missing row therefore means
 * "§10 grants this plan more, and nobody has written down how much" — not
 * zero. `lib/radar/quota.ts` reads a missing row as zero and is right to, for a
 * feature that costs money; reading it as zero here would take the weekly
 * digest away from every founder on `promocional` during opening week.
 *
 * The worker reaches the same conclusion in `telegram_alerts.alert_limit`, and
 * logs when it does, so the missing rows stay visible until a migration adds
 * them.
 */

export type AlertLimits = {
  /** Messages per week. `null` is uncapped — see the docblock. */
  perWeek: number | null
  /** Configurable keywords. `null` is uncapped. */
  keywords: number | null
  /** Configurable states. `null` is uncapped. */
  states: number | null
}

/** What Básico gets when `plan_limits` has not been loaded at all. */
export const NO_LIMITS: AlertLimits = { perWeek: null, keywords: null, states: null }

export const FEATURES = { alert: 'alert', keywords: 'keywords', states: 'states' } as const

export async function readAlertLimits(
  plan: string,
  database: Executor = db(),
): Promise<AlertLimits> {
  const found = await database.execute<{ feature: string; quantity: number | null }>(sql`
    select feature, quantity
      from plan_limits
     where plan = ${plan}
       and feature in ('alert', 'keywords', 'states')
  `)
  const byFeature = new Map(found.rows.map((row) => [row.feature, row.quantity]))
  return {
    perWeek: pick(byFeature, FEATURES.alert),
    keywords: pick(byFeature, FEATURES.keywords),
    states: pick(byFeature, FEATURES.states),
  }
}

function pick(rows: Map<string, number | null>, feature: string): number | null {
  if (!rows.has(feature)) return null
  const quantity = rows.get(feature)
  return quantity === null || quantity === undefined ? null : Number(quantity)
}

export type Preferences = { states: string[]; keyword: string | null }

/** A UF, uppercased. Anything else is a hand-made POST, not a form. */
const UF_RE = /^[A-Za-z]{2}$/

/**
 * Trim a submission to what the plan allows (§8: always server-side).
 *
 * The screen renders one keyword field and one state select *because* Básico's
 * rows say one of each. This is the same numbers applied to the bytes that
 * actually arrive, so a hand-made POST asking for five states saves one and a
 * keyword sent by a plan with `keywords: 0` is dropped rather than refused —
 * there is nothing to tell the person, and the rest of their submission is
 * perfectly good.
 */
export function clampPreferences(input: Preferences, limits: AlertLimits): Preferences {
  const seen = new Set<string>()
  for (const raw of input.states) {
    const uf = String(raw).trim().toUpperCase()
    if (UF_RE.test(uf)) seen.add(uf)
  }
  const states = [...seen]

  const keyword = (input.keyword ?? '').trim().slice(0, MAX_KEYWORD_CHARS)

  return {
    states: limits.states === null ? states : states.slice(0, Math.max(0, limits.states)),
    keyword: keyword && limits.keywords !== 0 ? keyword : null,
  }
}

/**
 * Long enough for "material de escritório", short enough that it is a keyword
 * and not a paste. It reaches `websearch_to_tsquery`, which is safe against
 * anything, but an unbounded string in a `text` column is still a column that
 * grows without a reason.
 */
export const MAX_KEYWORD_CHARS = 60
