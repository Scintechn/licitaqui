import { expect, test, type Page } from '@playwright/test'
import { editalPath, priceHref, screeningHref } from '../../lib/radar/client'
import { installRadarApi } from '../fixtures/radar-api'
import { MARTA, tender } from '../fixtures/world'

/**
 * **The menu, on the screens where a person actually spends time** — card
 * **D24**, half 2.
 *
 * ## What was wrong
 *
 * `useAppMenu` and `MenuTrigger` rendered in `radar-screen.tsx` and
 * `account-chrome.tsx` and nowhere else. The three tender screens —
 * `opportunity-view.tsx`, `screening-view.tsx`, `price-view.tsx` — each drew
 * their own `AppBar`, and `AppBar` renders nothing it is not handed.
 *
 * Above `lg` that was invisible: `app/radar/layout.tsx` wraps every Radar
 * route in `AppShell`, so the rail was there. **Below `lg` the rail is
 * `hidden`**, and the drawer is the only form the menu has — so opening an
 * edital on a phone took the menu away and left *Voltar* as the only way out.
 * Sci's journey note: *"Humburger menu should be able to access"*.
 *
 * D20 shipped on 2026-09-29 with *"reachable from every signed-in route …
 * from one tap below it"* in its acceptance. It was asked about two routes.
 * There are five.
 *
 * ## Why these run here and could not run in vitest
 *
 * This is D20's own lesson arriving one screen along. #93 shipped the drawer,
 * its API, its view and its tests while **the button did not** — because
 * `menu-view.test.tsx` rendered the component and never asked whether anything
 * could reach it. `app-shell.test.tsx` cured that by asserting a reachable
 * path, and it asserts two.
 *
 * `vitest.config.mts` is `environment: 'node'`: it cannot click a button, run
 * an effect or open a drawer. A unit test here could only assert that
 * `<MenuTrigger />` appears in some tree, which is the assertion that was
 * already passing while the button was unreachable. So the question these ask
 * is the only one worth asking — **can a person on a phone open the menu from
 * this screen** — and they ask it by opening it.
 *
 * The `journeys` project's viewport is 390px (`playwright.config.ts`), which
 * is below `lg` and therefore the width where the rail is gone.
 */

const EDITAL = '11546530000156-1-000027/2026'
const SEARCH = { cnpj: MARTA.cnpj }
const MENU = 'Abrir menu'

async function world(page: Page) {
  return installRadarApi(page, {
    companies: [{ company: MARTA.company, tenders: [tender({ id: EDITAL })] }],
  })
}

/** The three addresses, all served by the one `[...id]` catch-all. */
const SCREENS: readonly { name: string; href: string }[] = [
  { name: 'o edital', href: `${editalPath(EDITAL)}?cnpj=${MARTA.cnpj}` },
  { name: 'a triagem', href: screeningHref(EDITAL, SEARCH) },
  { name: 'o preço', href: priceHref(EDITAL, SEARCH) },
]

test.describe('D24 · the menu is reachable from every tender screen', () => {
  for (const screen of SCREENS) {
    test(`on ${screen.name}, a phone can open the menu`, async ({ page }) => {
      await world(page)
      await page.goto(screen.href)

      // The button has to exist *and* do something. Asserting only that it
      // renders would repeat #93's mistake in a browser instead of in Node.
      const trigger = page.getByRole('button', { name: MENU })
      await expect(trigger).toBeVisible()

      await trigger.click()

      // The drawer is open when its own navigation is on screen. `Favoritos`
      // is the entry that exists nowhere else in this chrome, so finding it
      // means the menu and not some other list.
      await expect(page.getByRole('link', { name: 'Favoritos' })).toBeVisible()
    })
  }

  test('the trigger is inert where there is no shell around it', async ({ page }) => {
    // `MenuTrigger` returns null outside a shell, which is what keeps the
    // Landing's example `RadarView` from drawing a hamburger that opens
    // nothing. The Landing is public and has no `AppShell`.
    await page.goto('/')
    await expect(page.getByRole('button', { name: MENU })).toHaveCount(0)
  })
})
