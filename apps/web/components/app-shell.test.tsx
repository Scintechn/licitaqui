import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AccountView } from '@/app/conta/account-view'
import type { AccountSummary } from '@/lib/account/summary'
import { messages } from '@/lib/messages'
import { MenuView as MenuViewProbe } from '@/app/radar/menu-view'
import { AppShell, currentItem } from './app-shell'
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
          email="shell@example.com"
          plan="essencial"
          planName={messages.plans.essential.name}
          signOutAction={async () => {}}
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

describe('currentItem — exactly one nav item is marked', () => {
  /**
   * **The defect Sci found minutes after D20 shipped to preview.** Three items
   * — "Minha empresa", "Plano e pagamento" and "Perfil" — all point at
   * `/conta`, because those sections have no routes of their own. `Section`
   * marked the current page by **href**, so all three lit at once.
   *
   * It was invisible for as long as the menu lived inside `radar-screen.tsx`,
   * which always passed `/radar`. Putting the menu on `/conta` is what made a
   * latent bug visible, and no unit test could have caught it, because none of
   * them rendered the menu anywhere but the Radar.
   *
   * It is also why `current` is no longer a prop from the layout: a layout
   * wraps a subtree, so `app/conta/layout.tsx` would hand the same value to
   * `/conta` and `/conta/alertas` and be wrong on one of them.
   */
  it.each([
    ['/radar', 'radar'],
    ['/radar/edital/45699626000176-1-000463/2026', 'radar'],
    ['/conta', 'profile'],
    ['/conta/alertas', 'alerts'],
    // D23's entry, which had no branch in `currentItem` at all until
    // 2026-10-08: it fell through the `/conta` prefix and the rail marked
    // Perfil on somebody's own favourites. See `railPaths` below for the
    // assertion that does not depend on anyone remembering this row.
    ['/conta/favoritos', 'favourites'],
  ])('%s marks %s', (pathname, expected) => {
    expect(currentItem(pathname)).toBe(expected)
  })

  it('marks nothing on the sign-in page or off the app', () => {
    // `/conta/criar` is the sign-in page and gets no shell at all; marking a
    // nav item for it would be marking navigation nobody can see.
    expect(currentItem('/conta/criar')).toBeUndefined()
    expect(currentItem('/')).toBeUndefined()
    expect(currentItem(null)).toBeUndefined()
  })

  it('never marks more than one item, on any route the shell serves', () => {
    // The assertion the old code could not make. `/conta` has three items
    // behind it; exactly one may be marked.
    for (const pathname of railPaths()) {
      const id = currentItem(pathname)
      const html = renderToStaticMarkup(
        <MenuViewProbe summary={summary()} current={id} />,
      )
      expect(html.match(/aria-current="page"/g) ?? []).toHaveLength(1)
    }
  })

  /**
   * **The assertion that does not depend on a list anybody maintains** — and
   * the reason it exists is that both lists have now drifted once each.
   *
   * `currentItem`'s branches are in `components/app-shell.tsx`; the entries
   * they describe are in `app/radar/menu-view.tsx`. Nothing joined them, so
   * **D23 added the Favoritos entry and no branch**: `/conta/favoritos` fell
   * through to the `/conta` prefix, the rail marked Perfil on a reader's own
   * favourites, and this file's own tables could not see it because they were
   * written when they were complete. Exactly one item was marked, so the test
   * above passed — on the wrong one. That is CLAUDE.md §4b's shape exactly: a
   * green suite is not evidence.
   *
   * So the paths come **out of the rendered rail**. A seventh entry whose
   * destination has no branch collides with whatever prefix does match it, the
   * set shrinks, and this fails with nobody editing anything.
   *
   * ## §4c, said plainly: what this does and does not cover
   *
   * It covers the **join** — that `menu-view.tsx`'s list of destinations and
   * `currentItem`'s list of branches describe the same set. It does **not**
   * cover the wiring that connects them at runtime: the probe is handed
   * `current` by this test, so `AppShell`'s `usePathname() → currentItem() →
   * current` path is never exercised here, and `environment: 'node'` could not
   * run it anyway. That is `e2e/journeys/rail-destinations.spec.ts` ("exactly
   * one entry is marked current, and it is the page we are on") in the hermetic
   * lane, and `e2e/accounts/conta-destinations.spec.ts` across all six
   * destinations signed in — which is the spec that **found** this defect, by
   * walking real URLs in a real browser, and which needs a session and a
   * database and therefore never runs in CI. Mechanism here, result there.
   */
  function railPaths(): string[] {
    const html = renderToStaticMarkup(<MenuViewProbe summary={summary()} />)
    /**
     * **Exactly one `<nav>`, asserted before anything is read out of it.**
     * Slicing to the first one would silently skip the entries of a second, so
     * a rail that ever grows a second nav fails here instead of being half
     * measured — the escape hatch this whole function exists to close.
     *
     * The slice is to the `<nav>` and not the whole markup because the logo
     * link above it and the plan strip's "assinar" link below it are not nav
     * entries and have no `currentItem` branch to own.
     */
    expect(html.match(/<nav/g) ?? [], 'the rail renders exactly one nav').toHaveLength(1)
    const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'))
    // Asserted rather than assumed: a `slice` that found nothing returns '' and
    // every assertion below would pass over an empty list.
    expect(nav, 'the probe rendered a rail with a nav in it').toContain('<a')
    const paths = [...nav.matchAll(/href="([^"]+)"/g)].map((match) => match[1])
    expect(paths.length, 'the rail renders its entries').toBeGreaterThanOrEqual(6)

    /**
     * **The last escape, and it is the one that matters most.** This function
     * guards what is inside the `<nav>`; a row added *beside* it would leave
     * the guarded set silently — and an author adding an entry without a
     * `currentItem` branch is exactly the author who might put it in the
     * wrong place.
     *
     * `MenuView` legitimately renders two links outside the nav: the logo
     * (`/radar`) above it, and the plan strip's `assinar`/`signIn` below. So
     * **two** is the whole of what may live out there, and a third fails here
     * rather than escaping. A number, deliberately: the alternative is an
     * allowlist of hrefs, and that list is the hand-maintained thing this
     * whole function exists to abolish.
     */
    const outside = (html.match(/href="/g) ?? []).length - paths.length
    expect(
      outside,
      'a link appeared in the rail outside its nav — the logo and the plan strip are the ' +
        'only two that belong there. If it is a destination, it needs a `currentItem` ' +
        'branch and a place in the nav; if it is not, widen this count and say why',
    ).toBe(2)

    return paths
  }

  it('gives every destination the rail offers its own answer', () => {
    const paths = railPaths()
    const marked = paths.map(currentItem)
    expect(
      new Set(marked).size,
      `two rail destinations mark the same item: ${paths
        .map((path, index) => `${path}→${marked[index]}`)
        .join(' · ')}`,
    ).toBe(paths.length)
    // None of them may be unmarkable either: `undefined` is the sign-in page's
    // answer and no rail entry leads there.
    expect(marked.filter((id) => id === undefined)).toEqual([])
  })
})

describe('D22 — three entries, three destinations', () => {
  /**
   * The card's whole point. Before the split, "Minha empresa", "Plano e
   * pagamento" and "Perfil" all pointed at `/conta`: a reader tapping "Plano e
   * pagamento" arrived on a page headed "Sua conta", and the three entries
   * were indistinguishable once there.
   *
   * Giving items an `id` stopped the highlight bug. It did not stop three
   * labels leading to one room — that is what this asserts.
   */
  it.each([
    ['/conta', 'profile'],
    ['/conta/empresa', 'company'],
    ['/conta/plano', 'billing'],
    ['/conta/alertas', 'alerts'],
    ['/conta/favoritos', 'favourites'],
  ])('%s marks %s', (pathname, expected) => {
    expect(currentItem(pathname)).toBe(expected)
  })

  it('gives every account route a different answer', () => {
    // `startsWith` is prefix matching, and `/conta` is a prefix of all of
    // them. Longest match first is what makes this true; reorder those lines
    // and `/conta/plano` becomes the profile.
    //
    // **This list is hand-written and that is what let D23's entry through** —
    // `/conta/favoritos` was missing here for days and the set stayed
    // distinct because the path it collided with was not in it either. The
    // guard that cannot drift is `gives every destination the rail offers its
    // own answer` above, which reads the paths out of the rendered rail; this
    // one stays as the readable statement of the prefix order.
    const marked = [
      '/conta',
      '/conta/empresa',
      '/conta/plano',
      '/conta/alertas',
      '/conta/favoritos',
    ].map(currentItem)
    expect(new Set(marked).size).toBe(marked.length)
  })
})
