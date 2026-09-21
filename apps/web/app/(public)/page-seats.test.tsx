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
 * a count, the strip at the top of the document and the promo box in the plans
 * both say how many founder seats are left, and they agree with each other.
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
const copy = messages.radar.landing

describe('/ · with a live seat count', () => {
  it('puts the remaining seats in the founders strip', () => {
    expect(out).toContain(
      format(copy.founderStrip.seats, { count: LEFT, total: FOUNDER_SEATS }),
    )
    expect(out).toContain(`restam ${LEFT} de ${FOUNDER_SEATS} vagas`)
  })

  it('says the same number in the Essencial plan card', () => {
    expect(out).toContain(format(messages.founders.seats.left, { count: LEFT }))
  })

  /**
   * The fallback wording is a whole clause, not a word: with a count in hand
   * neither the strip nor the promo box may still be showing it. ("48 vagas de
   * fundador" on its own survives in the hero link, which is a different
   * sentence and always true.)
   */
  it('drops the wording that stands in for a count it does not have', () => {
    const unknown = format(copy.founderStrip.seatsUnknown, { total: FOUNDER_SEATS })
    expect(out).not.toContain(`· ${unknown}<`)
    expect(out).not.toContain(`<span>${messages.foundersPage.signup.seatsGroup}</span>`)
  })
})
