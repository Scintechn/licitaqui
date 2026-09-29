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

/**
 * What a person configured, as many keywords as their plan grants.
 *
 * **It was `keyword: string | null` until 2026-09-29** — one, on every plan,
 * while `plan_limits` granted Essencial and Promocional **ten**. So the alert
 * a founder pays for was identical to Básico's, and the plans card promising
 * *"10 palavras-chave"* described something the product could not do. Sci
 * found it on his own account (**E18**); no test compared the two, which is
 * card **F6**.
 */
export type Preferences = { states: string[]; keywords: string[] }

/** A UF, uppercased. Anything else is a hand-made POST, not a form. */
const UF_RE = /^[A-Za-z]{2}$/

/**
 * Trim a submission to what the plan allows (§8: always server-side).
 *
 * The screen renders as many keyword fields as the plan grants; this is the
 * same numbers applied to the bytes that actually arrive, so a hand-made POST
 * asking for five states saves one and an eleventh keyword is dropped rather
 * than refused — there is nothing useful to tell the person, and the rest of
 * their submission is perfectly good.
 *
 * **`limits.keywords` is a count, and it used to be read as a boolean.** The
 * old line was `keyword && limits.keywords !== 0 ? keyword : null`: it kept
 * exactly one keyword whether the plan granted 1 or 10, which is the whole of
 * E18. Slicing is the fix, and `null` still means uncapped.
 *
 * Blanks are dropped rather than stored: `websearch_to_tsquery` accepts an
 * empty string happily and would match every open tender in Brazil, and the
 * `alerts_keywords_check` constraint added in `0010` refuses them anyway.
 * Duplicates are dropped too — ten fields, one word typed twice, is nine
 * keywords and a wasted slot.
 */
export function clampPreferences(input: Preferences, limits: AlertLimits): Preferences {
  const seen = new Set<string>()
  for (const raw of input.states) {
    const uf = String(raw).trim().toUpperCase()
    if (UF_RE.test(uf)) seen.add(uf)
  }
  const states = [...seen]

  const seenKeywords = new Set<string>()
  for (const raw of input.keywords) {
    const keyword = String(raw ?? '')
      .trim()
      .slice(0, MAX_KEYWORD_CHARS)
    if (keyword !== '') seenKeywords.add(keyword)
  }
  const keywords = [...seenKeywords]

  return {
    states: limits.states === null ? states : states.slice(0, Math.max(0, limits.states)),
    keywords:
      limits.keywords === null ? keywords : keywords.slice(0, Math.max(0, limits.keywords)),
  }
}

/**
 * Long enough for "material de escritório", short enough that it is a keyword
 * and not a paste. It reaches `websearch_to_tsquery`, which is safe against
 * anything, but an unbounded string in a `text` column is still a column that
 * grows without a reason.
 */
export const MAX_KEYWORD_CHARS = 60

/**
 * How many keyword fields a form should draw, as indices.
 *
 * **The number comes from `plan_limits` and nowhere else.** `alerts-view.tsx`
 * drew exactly one field on every plan, gated only on `limits.keywords === 0`,
 * while the table granted Essencial and Promocional ten — so a paid alert was
 * indistinguishable from the free one, and the plans card promising *"10
 * palavras-chave"* described something the product could not do (**E18**).
 *
 * Exported so a test can compare the count the form offers against the row
 * the plan holds. Nothing did, which is why this survived D6's pass over the
 * very same sentence, and why the general version of that guard is card
 * **F6**.
 *
 * `null` is uncapped and would mean an unbounded form, so it is capped at
 * {@link UNCAPPED_KEYWORD_FIELDS} — a plan with no ceiling still needs a
 * screen that ends.
 */
export const UNCAPPED_KEYWORD_FIELDS = 10

export function keywordFields(limit: number | null): number[] {
  const count = limit === null ? UNCAPPED_KEYWORD_FIELDS : Math.max(0, Math.floor(limit))
  return Array.from({ length: count }, (_unused, index) => index)
}
