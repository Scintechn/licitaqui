import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AccountView } from '@/app/conta/account-view'
import type { AccountSummary } from '@/lib/account/summary'
import { messages } from '@/lib/messages'
import { AppShell } from './app-shell'
import { MenuTrigger } from './menu-trigger'

/**
 * **That the menu can be reached**, which is the assertion this repo keeps
 * failing to make.
 *
 * `menu-view.test.tsx` renders `MenuView` directly and passes whether or not
 * anything on any screen can open it. That is how #93 shipped the drawer, its
 * API, its view and its tests while the button stayed unwritten — `onOpenMenu`
 * on a props type, called by nothing, and `radar.nav.menu` an approved string
 * rendered in zero files, with a green build throughout.
 *
 * D20 moved the drawer out of `radar-screen.tsx` into `AppShell` and gave
 * `/conta` a trigger it never had. **All 1 306 tests passed before this file
 * existed**, which says precisely nothing about whether either route can reach
 * a menu. So these tests assert the path: a trigger exists where a shell is,
 * renders nothing where one is not, and the rail carries the plan strip.
 *
 * `environment: 'node'`, so this is markup — `renderToStaticMarkup` runs the
 * render, not the effects. Whether the drawer *opens* on a click is E16's
 * browser spec; whether anything could ever call it is here.
 */

const copy = messages.radar.menu

function summary(over: Partial<AccountSummary> = {}): AccountSummary {
  return {
    plan: 'essencial',
    screenings: {
      feature: 'screening',
      plan: 'essencial',
      period: 'month',
      limit: null,
      used: 3,
      left: null,
    },
    alerts: { feature: 'alert', plan: 'essencial', period: 'week', limit: 1, used: 0, left: 1 },
    founderSeat: null,
    signedIn: true,
    ...over,
  }
}

describe('AppShell', () => {
  it('renders the rail with the plan strip, without waiting for a fetch', () => {
    // The strip is server-read and arrives as a prop. If this ever needs a
    // client fetch again, "am I signed in?" goes unanswered for a round trip
    // on the first paint of every signed-in route.
    const html = renderToStaticMarkup(
      <AppShell summary={summary()}>
        <p>conteúdo</p>
      </AppShell>,
    )
    expect(html).toContain(messages.plans.essential.name)
    expect(html).toContain('conteúdo')
  })

  it('draws the rail beside the content, never over it', () => {
    // The complaint D20 came from: "the side panel didnt should block the
    // main page". A rail in the layout flow cannot dim what it sits next to.
    // `Sheet`'s scrim is the drawer's, and the drawer is `lg:hidden`.
    const html = renderToStaticMarkup(
      <AppShell summary={summary()}>
        <p>conteúdo</p>
      </AppShell>,
    )
    expect(html).toContain('lg:block')
    expect(html).toContain('lg:hidden')
  })

  it('keeps the navigation usable when the summary could not be read', () => {
    // `null` means the read threw — `readShellSummary` returns a real summary
    // for a visitor. The links are the part that must survive; the strip is
    // absent rather than stuck on "Carregando…", which would be a permanent
    // lie now that nothing is in flight.
    const html = renderToStaticMarkup(
      <AppShell summary={null}>
        <p>conteúdo</p>
      </AppShell>,
    )
    expect(html).toContain(copy.radar)
    expect(html).toContain(copy.alerts)
    expect(html).not.toContain(messages.common.loading)
  })

  it('names the plan as "Sem conta" for a visitor', () => {
    // A visitor gets a real summary, not null, so the strip is honest about
    // what they have rather than silent.
    const html = renderToStaticMarkup(
      <AppShell summary={summary({ signedIn: false, plan: 'visitante' })}>
        <p>conteúdo</p>
      </AppShell>,
    )
    expect(html).toContain(copy.planVisitor)
  })
})

describe('the menu can actually be reached', () => {
  it('gives /conta a trigger — the control it never had', () => {
    // Sci found D20 signed in on his own account with no way to reach his
    // plan or his triagens. Delete `<MenuTrigger />` from `account-view.tsx`
    // and this is the only test that fails.
    const html = renderToStaticMarkup(
      <AppShell summary={summary()}>
        <AccountView
          plan="essencial"
          quota={{ feature: 'screening', plan: 'essencial', period: 'month', limit: null, used: 3, left: null }}
          cnpj={null}
          companyName={null}
          founderSeat={null}
          seatTotal={25}
          signOutAction={async () => {}}
          companyAction={async () => {}}
          notice={null}
        />
      </AppShell>,
    )
    expect(html).toContain(messages.radar.nav.menu)
  })

  it('renders no trigger outside a shell, so the Landing draws no dead button', () => {
    // The Landing puts `RadarView` in an example panel with no shell around
    // it. A hamburger there would open nothing at all.
    expect(renderToStaticMarkup(<MenuTrigger />)).toBe('')
  })
})
