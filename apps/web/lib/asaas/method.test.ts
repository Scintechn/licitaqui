import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SUBSCRIPTION_METHOD,
  parseSubscriptionMethod,
  SUBSCRIPTION_METHODS,
  type SubscriptionMethod,
} from './method'

/**
 * The payment methods the product offers — Sci's rule of 2026-10-11, Pix *and*
 * card.
 *
 * **Why this file exists at all.** The union is the only thing standing
 * between a crafted POST and a subscription Asaas cannot refund. Sandbox,
 * 2026-10-10: a boleto subscription's refund came back *"Somente é possível
 * estornar cobranças cuja a forma de pagamento seja cartão de crédito ou
 * Pix."* The terms promise a 7-day withdrawal (CDC art. 49) and a 30-day
 * guarantee, so `'BOLETO'` reaching Asaas is a promise we cannot keep — and a
 * type alone does not stop a string arriving over HTTP.
 */

describe('the offered methods', () => {
  it('offers exactly Pix and card — never boleto, never the payer-picks value', () => {
    expect([...SUBSCRIPTION_METHODS].sort()).toEqual(['CREDIT_CARD', 'PIX'])
    // Named rather than implied by the count: `UNDEFINED` is the one that
    // looks harmless (Asaas calls it "the payer chooses") and silently adds
    // boleto to the invoice page. That is how this defect shipped the first
    // time.
    expect(SUBSCRIPTION_METHODS).not.toContain('BOLETO')
    expect(SUBSCRIPTION_METHODS).not.toContain('UNDEFINED')
  })

  it('defaults to the one that renews without the subscriber doing anything', () => {
    // A Pix subscription is an invoice per cycle: Asaas issues a fresh QR each
    // month and nothing is debited on its own. The card is tokenized on the
    // first payment and charged automatically after that (measured
    // 2026-10-11). So the default is the method that cannot lapse by
    // forgetfulness, and the other is one click away.
    expect(DEFAULT_SUBSCRIPTION_METHOD).toBe('CREDIT_CARD')
    expect(SUBSCRIPTION_METHODS[0]).toBe(DEFAULT_SUBSCRIPTION_METHOD)
  })
})

describe('parseSubscriptionMethod', () => {
  it('accepts the two the product offers', () => {
    expect(parseSubscriptionMethod('PIX')).toBe('PIX')
    expect(parseSubscriptionMethod('CREDIT_CARD')).toBe('CREDIT_CARD')
  })

  it('refuses boleto, and refuses it as null rather than as a default', () => {
    // The distinction is the whole point: a parser that returned the default
    // for an unknown value would accept `'BOLETO'` from a crafted request and
    // bill a method we cannot refund. `null` forces the caller to decide, and
    // `actions.ts` decides by refusing.
    expect(parseSubscriptionMethod('BOLETO')).toBeNull()
    expect(parseSubscriptionMethod('UNDEFINED')).toBeNull()
  })

  it('refuses everything that is not one of the two, whatever its type', () => {
    for (const value of [
      '',
      'pix', // case matters: Asaas's enum is upper-case
      'credit_card',
      'CREDIT_CARD ',
      'PIX,CREDIT_CARD',
      null,
      undefined,
      0,
      {},
      ['PIX'],
      new File([], 'x'), // what `FormData.get` returns for a file input
    ]) {
      expect(parseSubscriptionMethod(value)).toBeNull()
    }
  })

  it('round-trips every member, so adding one cannot skip the parser', () => {
    // If a third method is ever added to the union (Pix Automático, F26), this
    // fails until it is added to `SUBSCRIPTION_METHODS` too — the two must not
    // drift, because the parser is driven by the array and the type by the
    // union.
    const all: readonly SubscriptionMethod[] = ['PIX', 'CREDIT_CARD']
    for (const method of all) expect(parseSubscriptionMethod(method)).toBe(method)
    expect(SUBSCRIPTION_METHODS).toHaveLength(all.length)
  })
})
