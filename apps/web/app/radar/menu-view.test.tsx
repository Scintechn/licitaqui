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

/**
 * `current` is an `Item['id']`, **not an href**. Three items share `/conta`,
 * so marking by href lit all three at once — see `currentItem` in
 * `components/app-shell.tsx` for the defect and the fix.
 */
function render(over: Partial<AccountSummary> | null = {}): string {
  return renderToStaticMarkup(
    <MenuView
      summary={over === null ? null : summary(over)}
      current="radar"
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
    ]) {
      expect(out, `missing: ${label}`).toContain(label)
    }
  })

  it('does not link to a route that is not built', () => {
    // `/ajuda` does not exist. Next prefetches a `<Link>` on viewport entry,
    // and `lib/routes.ts` spends a paragraph on exactly this: an unbuilt
    // destination is "a burst of 404s on every page view". This menu renders
    // six links at once, so it would have been six.
    //
    // `copy.help` stays in the catalogue for the day the route exists; this
    // assertion is what will fail then, which is the reminder to re-add the row.
    const out = render()
    expect(out).not.toContain('/ajuda')
    expect(out).not.toContain(copy.help)
  })

  it('sends a signed-in person to their account, not to the signup screen', () => {
    // It pointed at `ACCOUNT_HREF` (`/conta/criar`). The strip above only
    // renders for a signed-in viewer, so the create-account page is the one
    // destination "Perfil" can never mean.
    const out = render()
    expect(out).toContain('href="/conta"')
    expect(out).not.toContain('href="/conta/criar"')
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

  it('draws the links even when the summary could not be read', () => {
    // Navigation must not depend on the strip — a menu whose links are missing
    // is not a menu.
    //
    // **What `null` means changed in D20**, so this assertion changed with it.
    // It used to mean *in flight*: `radar-screen.tsx` fetched
    // `/api/conta/resumo` when the drawer opened, and "Carregando…" was
    // honest for the moment it lasted. The summary is now read on the server
    // in the layout, and `readShellSummary` returns a real summary for a
    // visitor — so `null` reaches here only when the read **threw**, and a
    // strip stuck on "Carregando…" would be a permanent lie about something
    // that is not loading.
    const out = render(null)
    expect(out).toContain(copy.radar)
    expect(out).toContain(copy.alerts)
    expect(out).not.toContain(messages.common.loading)
  })

  it('names itself for assistive technology without inventing a visible title', () => {
    const out = render()
    expect(out).toContain('id="menu-title"')
    expect(out).toMatch(/class="sr-only"[^>]*>Menu</)
  })
})

describe('the favourites badge (D23)', () => {
  /**
   * Sci's card asks for the count and the list to come from **one query**, and
   * this is the half of that rule the markup can assert.
   *
   * The other half is in `lib/account/server-summary.ts`: `readShell` calls
   * `listFavourites` and takes `.length`, which is why
   * `lib/favourites/store.ts` deliberately has no `countFavourites`. A second
   * query is a second answer, free to disagree — a badge saying 4 above a list
   * showing 3 is the exact shape this repo keeps finding, where two readers of
   * one fact reach different conclusions.
   */
  function withCount(count: number | null) {
    return renderToStaticMarkup(
      <MenuView summary={summary()} current="radar" favouriteCount={count} onDismiss={() => {}} titleId="t" />,
    )
  }

  it('shows the number when there is one', () => {
    expect(withCount(4)).toContain('>4<')
  })

  it('shows nothing at zero, rather than a "0"', () => {
    // A badge that is usually 0 trains people to stop reading it, and nothing
    // marked is not a quantity worth showing.
    const out = withCount(0)
    expect(out).toContain(copy.favourites)
    expect(out).not.toContain('>0<')
  })

  it('shows nothing when the count is unknown', () => {
    // `null` is a visitor, or a screen that did not read them — not zero.
    expect(withCount(null)).not.toMatch(/>\d+</)
  })

  it('still draws the entry either way, so the section is reachable', () => {
    for (const count of [null, 0, 9]) {
      expect(withCount(count)).toContain(copy.favourites)
    }
  })
})
