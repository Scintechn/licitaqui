import { describe, expect, it } from 'vitest'
import type { BandResponse } from '@/lib/radar/contract'
import type { PriceBand, PriceEvidence } from '@/lib/radar/price-band'
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

/**
 * Evidence as the route sends it beside a band (E22): same six editais the
 * band rests on, four of them printed.
 */
const EVIDENCE: PriceEvidence = {
  editais: 6,
  samples: [
    { tenderId: '99000000000001-1-000001/2026', value: 24, description: 'CANETA ESFEROGRAFICA AZUL' },
    { tenderId: '99000000000002-1-000001/2026', value: 20.34, description: 'CANETA ESFEROGRAFICA AZUL' },
    { tenderId: '99000000000003-1-000001/2026', value: 19, description: 'CANETA ESFEROGRAFICA, AZUL' },
    { tenderId: '99000000000004-1-000001/2026', value: 18, description: 'CANETA ESFEROGRAFICA AZUL' },
  ],
}

describe('bandStateFrom', () => {
  it('carries the evidence through a lock — the ladder is free at every rung', () => {
    // **The client half of the monotonicity rule.** The route sends `evidence`
    // on a `locked` answer on purpose (Sci, 2026-10-01: raw evidence free,
    // computation paid); dropping it in this mapping would make the screen go
    // backwards at five editais — a visitor would see the matched results at
    // four and an empty card at six, the moment the data got good enough to
    // sell. The band itself must still be absent.
    expect(bandStateFrom({ state: 'locked', evidence: EVIDENCE })).toEqual({
      band: null,
      locked: true,
      evidence: EVIDENCE,
    })
  })

  it('keeps a band the caller may see', () => {
    expect(bandStateFrom({ state: 'ready', band: BAND, evidence: EVIDENCE })).toEqual({
      band: BAND,
      locked: false,
      evidence: EVIDENCE,
    })
  })

  it('is ready-and-empty, not locked, when nothing at all was found', () => {
    // **`locked: false`** is what makes the screen say "ainda sem dados de
    // vencedores" rather than draw a locked bar over a number that is not
    // there and imply one is being withheld.
    //
    // E22 narrowed what "empty" means. Both null is now the *only* empty case:
    // measured 2026-10-01 over 600 open items, 11.17% have a past winner of
    // the same product and 0.67% clear the band's gate, so for roughly ten
    // items in every eleven that used to land here there is something to show.
    expect(bandStateFrom({ state: 'ready', band: null, evidence: null })).toEqual({
      band: null,
      locked: false,
      evidence: null,
    })
  })

  it('is ready with evidence and no band — the rung E22 exists for', () => {
    // The 10× case: `priceBand` refused (fewer than MIN_SAMPLE editais, or too
    // wide a spread) and `priceEvidence` did not. `locked` stays false — there
    // is no number being withheld, there is a thinner answer being shown.
    const thin = { ...EVIDENCE, editais: 2, samples: EVIDENCE.samples.slice(0, 2) }
    expect(bandStateFrom({ state: 'ready', band: null, evidence: thin })).toEqual({
      band: null,
      locked: false,
      evidence: thin,
    })
  })

  it('locks when a number exists that this plan may not see', () => {
    // The distinction the route exists to make: *locked* means a number is
    // there and this plan does not include it. The route never sends `locked`
    // unless `priceBand()` actually returned one.
    expect(bandStateFrom({ state: 'locked', evidence: null })).toEqual({
      band: null,
      locked: true,
      evidence: null,
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
      evidence: null,
    })
    expect(bandStateFrom({ state: 'error', error: 'rate_limited' })).toEqual({
      band: null,
      locked: false,
      evidence: null,
    })
  })

  it('never reads an entitlement field, even if one is sent', () => {
    // The guard against the old shape coming back. `getBand` is
    // `envelope<BandResponse>(...)` — a cast, not a parse — so an old server
    // during a rollout can put `entitled` on the wire and TypeScript will not
    // notice. It must change nothing: entitlement comes from the server render.
    const legacy = {
      state: 'ready',
      band: BAND,
      evidence: null,
      entitled: false,
    } as unknown as BandResponse
    expect(bandStateFrom(legacy)).toEqual({ band: BAND, locked: false, evidence: null })
  })
})
