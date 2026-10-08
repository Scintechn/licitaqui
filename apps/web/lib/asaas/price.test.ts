import { describe, expect, it } from 'vitest'
import { PLAN_PRICES, PROMO } from '@/lib/product'
import { moneyExact } from '@/lib/radar/format'
import { CURRENCY, PLAN_ESSENCIAL, PLAN_PROMOCIONAL, priceFor } from './price'

/**
 * **What a subscriber is charged, against `docs/product.json`.**
 *
 * This is the behavioural half of Gate 1. The source half — *no money literal
 * may reappear under `lib/asaas/`* — is in `product.test.ts`, because that is
 * where the rest of the "a product fact is typed by hand" sweep lives.
 *
 * Every expectation below is computed from `PLAN_PRICES`/`PROMO` rather than
 * typed, so changing `docs/product.json` changes the test with the code. A
 * test that asserted `5700` would be a second place to forget.
 */
describe('priceFor', () => {
  it('charges a founder seat the promotional price, for the promotional months', () => {
    const price = priceFor(1)
    expect(price.plan).toBe(PLAN_PROMOCIONAL)
    expect(price.reais).toBe(PLAN_PRICES.promocional)
    expect(price.cents).toBe(PLAN_PRICES.promocional * 100)
    expect(price.promotional).toBe(true)
    expect(price.promoMonths).toBe(PROMO.months)
    expect(price.thenCents).toBe(PROMO.thenBrl * 100)
    expect(price.currency).toBe(CURRENCY)
  })

  it('charges an account with no seat the Essencial price, with no later change', () => {
    const price = priceFor(null)
    expect(price.plan).toBe(PLAN_ESSENCIAL)
    expect(price.reais).toBe(PLAN_PRICES.essencial)
    expect(price.cents).toBe(PLAN_PRICES.essencial * 100)
    expect(price.promotional).toBe(false)
    expect(price.promoMonths).toBeNull()
    expect(price.thenCents).toBeNull()
  })

  it('treats every seat number the same — the seat exists or it does not', () => {
    // There is no live seat count to race against: a seat is assigned at
    // signup. Seat 25 and seat 1 pay the same, and seat 0 is not a seat
    // `founders_list` can assign (the column CHECK starts at 1) but is also
    // not `null`, so it must not fall through to Essencial by accident.
    for (const seat of [1, 17, 25, 48]) {
      expect(priceFor(seat).reais, `seat ${seat}`).toBe(PLAN_PRICES.promocional)
    }
  })

  it('puts the promotional price strictly below what it becomes', () => {
    // Not decoration: a "promotional" price at or above the standard one would
    // make every sentence in `billing.priceChange.*` false, and those are
    // approved copy about a price change people have accepted.
    expect(PLAN_PRICES.promocional).toBeLessThan(PROMO.thenBrl)
    expect(PROMO.months).toBeGreaterThan(0)
  })
})

describe('what the plan screen prints', () => {
  /**
   * The house formatter, not one of this module's own. See the note where
   * `formatBrl` used to be: a second money formatter inside the file whose
   * subject is "one number, one place" is the same defect one level up.
   */
  it('prints the amount Asaas is told to charge in the catalogue spelling', () => {
    const price = priceFor(1)
    expect(moneyExact(price.reais.toFixed(2))).toBe(`R$ ${PLAN_PRICES.promocional},00`)
    // The non-breaking space is the whole reason `moneyExact` exists; a
    // screen mixing it with the catalogue's ordinary one shows two spacings
    // for the same price.
    expect(moneyExact(price.reais.toFixed(2))).not.toContain(' ')
  })
})
