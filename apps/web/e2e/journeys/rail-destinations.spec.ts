import { expect, test, type Locator, type Page } from '@playwright/test'
import { messages } from '@/lib/messages'
import { installRadarApi } from '../fixtures/radar-api'
import { CARLA, tenderRun } from '../fixtures/world'

/**
 * **D22's acceptance, held as an invariant** — the half of it that needs no
 * session, in the hermetic lane that actually runs on every PR.
 *
 * Sci asked two questions of `/conta`, signed in, on 2026-09-29: *"who is
 * me?"* and *"why are these links here if they are in the side panel?"* The
 * decision that answers them is recorded in D22 and its acceptance is one
 * sentence:
 *
 * > Each nav entry leads somewhere that differs from the others, or the menu
 * > has as many entries as it has destinations; `currentItem` needs no special
 * > case for a tie.
 *
 * `/conta/empresa` and `/conta/plano` shipped, so that sentence is **true
 * today** and the job of this file is to keep it true. The rest of the
 * acceptance — the identity on `/conta`, and the page not repeating the rail —
 * needs a session and a database, so it lives in `e2e/accounts/`, where the
 * project that has those runs.
 *
 * ## Why these three can be hermetic at all
 *
 * The rail is not a signed-in feature. `app/radar/layout.tsx` wraps
 * **everybody** — deliberately, because `/radar` is usable without an account
 * and `MenuView` draws the visitor strip on purpose — and `MAIN`/`ACCOUNT` in
 * `menu-view.tsx` are module constants, so a visitor on `/radar` is shown the
 * same six entries a subscriber is. What a visitor cannot do is *follow* four
 * of them: `readAccountData` redirects a signed-out caller to `/conta/criar`,
 * so four of the six would resolve to one URL here for a reason that has
 * nothing to do with the menu. **That is the one thing this file does not
 * assert and `e2e/accounts/conta-destinations.spec.ts` does**: distinctness is
 * checked here at the `href` the rail renders, and there at the URL the browser
 * lands on.
 *
 * ## Why Playwright and not `app-shell.test.tsx`
 *
 * `components/app-shell.test.tsx` already pins the **mechanism** — `currentItem`
 * over six paths, and exactly one `aria-current="page"` in the string
 * `renderToStaticMarkup` produces. It cannot see either of the things below,
 * both for CLAUDE.md §4c's reasons. The collapsed rail is `localStorage`
 * through `useSyncExternalStore`, which `environment: 'node'` never reads; and
 * the widths are boxes, which that suite has none of. Mechanism there, result
 * here, and this comment is the §4c statement of which is which.
 *
 * ## The width arithmetic, measured rather than remembered
 *
 * At a **1024px** window — the exact width at which `lg:` puts the rail in the
 * layout flow — measured on 2026-10-08:
 *
 * | | rail | content column |
 * |---|---|---|
 * | expanded | 264px | 760px |
 * | collapsed | 56px | 968px |
 *
 * Those two are the **column** — the box the rail leaves beside itself — and
 * they are what is asserted here, as *window minus rail* rather than as
 * literals, because the fact under test is that the rail is in the layout flow
 * and never over the content.
 *
 * **The content box is a different number, it is per screen, and this file does
 * not claim one.** The 720px CLAUDE.md's container-query rule is written around
 * is the *tender* screen's: `opportunity-view.tsx` caps its column at
 * `max-w-[960px]` and spends `px-gutter` (20px a side, `styles/tokens.css`), so
 * 760 uncapped → 720, and 968 capped to 960 → 920. Those two are **derived from
 * those classes**, not measured — `e2e/journeys/tender-columns.spec.ts` carries
 * them in its prose and asserts a *boolean* (whether two blocks sit side by
 * side), never a width. Saying so is the point: an arithmetic result described
 * as a measurement is §4d's defect, and it would be a poor paragraph to commit
 * in the file whose job is to measure things.
 *
 * **Nothing below depends on either number.** What is asserted here was read
 * off a running browser at 1024×900 on 2026-10-08 and is re-read on every run.
 *
 * One assumption worth naming, because it is inferred and not measured: these
 * widths require `documentElement.clientWidth` to be the full 1024, i.e. no
 * classic scrollbar inside the viewport. That holds in the headless Chromium
 * this project runs (overlay scrollbars) and is what the rest of the suite
 * already relies on. A `--headed` debugging run on a platform with gutter
 * scrollbars would redden the three width assertions for a reason that has
 * nothing to do with the rail; if that ever happens, the fix is to assert the
 * column against `clientWidth` rather than against the literal.
 */

const menu = messages.radar.menu

/**
 * The window where the rail exists at all, and the narrowest one: `lg` is
 * 1024px and `hidden lg:block` means 1023px has no rail to measure.
 */
const WINDOW = { width: 1024, height: 900 } as const

test.use({ viewport: WINDOW })

/** How wide the rail is in each state — `w-[264px]` / `w-[56px]`. */
const RAIL = { expanded: 264, collapsed: 56 } as const

/** `components/app-shell.tsx`'s `COLLAPSED_KEY`. */
const COLLAPSED_KEY = 'licitaqui.rail.collapsed'

/**
 * The rail's own nav.
 *
 * Scoped, and that is load-bearing twice over. The `<aside>` also holds the
 * logo link and the plan strip's "assinar" link, neither of which is a nav
 * entry; and `aria-current="page"` is spent **three times** on a rendered
 * `/radar` — the rail entry, the active group chip in `radar-view.tsx:370`,
 * and the item picker's — so a document-wide count would be asserting on three
 * unrelated decisions at once and would pass with the rail's own marking gone.
 *
 * `exact: true` on the name: Playwright matches `name` as a **substring**,
 * which is how D56's own e2e came to require the bug it was written to catch.
 */
function rail(page: Page): Locator {
  return page.getByRole('complementary', { name: menu.title, exact: true })
}

function railNav(page: Page): Locator {
  return rail(page).getByRole('navigation')
}

/**
 * Where the rail sits and how much room it left the content beside it.
 *
 * Measured **from the same locator the rest of the file asserts on** — the
 * landmark with the menu's name — rather than from a `querySelector` of its
 * own. Two selectors for one element is how a test comes to measure something
 * other than the thing it is asserting about, and the column is then reached as
 * that element's next sibling, which is the layout relationship under test
 * (`<aside>` and `<div class="min-w-0 grow">` are siblings in `app-shell.tsx`).
 */
async function boxes(page: Page): Promise<{ rail: number; column: number; overflow: number }> {
  return rail(page).evaluate((aside) => {
    const column = aside.nextElementSibling
    const round = (el: Element | null) => (el ? Math.round(el.getBoundingClientRect().width) : -1)
    return {
      rail: round(aside),
      column: round(column),
      // Positive means the page scrolls sideways — D29's defect as a number.
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }
  })
}

/**
 * A destination, as the path **and the query**.
 *
 * Not the pathname alone, and the difference is a defect this file had: the
 * Radar's active group chip is `radarHref({ …query, group })`
 * (`radar-view.tsx:370`), so its pathname is `/radar` — the same as the rail's
 * Radar entry. Compared by pathname, the chip's `aria-current` counted as the
 * rail's, and the tripwire below reported two markings for one page. None of
 * the six rail entries carries a query, so `search` is what tells them apart
 * from everything else on the screen that happens to live under the same path.
 */
function address(href: string): string {
  const url = new URL(href)
  return `${url.pathname}${url.search}`
}

/**
 * The destinations the **expanded** rail offers, read from the expanded rail.
 *
 * Taken in the same test that then collapses it, rather than written down here,
 * so the collapsed assertions are about whatever the rail currently offers and
 * cannot drift from it.
 */
async function expandedDestinations(page: Page): Promise<string[]> {
  await radar(page)
  const hrefs = await railNav(page)
    .getByRole('link')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLAnchorElement).href))
  const paths = [...new Set(hrefs.map(address))]
  expect(paths.length, 'the expanded rail offered its destinations to read').toBeGreaterThanOrEqual(
    6,
  )
  return paths
}

/**
 * Which of those destinations a reader can reach **without opening anything** —
 * anywhere on the page, not only in the rail.
 *
 * This is D20's acceptance as a function, and the scope is the point. Scoped to
 * the rail it would answer "none" under any remedy that moved the entries
 * somewhere else, so a tripwire built on it could not be tripped by the fix it
 * was waiting for. A link inside a closed `Sheet` is not visible, so a drawer
 * does not satisfy it either — which is correct: a drawer must be opened.
 */
async function reachable(page: Page, destinations: string[]): Promise<string[]> {
  const found: string[] = []
  for (const path of destinations) {
    const links = page.locator(`a[href="${path}"]`)
    const total = await links.count()
    for (let index = 0; index < total; index += 1) {
      if (await links.nth(index).isVisible()) {
        found.push(path)
        break
      }
    }
  }
  return found
}

/** Her cleaning client, with enough editais that the list is a real one. */
async function radar(page: Page, collapsed = false): Promise<void> {
  if (collapsed) {
    await page.addInitScript(
      ([key]) => {
        try {
          window.localStorage.setItem(key, '1')
        } catch {
          // Blocked site data. The test below will see the expanded rail and
          // say so, which is the right failure rather than a silent pass.
        }
      },
      [COLLAPSED_KEY] as const,
    )
  }
  await installRadarApi(page, {
    companies: [{ company: CARLA.limpeza.company, tenders: tenderRun(4), cnaeCount: 4 }],
    cookieCnpj: CARLA.limpeza.cnpj,
  })
  await page.goto('/radar')
  // The rail is server-rendered on `/radar`, so this is a condition and not a
  // wait: it is either in the first paint or the test has found something.
  await expect(rail(page)).toBeVisible()
}

test.describe('D22 · every rail entry leads somewhere different', () => {
  test('the six entries resolve to six distinct destinations', async ({ page }) => {
    await radar(page)

    const entries = railNav(page).getByRole('link')
    const count = await entries.count()

    /**
     * **A floor, not the contract.** The assertion that matters is the set
     * equality below, and an empty nav satisfies it for free — `new Set([]).size
     * === 0 === [].length`. So the count is pinned above the six entries that
     * exist today, which is what makes a nav that stopped rendering a failure
     * here rather than a pass.
     */
    expect(count, 'the rail renders its entries').toBeGreaterThanOrEqual(6)

    /**
     * `.href` and not `getAttribute('href')`: the DOM property is the address
     * **resolved** against the document, which is what "leads somewhere" means
     * and what makes `/conta` and `/conta/` one destination rather than two.
     *
     * Derived from the rendered rail, never from a list in this file. A seventh
     * entry pointing at a page one of the six already reaches fails this test
     * with nobody editing it — which is the state D22 was carded from, where
     * three labels shared `/conta`.
     */
    const hrefs = await entries.evaluateAll((nodes) =>
      nodes.map((node) => (node as HTMLAnchorElement).href),
    )

    expect(
      new Set(hrefs).size,
      `two rail entries lead to the same place (D22): ${hrefs.join(' · ')}`,
    ).toBe(count)
  })

  test('exactly one entry is marked current, and it is the page we are on', async ({ page }) => {
    await radar(page)

    /**
     * One, not three. Marking by `href` lit "Minha empresa", "Plano e
     * pagamento" and "Perfil" at once the moment D20 put the menu on `/conta`,
     * and the `id` that stopped the highlight did not stop three labels leading
     * to one room — which is the whole of D22.
     */
    await expect(
      railNav(page).locator('[aria-current]'),
      'exactly one rail entry is the page the reader is on',
    ).toHaveCount(1)

    /**
     * And it is the **right** one. Without this the test passes on any single
     * marking, including a wrong one, and a `currentItem` that always answered
     * `'alerts'` would be green on `/radar`.
     */
    const marked = railNav(page).locator('[aria-current]')
    expect(
      new URL(await marked.evaluate((node) => (node as HTMLAnchorElement).href)).pathname,
      'the marked rail entry is the page the browser is actually on',
    ).toBe('/radar')
    await expect(marked).toHaveAccessibleName(menu.radar)
  })
})

test.describe('D20/D22 · the rail is beside the content in both of its states', () => {
  test('expanded: 264px of rail, the rest to the content, nothing sideways', async ({ page }) => {
    await radar(page)

    const measured = await boxes(page)
    expect(measured.rail, 'the expanded rail is `w-[264px]`').toBe(RAIL.expanded)
    /**
     * *"the side panel didnt should block the main page"* — Sci, 2026-09-29,
     * which is the sentence D20 exists to satisfy. A rail **in the layout
     * flow** leaves the content exactly the window minus itself; one drawn
     * over the content would leave it the whole window. 1024 − 264 = 760; what
     * the screen then makes of that is its own gutter's business, and
     * `tender-columns.spec.ts` is where it is measured.
     */
    expect(measured.column, 'the content column is the window minus the rail').toBe(
      WINDOW.width - RAIL.expanded,
    )
    expect(measured.overflow, 'the page must not scroll sideways at 1024px').toBeLessThanOrEqual(0)

    await expect(railNav(page).locator('[aria-current]')).toHaveCount(1)
  })

  test('collapsed: 56px of rail, the rest to the content, nothing sideways', async ({ page }) => {
    await radar(page, true)

    const measured = await boxes(page)
    expect(
      measured.rail,
      'the collapsed rail is `w-[56px]` — and this is the assertion that proves ' +
        'the localStorage state was read at all, which no media query could observe',
    ).toBe(RAIL.collapsed)
    // 1024 − 56 = 968.
    expect(measured.column).toBe(WINDOW.width - RAIL.collapsed)
    expect(measured.overflow, 'the page must not scroll sideways at 1024px').toBeLessThanOrEqual(0)
  })

  /**
   * **Expected to fail, and Playwright enforces that it does.**
   *
   * Collapsing the rail does not narrow the navigation — it **unmounts** it.
   * `app-shell.tsx` renders `{collapsed ? null : <MenuView …/>}`, and the
   * drawer that would otherwise carry the same entries is `lg:hidden`. So at
   * 1024px with the rail collapsed there are **zero** nav entries and **zero**
   * `aria-current` on the page: measured 0 and 0 on 2026-10-08, against 6 and 1
   * expanded.
   *
   * That is D20's own acceptance — *"the strip is reachable from every
   * signed-in route without opening anything at `lg` and up"* — and Sci's
   * instruction for the collapse was explicitly *"Collapsed still means
   * present"*. Carded as **D77**; whether the answer is icon-only entries, a
   * drawer above `lg`, or a deliberate ruling that a collapsed rail is a
   * reader's own choice, is Sci's.
   *
   * `test.fail()` rather than a comment or a skip: Playwright **runs** this and
   * requires it to fail, so the assertion is proved against today's behaviour
   * on every CI run, and the day it starts passing the suite goes red and tells
   * somebody to delete this annotation. A skipped test would prove nothing and
   * an absent one would leave the finding in prose.
   *
   * **And `test.fail` on its own is not enough, which is why the test above it
   * exists.** The annotation is satisfied by *any* failure in the body — the
   * fixture throwing, `/radar` answering 500, an expect timing out, a strict-mode
   * violation, or the `localStorage` write being refused so the rail is never
   * collapsed at all (`radar()` swallows that deliberately). So this one cannot
   * say *why* it failed, and the number in D77's card would be prose. The
   * counterpart pins the two counts positively, in a test that must pass; this
   * one is the tripwire that reddens the day they change.
   */
  test('collapsed: D77’s two counts, as they are today', async ({ page }) => {
    const destinations = await expandedDestinations(page)

    await radar(page, true)
    expect((await boxes(page)).rail, 'the rail really is collapsed').toBe(RAIL.collapsed)

    /**
     * **Not an endorsement — a measurement.** These are the numbers D77 quotes,
     * read off a browser rather than reasoned about, so the card cannot drift
     * from the behaviour and the `test.fail` below has a verified reason.
     *
     * Expanded, the same locators give 6 and 1 (asserted above). Collapsed they
     * give 0 and 0, because `app-shell.tsx` renders `null` rather than a
     * narrower nav and the drawer that would carry the same entries is
     * `lg:hidden`. The day D77 is answered, these go red — which is exactly
     * what should happen to a test that records a defect.
     */
    await expect(
      railNav(page).getByRole('link'),
      'D77: a collapsed rail unmounts its entries rather than narrowing them',
    ).toHaveCount(0)
    await expect(
      railNav(page).locator('[aria-current]'),
      'D77: and with them goes the only thing saying which page the reader is on',
    ).toHaveCount(0)

    /**
     * And **nothing anywhere else on the page** replaced them, which is the
     * half that makes this a D20 failure rather than a styling choice: at this
     * width the drawer is `lg:hidden`, so the six destinations are not merely
     * out of the rail, they are off the screen.
     */
    expect(
      (await reachable(page, destinations)).sort(),
      'D77: of the six, only Alertas survives a collapsed rail — the bell in the app bar',
    ).toEqual(['/conta/alertas'])
  })

  /**
   * **The tripwire, and it is deliberately NOT scoped to the rail.**
   *
   * The first version of this was `railNav(page).getByRole('link')` — and a
   * review found that D77's own option (b), moving the entries to a drawer or
   * anywhere else on the page, would close the card while that locator still
   * resolved to zero. The test would have gone on "failing" as expected, the
   * suite would never have reddened, and the finding would have died quietly:
   * a tripwire that cannot be tripped by the fix it is waiting for.
   *
   * So what is asserted is **D20's acceptance in its own words** — *"reachable
   * from every signed-in route without opening anything at `lg` and up"* —
   * against the destinations the expanded rail actually offers, read from the
   * expanded rail in the same test. Every one of D77's three candidate answers
   * changes this result: icon-only entries in the 56px column make it pass, a
   * drawer leaves it failing (a drawer must be opened, so that remedy does not
   * meet the acceptance and the card says so), and a ruling that it is the
   * reader's own choice means deleting this test rather than leaving it green
   * on a failure it no longer describes.
   */
  test.fail(
    'collapsed: the destinations are still reachable and one is still marked — D77',
    async ({ page }) => {
      const destinations = await expandedDestinations(page)

      await radar(page, true)
      expect((await boxes(page)).rail, 'the rail really is collapsed').toBe(RAIL.collapsed)

      expect(
        (await reachable(page, destinations)).sort(),
        'a collapsed rail still offers every destination (D20: collapsed means present)',
      ).toEqual([...destinations].sort())

      /**
       * And one of **those** destinations is marked — not merely some
       * `aria-current` somewhere, which `/radar`'s own group chips already
       * spend and which would make this assertion true while the nav is gone.
       */
      const markedDestinations = (
        await page
          .locator('[aria-current="page"]')
          .evaluateAll((nodes) =>
            nodes
              .filter((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement)
              .map((node) => node.href),
          )
      ).map(address)
      expect(
        markedDestinations.filter((path) => destinations.includes(path)),
        'and something still says which of the destinations the reader is on',
      ).toHaveLength(1)
    },
  )
})
