import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AccountSummary } from '@/lib/account/summary'
import { messages } from '@/lib/messages'
import { MenuView } from './menu-view'

/**
 * Canvas 09's contents. The drawer behaviour it sits inside is
 * `components/sheet.tsx`'s and is exercised by the journey, not here — this
 * file is the markup, in the house style.
 */

const copy = messages.radar.menu
const account = messages.account.screen

function summary(over: Partial<AccountSummary> = {}): AccountSummary {
  return {
    plan: 'basico',
    screenings: { feature: 'screening', plan: 'basico', period: 'month', limit: 5, used: 3, left: 2 },
    alerts: { feature: 'alert', plan: 'basico', period: 'week', limit: 1, used: 0, left: 1 },
    founderSeat: null,
    signedIn: true,
    ...over,
  }
}

function render(over: Partial<AccountSummary> | null = {}): string {
  return renderToStaticMarkup(
    <MenuView
      summary={over === null ? null : summary(over)}
      current="/radar"
      onDismiss={() => {}}
      titleId="menu-title"
    />,
  )
}

describe('the menu (canvas 09)', () => {
  it('draws both sections and every item the canvas has', () => {
    const out = render()
    for (const label of [
      copy.sectionMain,
      copy.sectionAccount,
      copy.radar,
      copy.alerts,
      copy.company,
      copy.billing,
      copy.profile,
      copy.help,
    ]) {
      expect(out, `missing: ${label}`).toContain(label)
    }
  })

  it('says the plan and the allowance — the whole reason this screen exists', () => {
    // Until canvas 09 shipped, a signed-in person could not see any of this
    // from a screen they actually use. It lived only on `/conta`.
    const out = render()
    expect(out).toContain(messages.plans.basic.name)
    expect(out).toContain('3 de 5')
    expect(out).toContain('1 alerta semanal')
  })

  it('marks the page you are on, for a screen reader as well as the eye', () => {
    expect(render()).toContain('aria-current="page"')
  })

  it('reports an unlimited plan as unlimited, not as a bar at zero', () => {
    const out = render({
      plan: 'essencial',
      signedIn: true,
      screenings: { feature: 'screening', plan: 'essencial', period: 'month', limit: null, used: 9, left: null },
    })
    expect(out).toContain(account.screeningsUnlimited)
    expect(out).toContain(messages.plans.essential.name)
    // No progress bar: there is no proportion to draw.
    expect(out).not.toContain('role="progressbar"')
  })

  it('tells the truth about a plan with no alert row', () => {
    // `plan_limits` carries an `alert` row for `basico` alone, so a paid plan
    // genuinely answers zero here. `/fundadores` says "todo dia no Essencial"
    // — that contradiction is card D6, and this screen must not paper over it.
    const out = render({
      plan: 'essencial',
      alerts: { feature: 'alert', plan: 'essencial', period: null, limit: 0, used: 0, left: 0 },
    })
    expect(out).toContain('sem alertas neste plano')
  })

  it('renders for a visitor rather than going blank', () => {
    // The people most likely to open it are the ones with no account.
    const out = render({
      plan: 'visitor',
      signedIn: false,
      screenings: { feature: 'screening', plan: 'visitor', period: 'total', limit: 2, used: 1, left: 1 },
      alerts: { feature: 'alert', plan: 'visitor', period: null, limit: 0, used: 0, left: 0 },
    })
    expect(out).toContain(copy.planVisitor)
    expect(out).toContain('1 de 2')
    // …and it offers the account, not the upgrade.
    expect(out).toContain(copy.signIn)
    expect(out).not.toContain(copy.upgrade)
  })

  it('draws the links before the plan strip has arrived', () => {
    // The strip is fetched when the drawer opens. Navigation must not wait on
    // it — a menu whose links appear a second late is a menu that gets tapped
    // twice.
    const out = render(null)
    expect(out).toContain(copy.radar)
    expect(out).toContain(copy.alerts)
    expect(out).toContain(messages.common.loading)
  })

  it('names itself for assistive technology without inventing a visible title', () => {
    const out = render()
    expect(out).toContain('id="menu-title"')
    expect(out).toMatch(/class="sr-only"[^>]*>Menu</)
  })
})
