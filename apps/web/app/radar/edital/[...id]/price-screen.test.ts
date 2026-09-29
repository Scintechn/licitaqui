import { describe, expect, it } from 'vitest'
import type { BandResponse } from '@/lib/radar/contract'
import type { PriceBand } from '@/lib/radar/price-band'
import { bandStateFrom } from './price-screen'

/**
 * How a band answer becomes what the screen draws.
 *
 * **There was no test file for this component at all**, which a review of E9
 * found before it merged. The commit that introduced the plan CTA described
 * its regression at length and then tested it by passing `showPlanCta` into
 * `PriceView` as a literal; inverting the real expression left all 1 252 tests
 * green. That is CLAUDE.md §4b's pattern exactly — the test exercised the
 * unit, not the path.
 *
 * `vitest.config.mts` sets `environment: 'node'`, so the effect this function
 * was lifted out of can never run under test. Lifting it is what makes the
 * mapping testable without a DOM; the render itself is E16.
 *
 * **Entitlement is deliberately absent from everything below.** It used to
 * ride on this response, and the screen's CTA was driven off it. It is now
 * read once on the server (`entitlement.ts`) and passed in as a prop, so
 * `showPlanCta` is `!entitled` and there is nothing here to get wrong.
 */

const BAND: PriceBand = {
  low: 18,
  median: 20.34,
  high: 24,
  // `sampleSize` is distinct editais, not rows — see `PriceBand`.
  sampleSize: 6,
}

describe('bandStateFrom', () => {
  it('keeps a band the caller may see', () => {
    expect(bandStateFrom({ state: 'ready', band: BAND })).toEqual({
      band: BAND,
      locked: false,
    })
  })

  it('is ready-and-empty, not locked, when no number exists', () => {
    // **The normal case**: measured 2026-09-28, roughly 1% of open items clear
    // the gate. `locked: false` is what makes the screen say "ainda sem dados
    // de vencedores" rather than draw a locked bar over a number that is not
    // there and imply one is being withheld.
    expect(bandStateFrom({ state: 'ready', band: null })).toEqual({
      band: null,
      locked: false,
    })
  })

  it('locks when a number exists that this plan may not see', () => {
    // The distinction the route exists to make: *locked* means a number is
    // there and this plan does not include it. The route never sends `locked`
    // unless `priceBand()` actually returned one.
    expect(bandStateFrom({ state: 'locked' })).toEqual({
      band: null,
      locked: true,
    })
  })

  it('degrades a failure to the empty card, never to the locked bar', () => {
    // `envelope()` does not throw on a non-2xx — it parses the body — so a 429
    // or a 500 arrives as `state: 'error'`. Leaving `loaded` null instead made
    // `bandLocked` default to **true**, and an Essencial subscriber whose
    // request failed was shown the bar labelled "valor disponível no plano
    // Essencial", permanently, with no retry on this path.
    expect(bandStateFrom({ state: 'error', error: 'server_error' })).toEqual({
      band: null,
      locked: false,
    })
    expect(bandStateFrom({ state: 'error', error: 'rate_limited' })).toEqual({
      band: null,
      locked: false,
    })
  })

  it('never reads an entitlement field, even if one is sent', () => {
    // The guard against the old shape coming back. `getBand` is
    // `envelope<BandResponse>(...)` — a cast, not a parse — so an old server
    // during a rollout can put `entitled` on the wire and TypeScript will not
    // notice. It must change nothing: entitlement comes from the server render.
    const legacy = { state: 'ready', band: BAND, entitled: false } as unknown as BandResponse
    expect(bandStateFrom(legacy)).toEqual({ band: BAND, locked: false })
  })
})
