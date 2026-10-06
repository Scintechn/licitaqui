import { expect, test, type Locator, type Page } from '@playwright/test'
import { messages } from '@/lib/messages'
import { installRadarApi, type RadarApi } from '../fixtures/radar-api'
import { cards } from '../fixtures/screen'
import { MARTA, processo, tenderRun } from '../fixtures/world'

/**
 * **Dona Marta marks an edital from the list, and it is still marked when she
 * comes back** — card D23's second half.
 *
 * ## Why this is a browser test and not a unit one
 *
 * Everything that matters here is invisible to `vitest` **by construction**
 * (CLAUDE.md §4c). `environment: 'node'` has no jsdom: nothing clicks, no
 * `useEffect` runs, and there are no rectangles. So the unit suite
 * (`app/radar/favourite-on-card.test.tsx`) pins the **mechanism** — the control
 * is outside the anchor, the top row reserves 36px — and this file pins the
 * **result**:
 *
 *  - pressing the star marks the tender, and the request that carries it leaves;
 *  - the state survives a reload, which is where the list snapshot is doing the
 *    work: inside a minute the Radar restores from `sessionStorage` and asks for
 *    **nothing**, so a star rebuilt from the network would come back empty;
 *  - tapping the star does **not** open the edital, which is the one failure the
 *    placement exists to prevent and the one a string assertion cannot see;
 *  - a visitor is told rather than ignored.
 *
 * ## Which numbers come from where
 *
 * The seeded state is the list envelope's `favourites` — the same field
 * `listTenders` projects — so the screen is asserted, never the fixture's
 * bookkeeping: the world toggles on the `POST` exactly as the route does.
 */

const copy = messages.radar.favourites
const CNPJ = MARTA.cnpj
const LIST = `/radar?cnpj=${CNPJ}&group=compatible`

/** The three cards' ids, in the order `tenderRun` numbers them. */
const ID = (n: number) => `51885242000140-1-${String(n).padStart(6, '0')}/2026`

function star(page: Page, label: string): Locator {
  return page.getByRole('button', { name: label })
}

/**
 * The star on the card for one process number — the way a reader finds it.
 *
 * Scoped by the `<li>` the list already puts every card in, not by the wrapper
 * this card introduced: a selector naming my own class would pass whatever the
 * markup became. The process number is how `screen.ts`'s `card()` finds one card
 * among sixty, and it survives the de-shouting rule verbatim.
 */
function starOn(page: Page, n: number, label: string): Locator {
  return page
    .locator('li')
    .filter({ hasText: processo(n) })
    .getByRole('button', { name: label })
}

async function world(page: Page, marked: string[] = []): Promise<RadarApi> {
  const api = await installRadarApi(page, {
    companies: [{ company: MARTA.company, tenders: tenderRun(3) }],
  })
  api.favourites = new Set(marked)
  return api
}

test.describe('D23 · Favoritar, from the Radar list', () => {
  test('marks an edital from the list, and the star says so', async ({ page }) => {
    const api = await world(page)
    await page.goto(LIST)
    await expect(cards(page).first()).toBeVisible()

    // Three cards, three stars, none of them marked, and no request was spent
    // finding that out: it came back with the rows.
    await expect(star(page, copy.add)).toHaveCount(3)
    expect(api.calls.favourite, 'nothing is fetched on mount').toEqual([])

    await starOn(page, 2, copy.add).click()

    await expect(starOn(page, 2, copy.added)).toBeVisible()
    expect(api.favourites, 'the row the route would have written').toEqual(new Set([ID(2)]))
    expect(api.calls.favourite).toHaveLength(1)
    // The other two are untouched: a toggle on one card is not a toggle on the list.
    await expect(star(page, copy.add)).toHaveCount(2)
  })

  test('the tap does not open the edital — the star is beside the link, not in it', async ({
    page,
  }) => {
    await world(page)
    await page.goto(LIST)
    await expect(cards(page).first()).toBeVisible()

    await starOn(page, 1, copy.add).click()
    await expect(starOn(page, 1, copy.added)).toBeVisible()

    // Still the list. A `<button>` inside the card's `<a>` would have navigated
    // here, and every assertion in the unit suite would still have passed.
    expect(new URL(page.url()).pathname).toBe('/radar')
    await expect(cards(page).first()).toBeVisible()
  })

  test('comes back marked after a reload, from the snapshot and no request', async ({ page }) => {
    const api = await world(page)
    await page.goto(LIST)
    await expect(cards(page).first()).toBeVisible()

    await starOn(page, 3, copy.add).click()
    await expect(starOn(page, 3, copy.added)).toBeVisible()

    const before = api.calls.tenders.length
    await page.reload()
    await expect(cards(page).first()).toBeVisible()

    // The star survived, and the list did not go back to the route for it: under
    // a minute old, `restoreList` returns the snapshot and nothing is fetched.
    // So this is the snapshot's `favourites` and nothing else could have
    // supplied it.
    await expect(starOn(page, 3, copy.added)).toBeVisible()
    await expect(star(page, copy.add)).toHaveCount(2)
    expect(api.calls.tenders.length, 'a fresh snapshot asks for nothing').toBe(before)
  })

  test('shows a mark made on another device, because it rides with the rows', async ({ page }) => {
    // Nothing was pressed in this browser: the state came back in the envelope,
    // which is what "one read" buys — the list and its stars cannot disagree.
    const api = await world(page, [ID(2)])
    await page.goto(LIST)
    await expect(cards(page).first()).toBeVisible()

    await expect(starOn(page, 2, copy.added)).toBeVisible()
    await expect(star(page, copy.add)).toHaveCount(2)
    expect(api.calls.favourite).toEqual([])
  })

  test('unmarks again, and the star goes back to Favoritar', async ({ page }) => {
    const api = await world(page, [ID(1)])
    await page.goto(LIST)
    await expect(starOn(page, 1, copy.added)).toBeVisible()

    await starOn(page, 1, copy.added).click()

    await expect(starOn(page, 1, copy.add)).toBeVisible()
    expect(api.favourites).toEqual(new Set())
  })

  test('a visitor is told, not ignored, and the star reverts', async ({ page }) => {
    // `POST /api/tenders/:id/favorito` is the only Radar route that refuses a
    // caller outright: a favourite is a row keyed on `users.id` and there is
    // nowhere to put one. The star says so rather than appearing to have worked.
    const api = await world(page)
    api.favourites = null

    await page.goto(LIST)
    await expect(cards(page).first()).toBeVisible()

    // The star is drawn for a visitor too — §8's rule is that an account adds
    // capability, and a control that is simply absent teaches nobody anything.
    await starOn(page, 1, copy.add).click()

    await expect(starOn(page, 1, copy.signedOut)).toBeVisible()
    // Reverted: nothing was stored, so nothing may claim it was.
    await expect(star(page, copy.added)).toHaveCount(0)
  })

  /**
   * The reserved space, measured.
   *
   * `tender-card.tsx` derives 36px twice — `pr-9` from 6 + 44 − 14 and
   * `min-h-9` from 50 − 14 — and the unit suite pins those two classes. It
   * cannot pin what they are for: there are no boxes in `environment: 'node'`,
   * so a card that drew the star straight through the countdown would pass
   * every assertion over there. This is the only place the rectangles exist.
   */
  test('does not cover the countdown or the title — the reserved 36px, measured', async ({
    page,
  }) => {
    await world(page)
    await page.setViewportSize({ width: 390, height: 900 })
    await page.goto(LIST)
    await expect(cards(page).first()).toBeVisible()

    const row = page.locator('li').filter({ hasText: processo(1) })
    const box = async (locator: Locator) => {
      const found = await locator.boundingBox()
      expect(found, 'the element is drawn').not.toBeNull()
      return found!
    }

    const control = await box(starOn(page, 1, copy.add))
    // The countdown is the top row's right-hand content: the one thing the star
    // is placed over the top of.
    const countdown = await box(row.getByText(/^\d+ dias?$/))
    const title = await box(row.getByText(processo(1)))

    const overlaps = (a: typeof control, b: typeof control) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

    expect(overlaps(control, countdown), 'the star is drawn over the countdown').toBe(false)
    expect(overlaps(control, title), 'the star is drawn over the title').toBe(false)
    // And it really is the 44px target the product promises, not a 22px glyph.
    expect(control.width).toBeGreaterThanOrEqual(44)
    expect(control.height).toBeGreaterThanOrEqual(44)
  })

  test('the star is one extra keyboard stop, after the card', async ({ page }) => {
    await world(page)
    await page.goto(LIST)
    await expect(cards(page).first()).toBeVisible()

    const first = cards(page).first()
    await first.focus()
    await page.keyboard.press('Tab')

    // The card is one stop for the whole tender and the star is the next one.
    // Nested interactive content would have made the order undefined.
    await expect(page.locator(':focus')).toHaveAttribute('aria-label', copy.add)
  })
})
