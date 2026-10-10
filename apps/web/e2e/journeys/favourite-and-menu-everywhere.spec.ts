import { expect, test, type Page } from '@playwright/test'
import { editalPath, priceHref, screeningHref } from '../../lib/radar/client'
import { installRadarApi } from '../fixtures/radar-api'
import { MARTA, tender } from '../fixtures/world'

/**
 * **D85 — the star on every tender screen, and the hamburger only where it
 * opens something.** Sci, 2026-10-10, with screenshots of the triagem and the
 * price screen: *"The customer must be able to favorite it in each part,
 * because he is validating the information"* and *"this hamburger menu in
 * desktop doesn't work"*.
 *
 * Both are invisible to the unit suite by construction (CLAUDE.md §4c). The
 * star renders nothing until its `GET` answers, and `renderToStaticMarkup`
 * runs no effect; and the hamburger's fault was layout — the shell wraps the
 * drawer in `lg:hidden`, so from 1024px the button set `open` on something
 * never painted. Each is asked here the only way that means anything: press
 * the star and see it stick across screens; look for the hamburger at a
 * desktop width and find none, and the rail standing in for it.
 */

const EDITAL = '11546530000156-1-000027/2026'
const SEARCH = { cnpj: MARTA.cnpj }
const MENU = 'Abrir menu'

async function world(page: Page) {
  return installRadarApi(page, {
    companies: [{ company: MARTA.company, tenders: [tender({ id: EDITAL })] }],
  })
}

const OPPORTUNITY = `${editalPath(EDITAL)}?cnpj=${MARTA.cnpj}`
const SCREENS: readonly { name: string; href: string }[] = [
  { name: 'o edital', href: OPPORTUNITY },
  { name: 'a triagem', href: screeningHref(EDITAL, SEARCH) },
  { name: 'o preço', href: priceHref(EDITAL, SEARCH) },
]

test.describe('D85 · Favoritar from every tender screen', () => {
  for (const screen of SCREENS.slice(1)) {
    test(`on ${screen.name}, the star marks the edital and the edital screen agrees`, async ({
      page,
    }) => {
      const api = await world(page)
      await page.goto(screen.href)

      const star = page.getByRole('button', { name: 'Favoritar', exact: true })
      await expect(star).toBeVisible()
      await expect(star).toHaveAttribute('aria-pressed', 'false')

      await star.click()

      const marked = page.getByRole('button', { name: 'Favoritado', exact: true })
      await expect(marked).toHaveAttribute('aria-pressed', 'true')
      // The write went to the server, not only to this component's state.
      expect(api.favourites?.has(EDITAL)).toBe(true)

      // And a different screen reads it back as marked, which is the point:
      // one mark, wherever it was made.
      await page.goto(OPPORTUNITY)
      await expect(page.getByRole('button', { name: 'Favoritado', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
    })
  }

  test('opening a tender screen does not mark it', async ({ page }) => {
    // The fixture's `GET` used to toggle, so the star's first read marked the
    // edital. Visiting every screen and finding it still unmarked is what
    // proves reading is only reading.
    const api = await world(page)
    for (const screen of SCREENS) {
      await page.goto(screen.href)
      await expect(page.getByRole('button', { name: 'Favoritar', exact: true })).toBeVisible()
    }
    expect(api.favourites?.has(EDITAL)).toBe(false)
  })
})

test.describe('D85 · no hamburger on a desktop, where the rail is the menu', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
  })

  for (const screen of [...SCREENS, { name: 'o Radar', href: `/radar?cnpj=${MARTA.cnpj}` }]) {
    test(`on ${screen.name}, the rail is there and the hamburger is not`, async ({ page }) => {
      await world(page)
      await page.goto(screen.href)

      // The rail's own entry, so the menu is still reachable — and asked
      // first, so the zero below cannot be a page that never rendered.
      await expect(page.getByRole('link', { name: 'Favoritos' })).toBeVisible()
      await expect(page.getByRole('button', { name: MENU })).toBeHidden()
    })
  }

  test('at 1023px, one below the rail, the hamburger is back and opens the drawer', async ({
    page,
  }) => {
    // The boundary on the other side: `lg:hidden` must not take the only menu
    // away from the widths where the rail does not exist.
    await page.setViewportSize({ width: 1023, height: 900 })
    await world(page)
    await page.goto(screeningHref(EDITAL, SEARCH))

    await page.getByRole('button', { name: MENU }).click()
    await expect(page.getByRole('link', { name: 'Favoritos' })).toBeVisible()
  })
})
