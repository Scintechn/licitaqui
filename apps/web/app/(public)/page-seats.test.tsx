import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { format, messages } from '@/lib/messages'
import { FOUNDER_SEATS } from '@/lib/founders/seats'

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }))

/**
 * The Landing with a seat count to show.
 *
 * `page.test.tsx` renders the page the way `next build` does — no database, so
 * no count — and pins the degraded wording. This file is the other half: given
 * a count, the promo box in the plans says how many founder seats are left.
 *
 * The count is mocked rather than read: `founderSeats` has its own unit test,
 * and a page test that needed Postgres would be a page test that does not run.
 */
const TAKEN = 31
const LEFT = FOUNDER_SEATS - TAKEN

vi.mock('@/lib/founders/seat-count', () => ({
  founderSeats: async () => ({
    total: FOUNDER_SEATS,
    taken: TAKEN,
    left: LEFT,
    soldOut: false,
  }),
}))

const { default: LandingPage } = await import('./page')
const out = renderToStaticMarkup(await LandingPage())

describe('/ · with a live seat count', () => {
  it('says the same number in the Essencial plan card', () => {
    expect(out).toContain(format(messages.founders.seats.left, { count: LEFT }))
  })

  it('drops the wording that stands in for a count it does not have', () => {
    expect(out).not.toContain(`<span>${messages.foundersPage.signup.seatsGroup}</span>`)
  })
})
