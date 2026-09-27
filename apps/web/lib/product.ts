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
