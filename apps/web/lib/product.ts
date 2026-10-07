/**
 * The product's numbers, read from `docs/product.json`.
 *
 * One file, two readers: this one for the web app and `worker/licitaqui/
 * product.py` for the worker. `docs/` rather than `apps/web/` because the
 * worker's templates and the legal documents depend on the same values, and
 * none of them belongs to the web app.
 *
 * **This does not replace the copy catalogue.** `messages/pt-BR.json` still
 * holds every sentence; this holds the numbers those sentences quote, so a
 * change can be made once and *proven* everywhere (`product.test.ts`).
 */

import facts from '../../../docs/product.json'

export type PlanName = 'basico' | 'promocional' | 'essencial' | 'pro'

/** Whole BRL per month, by plan. `promocional` is the first-6-months price. */
export const PLAN_PRICES: Readonly<Record<PlanName, number>> = Object.freeze({
  basico: facts.plans.basico.brl,
  promocional: facts.plans.promocional.brl,
  essencial: facts.plans.essencial.brl,
  pro: facts.plans.pro.brl,
})

/** One `plan_limits` row as `docs/product.json` **states** it. */
export type StatedLimit = {
  /** `plan_limits.period` — `total` counts for ever, `month` per calendar month. */
  readonly period: string
  /** `plan_limits.quantity`. Only the stated rows are here, so never `null`. */
  readonly quantity: number
}

/**
 * **The quota numbers the copy sells — the stated value, not the live one.**
 *
 * `plan_limits` is still the runtime authority, and deliberately so: the spec
 * says it twice, *"configurable without a deploy"* (:302) and *"Numbers live in
 * `plan_limits`, not in code"* (:475). **No quota decision reads this.** Not
 * "no route reads it" — `messages.ts` imports it, so a route that renders copy
 * does, to produce text. The claim that matters is the narrower one: no
 * `readLimit` call was replaced by a constant, nothing here answers *"may this
 * request spend a screening"*, and raising Básico from 5 to 8 is still one
 * `UPDATE`. In a file whose whole subject is the difference between the stated
 * number and the live one, the loose version of that sentence is the kind of
 * claim §4d is about.
 *
 * What it is for is the other half of the promise. `2 triagens`, `3 dias` and
 * `5 triagens por mês` are sold word-for-word in about a dozen catalogue
 * strings and in the terms' entitlement table, and D64 removed the last
 * assertions — incidental literals inside route-contract suites — that the
 * table still held them. So a migration lowering Básico to 3 was silent while
 * every page kept promising five, which CDC art. 30 makes a problem rather
 * than an inconsistency.
 *
 * Three readers, and they close the triangle:
 *  - `messages.ts` turns these into `{$triagensVisitante}`, `{$diasVisitante}`
 *    and `{$triagensBasico}`, so the sentences stop typing the digit;
 *  - `product.test.ts` fails when a catalogue string types one by hand, and
 *    when a swept phrase stops appearing at all;
 *  - `product.db.test.ts` fails when `plan_limits` disagrees — the one check
 *    this file cannot make, because it cannot see the database.
 *
 * Keyed `(plan, feature)`, the table's own primary key, spelled the same way.
 *
 * **Frozen all the way down**, unlike the other exports here, which only hold
 * primitives and are therefore deep by accident. `Object.freeze` is shallow, so
 * a single call on the outer object would leave `PLAN_LIMITS.visitor.screening`
 * writable while the `Readonly<…>` type said otherwise — a declaration that
 * promises more than it gives, which is the shape of §4d.
 */
export const PLAN_LIMITS: Readonly<Record<string, Readonly<Record<string, StatedLimit>>>> =
  Object.freeze(
    Object.fromEntries(
      Object.entries(facts.planLimits).map(([plan, features]) => [
        plan,
        Object.freeze(
          Object.fromEntries(
            Object.entries(features).map(([feature, limit]) => [feature, Object.freeze(limit)]),
          ),
        ),
      ]),
    ),
  )

/**
 * The same rows flattened, for the two guards that walk them.
 *
 * Generic over `planLimits` on purpose: a row added to `docs/product.json` is
 * swept and asserted without touching this file, which is what keeps the guard
 * from growing a hole nobody can see.
 *
 * **No `$`-prefix filter, because one cannot be needed.** The house convention
 * in `docs/product.json` is a `$…Comment` key, and an earlier version of this
 * skipped them — dead code: the declared type makes a nested `"$comment"` a
 * **TS2322** at the import, since `string` is not a `StatedLimit`. So the
 * comment for this block is `$planLimitsComment`, a **sibling** of
 * `planLimits`, never a child. A filter here would have told a future author
 * that nesting one works, and the compiler would then have told them it does
 * not, in a message about index signatures.
 */
export const STATED_LIMITS: ReadonlyArray<
  Readonly<{ plan: string; feature: string } & StatedLimit>
> = Object.freeze(
  Object.entries(PLAN_LIMITS).flatMap(([plan, features]) =>
    Object.entries(features).map(([feature, limit]) =>
      Object.freeze({ plan, feature, period: limit.period, quantity: limit.quantity }),
    ),
  ),
)

/** How many months the founder price lasts, and what it becomes after. */
export const PROMO = Object.freeze({
  months: facts.plans.promocional.months,
  thenBrl: facts.plans.promocional.thenBrl,
})

export const FOUNDERS = Object.freeze({
  /**
   * **Contractual.** Terms §6: the offer is limited to 25 subscribers,
   * released in lots of 17 then 8. This is the number the copy and the legal
   * documents quote, because it is the promise — not how many are open today.
   */
  seatsTotal: facts.founders.seatsTotal,
  /**
   * What a fresh database starts its cap at. **Not the live cap.**
   *
   * The cap that decides whether a signup gets a seat or a waitlist place is a
   * row in `app_settings`, so opening lot 2 is an `UPDATE` rather than a
   * deploy. Reading this constant at signup time would put eight seats behind
   * a CI run and an image build — a chain that took six days end to end on
   * 2026-09-26.
   */
  seatsOpenDefault: facts.founders.seatsOpenDefault,
  opensOn: facts.founders.opensOn,
  opensAtBrt: facts.founders.opensAtBrt,
})

/** Days of warning we owe before a charge changes or arrives (the terms). */
export const NOTICE = Object.freeze({
  priceChangeDays: facts.notice.priceChangeDays,
  chargeReminderDays: facts.notice.chargeReminderDays,
})

/**
 * Terms §8. Days 1–7 are CDC art. 49 and always win; days 8–30 are our own
 * guarantee and deduct the acquirer's fee. The net amount quoted in the copy
 * is **derived**, never stored — see `docs/product.json`.
 */
export const REFUND = Object.freeze({
  statutoryDays: facts.refund.statutoryDays,
  guaranteeDays: facts.refund.guaranteeDays,
  processingFeeBrl: facts.refund.processingFeeBrl,
})

/**
 * `26` → `"R$ 26"`. The form used in running copy.
 *
 * Deliberately *not* `Intl.NumberFormat`: it emits a non-breaking space
 * (U+00A0) between the symbol and the digits, which reads identically and
 * compares unequal — so every assertion against a catalogue string, and every
 * `grep` a person runs, would silently miss.
 */
export function brl(amount: number): string {
  return `R$ ${amount}`
}

/** `26` → `"R$ 26,00"`. The form the legal documents and receipts use. */
export function brlExact(amount: number): string {
  return `R$ ${amount},00`
}
