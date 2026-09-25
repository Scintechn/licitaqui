import { describe, expect, it } from 'vitest'
import { FOUNDERS_LEAD_EVENT, pushFoundersLead } from './lead-event'

/**
 * The founders conversion is money: Google Ads bids on whatever this pushes.
 *
 * So these pin the two ways it could be wrong in opposite directions — firing
 * for somebody who is not a new lead, and failing to fire for somebody who is.
 * The first inflates the bid, the second starves it, and neither shows up in
 * the product at all.
 */

function host(): { dataLayer?: unknown[] } {
  return {}
}

describe('the founders lead event', () => {
  it('pushes for a seated founder', () => {
    const h = host()
    expect(pushFoundersLead('seated', h)).toBe(true)
    expect(h.dataLayer).toEqual([{ event: FOUNDERS_LEAD_EVENT }])
  })

  it('pushes for a waitlisted person — they joined the list too', () => {
    const h = host()
    expect(pushFoundersLead('waitlisted', h)).toBe(true)
    expect(h.dataLayer).toEqual([{ event: FOUNDERS_LEAD_EVENT }])
  })

  it('does not push for a repeat submission', () => {
    // `already_registered` means the row already existed: no new seat, no new
    // job, nobody new on the list. Counting it would pay for the same person
    // twice — and the second time arrives from a second paid click, which is
    // precisely what Google's "count once per click" does not collapse.
    const h = host()
    expect(pushFoundersLead('already_registered', h)).toBe(false)
    expect(h.dataLayer).toBeUndefined()
  })

  it('creates the array when Tag Manager has not, rather than dropping the event', () => {
    const h = host()
    expect(h.dataLayer).toBeUndefined()
    pushFoundersLead('seated', h)
    expect(h.dataLayer).toHaveLength(1)
  })

  it('appends rather than replacing what Tag Manager already queued', () => {
    const h: { dataLayer?: unknown[] } = { dataLayer: [{ event: 'gtm.js' }] }
    pushFoundersLead('seated', h)
    expect(h.dataLayer).toEqual([{ event: 'gtm.js' }, { event: FOUNDERS_LEAD_EVENT }])
  })

  it('is a no-op with no host at all, rather than throwing', () => {
    // The default host is `window`, which does not exist under
    // `environment: 'node'` — nor during any server render of this page.
    expect(pushFoundersLead('seated', undefined)).toBe(false)
  })
})
