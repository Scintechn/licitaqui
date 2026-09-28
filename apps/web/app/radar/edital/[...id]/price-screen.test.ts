import { describe, expect, it } from 'vitest'
import type { BandResponse } from '@/lib/radar/contract'
import type { PriceBand } from '@/lib/radar/price-band'
import { bandStateFrom, planOffer, type BandState } from './price-screen'

/**
 * The two derivations behind the price screen's plan offer.
 *
 * **There was no test file for this component at all**, which a review of E9
 * found before it merged. The commit that added `entitled` described its
 * regression at length — "an unentitled visitor on an item with no band gets
 * `ready` with `band: null` … so the upsell disappeared from exactly the
 * people it exists for" — and then tested it by passing `showPlanCta` into
 * `PriceView` as a literal. Inverting the real expression left all 1 252 tests
 * green. That is CLAUDE.md §4b's pattern exactly: the test exercised the unit,
 * not the path.
 *
 * `vitest.config.mts` sets `environment: 'node'`, so the effect these two
 * functions were lifted out of can never run under test. Lifting them is what
 * makes the path testable without a DOM; the render itself is E16.
 */

const BAND: PriceBand = {
  low: 18,
  median: 20.34,
  high: 24,
  // `sampleSize` is distinct editais, not rows — see `PriceBand`.
  sampleSize: 6,
}

describe('bandStateFrom', () => {
  it('keeps a band an entitled caller may see', () => {
    expect(bandStateFrom({ state: 'ready', band: BAND, entitled: true })).toEqual({
      band: BAND,
      locked: false,
      entitled: true,
    })
  })

  it('carries entitled: false through a ready-but-empty answer', () => {
    // **The case the whole `entitled` field exists for.** An unentitled
    // visitor on an item with no band, which is ~99 of every 100 items. Read
    // off `band` alone this is indistinguishable from a subscriber's empty
    // item, and the upsell vanishes from the people it is for.
    expect(bandStateFrom({ state: 'ready', band: null, entitled: false })).toEqual({
      band: null,
      locked: false,
      entitled: false,
    })
  })

  it('treats a missing entitled as not entitled, not as entitled', () => {
    // `getBand` is `envelope<BandResponse>(...)` — a cast, not a parse — so a
    // body without the field type-checks and arrives as `undefined`. A new
    // bundle against an old server mid-rollout is the realistic way in.
    // Coercing with `=== true` means the failure is a visitor being offered a
    // plan, never a subscriber being sold one they already pay for.
    const stale = { state: 'ready', band: BAND } as unknown as BandResponse
    expect(bandStateFrom(stale).entitled).toBe(false)
  })

  it('locks without a band, and never claims entitlement while locked', () => {
    expect(bandStateFrom({ state: 'locked' })).toEqual({
      band: null,
      locked: true,
      entitled: false,
    })
  })

  it('sells nothing when the request failed', () => {
    // `entitled: true` on an error is not a claim about the plan. It is the
    // choice to offer nothing when we do not know — a wrong "buy this" is an
    // insult to a subscriber and a promise made on no evidence to a visitor.
    // `locked: false` so the screen falls back to the honest empty card
    // rather than to a locked bar advertising the plan they already bought.
    expect(bandStateFrom({ state: 'error', error: 'server_error' })).toEqual({
      band: null,
      locked: false,
      entitled: true,
    })
  })
})

describe('planOffer', () => {
  const state = (over: Partial<BandState>): BandState => ({
    band: null,
    locked: false,
    entitled: true,
    ...over,
  })

  it.each([
    ['a locked band', state({ locked: true, entitled: false }), true],
    ['an unentitled caller with no band', state({ entitled: false }), true],
    ['an entitled caller with a band', state({ band: BAND }), false],
    ['an entitled caller with no band', state({}), false],
    ['a failed request', state({ entitled: true }), false],
  ])('offers the plan to %s: %o -> %s', (_label, current, expected) => {
    expect(planOffer(current)).toBe(expected)
  })

  it('offers nothing while the answer is in flight', () => {
    // Also covers a tender with no items, where `chooseItem` answers null and
    // the band is never requested. Both are "we did not ask", and the rule is
    // the same as a failure: sell nothing when we do not know.
    expect(planOffer(null)).toBe(false)
  })

  it('does not simply mirror bandLocked', () => {
    // The regression this file exists for. `bandLocked` is
    // `current === null || current.locked`; driving the CTA off it alone made
    // the two expressions agree on every locked case and disagree on the one
    // that matters, below.
    const unentitledEmpty = state({ entitled: false })
    const bandLocked = unentitledEmpty.locked
    expect(bandLocked).toBe(false)
    expect(planOffer(unentitledEmpty)).toBe(true)
  })
})
