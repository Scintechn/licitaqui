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
  seats: facts.founders.seats,
  opensOn: facts.founders.opensOn,
  opensAtBrt: facts.founders.opensAtBrt,
})

/** Days of warning we owe before a charge changes or arrives (the terms). */
export const NOTICE = Object.freeze({
  priceChangeDays: facts.notice.priceChangeDays,
  chargeReminderDays: facts.notice.chargeReminderDays,
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
