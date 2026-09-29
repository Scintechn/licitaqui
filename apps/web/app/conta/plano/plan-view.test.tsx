import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messages } from '@/lib/messages'
import type { QuotaView } from '@/lib/radar/contract'
import { FOUNDERS } from '@/lib/product'
import { PLAN_HREF } from '@/lib/routes'
import { PlanView } from './plan-view'

/**
 * `/conta/plano` — card **D22**.
 *
 * The assertion this file exists for is the negative one, carried over from
 * `account-view.test.tsx`: **no number on this screen is written in the
 * markup**. Legal brief §5 says the limits live in `plan_limits` and change
 * without a deploy, so every figure arrives through `quota`, and a component
 * that hard-coded "5" would be lying the first time Sci edited a row.
 *
 * The seat total is the other half of that rule, and it is the one that broke:
 * `/conta` rendered `MAX_SEAT` — a database CHECK bound of 48 — so a founder
 * read "Vaga 1 de 48" while the terms sold 25 (**E19**).
 */

const copy = messages.account.screen

const BASICO: QuotaView = {
  feature: 'screening',
  plan: 'basico',
  period: 'month',
  limit: 5,
  used: 2,
  left: 3,
}

function render(over: Partial<Parameters<typeof PlanView>[0]> = {}) {
  return renderToStaticMarkup(
    <PlanView
      plan="basico"
      planName={messages.plans.basic.name}
      quota={BASICO}
      founderSeat={null}
      seatTotal={FOUNDERS.seatsTotal}
      {...over}
    />,
  )
}

describe('the plan screen', () => {
  it('is headed by the words the reader tapped to get here', () => {
    expect(render()).toContain(messages.radar.menu.billing)
  })

  it('names the plan in Portuguese and shows what is left of it', () => {
    const out = render()
    expect(out).toContain(messages.plans.basic.name)
    expect(out).toContain('2 de 5 neste mês')
  })

  it('reads the allowance out of the quota, never out of the markup', () => {
    // Change the row, change the screen. If this ever needs editing because a
    // limit moved, the number is in the wrong place.
    const out = render({ quota: { ...BASICO, limit: 9, used: 1, left: 8 } })
    expect(out).toContain('1 de 9 neste mês')
    expect(out).not.toContain('2 de 5')
  })

  it('shows a founder their seat against the number the terms sell', () => {
    // **Not `MAX_SEAT`.** 48 is a column bound; 25 is the offer. Rendering the
    // bound told a founder "Vaga 1 de 48" while the landing banner said 17 and
    // the terms said 25 — three numbers for one product (E19).
    const founder = render({ founderSeat: 7 })
    expect(founder).toContain(copy.founderLabel)
    expect(founder).toContain(`de ${FOUNDERS.seatsTotal}`)
    expect(founder).not.toContain('de 48')
    expect(founder).toContain(copy.founderNote)
  })

  it('shows nobody else a seat row', () => {
    expect(render()).not.toContain(copy.founderLabel)
  })

  it('sends an upgrade through PLAN_HREF, which is the offer until F2 ships', () => {
    // `PLAN_HREF` and `PLAN_PATH` are separate names precisely so this link
    // can change the day billing opens without anyone hunting for it.
    expect(render()).toContain(`href="${PLAN_HREF}"`)
  })

  it('leaves no message placeholder unresolved', () => {
    expect(render({ founderSeat: 7 })).not.toMatch(/\{[a-zA-Z]+\}/)
  })
})
