import { describe, expect, it } from 'vitest'
import type { QuotaView } from '@/lib/radar/contract'
import { screeningsLeftCaption } from './screenings-left'

/**
 * D25 (4) — which quota gets a sentence, and which gets silence.
 *
 * The rules here are all about **not** printing a number. Two of them are
 * things this product has already got wrong once: a limit named from memory
 * rather than from `plan_limits` (B27, a Launch database reported at 338% of
 * Free's 0.5 GB), and a metered sentence shown on an unlimited plan (six hours
 * of "Usa 1 das suas triagens" under a button, the morning founders week
 * opened, on plans whose feature list says "sem limite").
 */

function quota(over: Partial<QuotaView> = {}): QuotaView {
  return { feature: 'screening', plan: 'basico', period: 'month', limit: 5, used: 2, left: 3, ...over }
}

describe('screeningsLeftCaption', () => {
  it('counts what is left, in the plan’s own words', () => {
    expect(screeningsLeftCaption(quota())).toBe('Restam 3 triagens neste mês')
    expect(screeningsLeftCaption(quota({ used: 4, left: 1 }))).toBe('Resta 1 triagem neste mês')
  })

  it('speaks to a visitor about free triagens, not about a month', () => {
    // A visitor has no month: the allowance is the trial's two, total.
    const view = quota({ plan: 'visitor', period: 'total', limit: 2, used: 1, left: 1 })
    expect(screeningsLeftCaption(view)).toBe('Resta 1 triagem gratuita')
  })

  it('says nothing when the plan has no limit', () => {
    // `left: null` is `plan_limits.quantity is null` — promocional, essencial
    // and pro. There is no count, and a "sem limite" caption would put a
    // second sentence about the plan under a button that is not about plans.
    for (const plan of ['promocional', 'essencial', 'pro']) {
      expect(screeningsLeftCaption(quota({ plan, limit: null, left: null }))).toBeNull()
    }
  })

  it('leaves the exhausted state to the screen that reads the real total', () => {
    // Both `=0` branches name a literal — "suas 5 triagens deste mês" — and
    // that 5 lives in `plan_limits`. `radar.screening.quotaTitle` reads the
    // row; this caption must not assert the number from copy.
    expect(screeningsLeftCaption(quota({ used: 5, left: 0 }))).toBeNull()
    expect(screeningsLeftCaption(quota({ plan: 'visitor', used: 2, left: 0 }))).toBeNull()
  })

  it('says nothing for a metered plan it has no approved sentence for', () => {
    // A limit with no copy of its own gets silence rather than a sentence
    // written for somebody else's quota — which is how `screeningCost` came to
    // tell founders they were spending one of theirs.
    expect(screeningsLeftCaption(quota({ plan: 'promocional', limit: 20, left: 7 }))).toBeNull()
  })

  it('survives a summary that could not be read', () => {
    expect(screeningsLeftCaption(null)).toBeNull()
  })
})
