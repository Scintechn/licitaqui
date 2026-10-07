import { expect, test, type Locator, type Page } from '@playwright/test'
import { messages } from '@/lib/messages'
import { displayTitle } from '@/lib/radar/format'
import { installRadarApi, type RadarApi } from '../fixtures/radar-api'
import { cards } from '../fixtures/screen'
import { MARTA, processo, tenderRun } from '../fixtures/world'

/**
 * **Dona Marta presses a star and is answered** — cards **D56** and **D57**.
 *
 * ## Why every assertion here needs a browser
 *
 * Two things, and `environment: 'node'` can see neither of them (CLAUDE.md §4c):
 *
 *  - **the computed accessible name.** D57's whole subject is that twenty stars
 *    answered to one word. The fix composes a name out of two nodes with
 *    `aria-labelledby`, and *the markup is what passed before* — so an assertion
 *    on attributes proves nothing at all. Only a browser runs the accessible
 *    name computation, and `toHaveAccessibleName` is how it is read back.
 *  - **the announcement, and the sentence being on the screen.** D56's defect was
 *    that the refusal lived in an `aria-label` and a `title`: present to a
 *    pointer that hovers and to a screen reader that inspects, said to nobody.
 *    Nothing clicks in the unit suite, so nothing fails there.
 *
 * The wiring those two depend on — which nodes name the control, that the region
 * is in the DOM before it has anything to say, that it sits outside the list's
 * `@container` — is `app/radar/favourite-feedback.test.tsx`.
 *
 * ## Why the failures are forged here and not in the world
 *
 * `fixtures/radar-api.ts` models the route as it behaves: it answers 401 when
 * there is no account and 200 otherwise, which is the truth and is all the other
 * journeys need. A 429, a 500 and a dropped connection are not states the world
 * has — they are things the network does *to* a correct request. So they are
 * installed as a `page.route` over the top, after the fixture, because Playwright
 * runs the most recently added handler first.
 */

const copy = messages.radar.favourites
const common = messages.common
const CNPJ = MARTA.cnpj
const LIST = `/radar?cnpj=${CNPJ}&group=compatible`
const ROWS = tenderRun(3)

/** The star on the card for one process number, by the state it reports. */
function starOn(page: Page, n: number, marked = false): Locator {
  return page
    .locator('li')
    .filter({ hasText: processo(n) })
    .getByRole('button', { pressed: marked })
}

/** The one live region the list owns. */
function region(page: Page): Locator {
  return page.getByRole('status')
}

/**
 * Change the list's order, the way a reader does — a client navigation that
 * keeps the whole screen mounted.
 *
 * `from` is the order in effect, because `SortMenu`'s trigger is named after it
 * and its `<details>` is keyed on it, so it closes behind every choice.
 */
async function sortTo(
  page: Page,
  from: keyof typeof messages.radar.list.sortOrders,
  to: keyof typeof messages.radar.list.sortOrders,
): Promise<void> {
  const list = messages.radar.list
  await page.getByLabel(`${list.sort} ${list.sortOrders[from]}`).click()
  await page.getByRole('link', { name: `Ordenar por ${list.sortOrders[to]}` }).click()
  await expect(cards(page).first()).toBeVisible()
}

async function world(page: Page): Promise<RadarApi> {
  return installRadarApi(page, {
    companies: [{ company: MARTA.company, tenders: ROWS }],
  })
}

/**
 * Answer the next `POST .../favorito` with `status`, or drop the connection.
 *
 * Registered after `installRadarApi` so it takes precedence, and matched on the
 * full URL because the tender id is percent-encoded into the path.
 */
async function breakFavourite(page: Page, outcome: number | 'offline'): Promise<void> {
  await page.route(/\/favorito(\?|$)/, async (route) => {
    if (outcome === 'offline') return route.abort('failed')
    await route.fulfill({
      status: outcome,
      contentType: 'application/json',
      body: JSON.stringify({ state: 'error', error: 'forged' }),
    })
  })
}

test.describe('D57 · each star names its own edital', () => {
  /**
   * The acceptance criterion, verbatim: *the computed name, for three different
   * cards*.
   *
   * The expected text is built from `displayTitle` — the same function the card
   * draws its title with — so this asserts that the name **is the title on the
   * screen**, rather than asserting a sentence typed twice.
   */
  test('reads the action and then the edital, computed, on three cards', async ({ page }) => {
    await world(page)
    await page.goto(LIST)
    await expect(cards(page).first()).toBeVisible()

    const names: string[] = []
    for (const [index, row] of ROWS.entries()) {
      const star = starOn(page, index + 1)
      const expected = `${copy.add} ${displayTitle(row)}`
      await expect(star).toHaveAccessibleName(expected)
      names.push(expected)
    }

    // Three stars, three names. This is the assertion the old spec could not
    // make: it counted `name: 'Favoritar'` and *required* the three to agree.
    expect(new Set(names).size, 'three distinct accessible names').toBe(3)
  })

  test('says Favoritado and still names the edital once it is marked', async ({ page }) => {
    await world(page)
    await page.goto(LIST)
    await expect(cards(page).first()).toBeVisible()

    await starOn(page, 2).click()
    await expect(starOn(page, 2, true)).toHaveAccessibleName(
      `${copy.added} ${displayTitle(ROWS[1])}`,
    )
    // And the other two did not change name with it.
    await expect(starOn(page, 1)).toHaveAccessibleName(`${copy.add} ${displayTitle(ROWS[0])}`)
  })

  /**
   * The composed name still *starts* with the action word, which is what keeps
   * voice control usable: *"click Favoritar"* now offers a numbered choice
   * instead of picking one of twenty at random, and *"click Favoritar Papel"*
   * reaches one card.
   */
  test('is still reachable by the action word alone, now as a choice', async ({ page }) => {
    await world(page)
    await page.goto(LIST)
    await expect(cards(page).first()).toBeVisible()

    // Substring matching, which is Playwright's default for `name` — and the
    // reason the old count-by-name assertion would have survived D57's fix.
    await expect(page.locator('li').getByRole('button', { name: copy.add })).toHaveCount(3)
    await expect(
      page.locator('li').getByRole('button', { name: `${copy.add} ${displayTitle(ROWS[0])}` }),
    ).toHaveCount(1)
  })
})

test.describe('D56 · a failed Favoritar is said and shown', () => {
  /**
   * The region is there before anything fails, which is the mechanism.
   *
   * An `aria-live` region that is *inserted* carrying its text is announced
   * unreliably; the announcement has to be a mutation of a region that already
   * exists. Asserted in the browser as well as in the unit suite because this is
   * the one fact the whole card rests on.
   */
  test('has an empty live region on the list before anything is pressed', async ({ page }) => {
    await world(page)
    await page.goto(LIST)
    await expect(cards(page).first()).toBeVisible()

    await expect(region(page)).toHaveCount(1)
    await expect(region(page)).toHaveText('')
  })

  test('a visitor sees the refusal on the screen, not in an attribute', async ({ page }) => {
    const api = await world(page)
    api.favourites = null

    await page.goto(LIST)
    await expect(cards(page).first()).toBeVisible()
    await starOn(page, 1).click()

    // Visible, and *in the live region* — so it was announced, not merely drawn.
    await expect(region(page)).toHaveText(copy.signedOut)
    await expect(page.getByText(copy.signedOut)).toBeVisible()
    // And the star went back, because nothing was stored.
    await expect(starOn(page, 1)).toBeVisible()
  })

  /**
   * The 429, which is why `refused` being 401-only was a defect and not a
   * nicety: this route allows 60 a minute, and the reader who reaches it is the
   * one working quickly down a long list.
   */
  test('a 429 says to wait, rather than reverting in silence', async ({ page }) => {
    await world(page)
    await page.goto(LIST)
    await expect(cards(page).first()).toBeVisible()
    await breakFavourite(page, 429)

    await starOn(page, 1).click()

    await expect(region(page)).toHaveText(copy.tooMany)
    // Not the generic one: "tente de novo" is wrong advice inside a rate limit.
    await expect(region(page)).not.toHaveText(copy.failed)
    await expect(starOn(page, 1)).toBeVisible()
  })

  test('a dropped connection says something went wrong', async ({ page }) => {
    await world(page)
    await page.goto(LIST)
    await expect(cards(page).first()).toBeVisible()
    await breakFavourite(page, 'offline')

    await starOn(page, 1).click()

    await expect(region(page)).toHaveText(copy.failed)
    await expect(starOn(page, 1)).toBeVisible()
  })

  test('a 500 says the same thing, because nothing here knows more', async ({ page }) => {
    await world(page)
    await page.goto(LIST)
    await expect(cards(page).first()).toBeVisible()
    await breakFavourite(page, 500)

    await starOn(page, 1).click()

    await expect(region(page)).toHaveText(copy.failed)
    await expect(starOn(page, 1)).toBeVisible()
  })

  test('clears on Fechar, and on the next press', async ({ page }) => {
    const api = await world(page)
    api.favourites = null

    await page.goto(LIST)
    await expect(cards(page).first()).toBeVisible()

    await starOn(page, 1).click()
    await expect(region(page)).toHaveText(copy.signedOut)

    // `common.close` is already approved, so the dismiss needed no new string.
    await page.getByRole('button', { name: common.close }).click()
    await expect(region(page)).toHaveText('')

    // And a sentence about a finished press does not survive the next one: it
    // reappears because this press fails too, not because it was never cleared.
    await starOn(page, 2).click()
    await expect(region(page)).toHaveText(copy.signedOut)
    api.favourites = new Set()
    await starOn(page, 3).click()
    await expect(starOn(page, 3, true)).toBeVisible()
    await expect(region(page)).toHaveText('')
  })

  /**
   * **A sentence must not outlive the list it was about.**
   *
   * Found by the §4b review, not by a test. A sort, a filter and a group chip are
   * all client navigations inside the same route segment, so `RadarScreen` and
   * this whole subtree stay mounted — and when the next list comes back the
   * status never leaves `ready`, so `Body` keeps returning the grid branch and
   * the provider is never remounted. A visitor's *"Crie a conta grátis"* stayed
   * pinned to the bottom of the window over a different list, and cleared only
   * if the new one happened to be **empty** (which unmounts the provider) —
   * inconsistent as well as stale.
   *
   * The sort is the discriminator and the group chip is not: *Verificar* has no
   * tenders in this world, so switching to it would clear the sentence for the
   * wrong reason and the test would prove nothing. A sort keeps the list ready
   * and non-empty, which is exactly the case that was broken.
   *
   * Browser-only by construction: `environment: 'node'` performs no navigation
   * and `FavouriteNotices`'s state cannot be reached without a click, so there is
   * nothing for the unit suite to assert here (CLAUDE.md §4c).
   */
  test('does not survive a sort — the sentence belongs to the list it was said on', async ({
    page,
  }) => {
    const api = await world(page)
    api.favourites = null
    await page.goto(LIST)
    await expect(cards(page).first()).toBeVisible()

    /*
     * **Both orders have to be warm, and that is the whole test.**
     *
     * The first version of this went straight from one order to the other and
     * **passed with the fix removed** — because an order with no snapshot takes
     * `radar-screen.tsx`'s cold path, which sets `status: 'analyzing'`, so
     * `Body` swaps the grid for a `StateCard`, the provider unmounts, and the
     * sentence goes with it. The clear was happening for the wrong reason, and a
     * mutation run is the only thing that said so.
     *
     * The reachable case is a navigation that **keeps the grid mounted**: a
     * destination whose snapshot is fresh restores synchronously
     * (`restoreList` → `setData(fromSnapshot(…))`, no `analyzing` in between),
     * so `Body` renders the list branch throughout. So: visit both orders to
     * warm both snapshots, come back, fail a press, and then move.
     */
    await sortTo(page, 'deadline', 'valueDesc')
    await sortTo(page, 'valueDesc', 'deadline')
    await expect(page).not.toHaveURL(/sort=/)

    await starOn(page, 1).click()
    await expect(region(page)).toHaveText(copy.signedOut)

    await sortTo(page, 'deadline', 'valueDesc')

    // Still a list with three cards and three stars, so the provider was never
    // unmounted: the region is empty because the sentence was retired with the
    // list it was said on, not because the branch that draws it went away.
    await expect(page.locator('li').getByRole('button', { pressed: false })).toHaveCount(3)
    await expect(region(page)).toHaveCount(1)
    await expect(region(page)).toHaveText('')
  })

  /**
   * The region is fixed to the **window**, which only works because it renders
   * as a sibling of the list's `@container`: `container-type: inline-size` makes
   * that div a containing block for `position: fixed`, so a region nested inside
   * it would sit at the bottom of the grid instead. Nothing in
   * `environment: 'node'` has a rectangle, so this is the only place the
   * difference is observable.
   */
  test('is drawn inside the window on a phone, not at the bottom of the list', async ({ page }) => {
    const api = await world(page)
    api.favourites = null
    await page.setViewportSize({ width: 390, height: 640 })
    await page.goto(LIST)
    await expect(cards(page).first()).toBeVisible()

    await starOn(page, 1).click()
    const sentence = page.getByText(copy.signedOut)
    await expect(sentence).toBeVisible()

    // The discriminator: the list has to be **taller than the window**, or a
    // region anchored to the container would land inside the viewport by
    // accident and this test would prove nothing.
    const list = await page.locator('ul.grid').boundingBox()
    expect(list, 'the card grid is drawn').not.toBeNull()
    expect(list!.y + list!.height, 'the grid runs past the fold').toBeGreaterThan(640)

    const box = await sentence.boundingBox()
    expect(box, 'the sentence is drawn').not.toBeNull()
    const viewport = page.viewportSize()!
    // Inside the window, near the bottom of it — where the thumb that just
    // pressed the star is.
    expect(box!.y).toBeGreaterThan(viewport.height / 2)
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height)
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width)
  })
})
