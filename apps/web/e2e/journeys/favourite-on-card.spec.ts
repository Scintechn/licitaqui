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
 *  - a visitor's star goes back, and claims nothing was stored.
 *
 * **Where the sentence goes, and that every failure gets one, is D56's own file**
 * — `favourite-feedback.spec.ts`, together with D57's computed accessible names.
 * This file is about the star; that one is about the answer.
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

/**
 * Every star on the list in one state — found by the **state** it reports, never
 * by its name.
 *
 * ## What this replaced, and why the old one was wrong
 *
 * It was `getByRole('button', { name: 'Favoritar' })` with `toHaveCount(3)`,
 * which **required all three names to be identical** — the card id for that is
 * D57, and it is §4b's shape exactly: a test that passes *because* of the
 * defect, in the same PR as the defect. Worse than merely tolerating it: with
 * D57's fix in place the assertion would have **gone on passing**, because
 * Playwright matches the `name` option as a substring and *Favoritar* is a
 * substring of *Favoritar Baterias e pilhas*. A green suite would have been
 * evidence of nothing in either direction.
 *
 * `aria-pressed` is what the star actually promises a reader, it is one value
 * per card rather than a name shared across cards, and it cannot be satisfied by
 * twenty controls answering to one word. The names themselves are asserted where
 * they can be — as the **computed** accessible name, in
 * `favourite-feedback.spec.ts`.
 */
function stars(page: Page, marked: boolean): Locator {
  return page.locator('li').getByRole('button', { pressed: marked })
}

/**
 * The star on the card for one process number — the way a reader finds it.
 *
 * Scoped by the `<li>` the list already puts every card in, not by the wrapper
 * this card introduced: a selector naming my own class would pass whatever the
 * markup became. The process number is how `screen.ts`'s `card()` finds one card
 * among sixty, and it survives the de-shouting rule verbatim.
 */
function starOn(page: Page, n: number, marked: boolean): Locator {
  return page
    .locator('li')
    .filter({ hasText: processo(n) })
    .getByRole('button', { pressed: marked })
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
    await expect(stars(page, false)).toHaveCount(3)
    expect(api.calls.favourite, 'nothing is fetched on mount').toEqual([])

    await starOn(page, 2, false).click()

    await expect(starOn(page, 2, true)).toBeVisible()
    expect(api.favourites, 'the row the route would have written').toEqual(new Set([ID(2)]))
    expect(api.calls.favourite).toHaveLength(1)
    // The other two are untouched: a toggle on one card is not a toggle on the list.
    await expect(stars(page, false)).toHaveCount(2)
  })

  test('the tap does not open the edital — the star is beside the link, not in it', async ({
    page,
  }) => {
    await world(page)
    await page.goto(LIST)
    await expect(cards(page).first()).toBeVisible()

    await starOn(page, 1, false).click()
    await expect(starOn(page, 1, true)).toBeVisible()

    // Still the list. A `<button>` inside the card's `<a>` would have navigated
    // here, and every assertion in the unit suite would still have passed.
    expect(new URL(page.url()).pathname).toBe('/radar')
    await expect(cards(page).first()).toBeVisible()
  })

  test('comes back marked after a reload, from the snapshot and no request', async ({ page }) => {
    const api = await world(page)
    await page.goto(LIST)
    await expect(cards(page).first()).toBeVisible()

    await starOn(page, 3, false).click()
    await expect(starOn(page, 3, true)).toBeVisible()

    const before = api.calls.tenders.length
    await page.reload()
    await expect(cards(page).first()).toBeVisible()

    // The star survived, and the list did not go back to the route for it: under
    // a minute old, `restoreList` returns the snapshot and nothing is fetched.
    // So this is the snapshot's `favourites` and nothing else could have
    // supplied it.
    await expect(starOn(page, 3, true)).toBeVisible()
    await expect(stars(page, false)).toHaveCount(2)
    expect(api.calls.tenders.length, 'a fresh snapshot asks for nothing').toBe(before)
  })

  test('shows a mark made on another device, because it rides with the rows', async ({ page }) => {
    // Nothing was pressed in this browser: the state came back in the envelope,
    // which is what "one read" buys — the list and its stars cannot disagree.
    const api = await world(page, [ID(2)])
    await page.goto(LIST)
    await expect(cards(page).first()).toBeVisible()

    await expect(starOn(page, 2, true)).toBeVisible()
    await expect(stars(page, false)).toHaveCount(2)
    expect(api.calls.favourite).toEqual([])
  })

  test('unmarks again, and the star goes back to Favoritar', async ({ page }) => {
    const api = await world(page, [ID(1)])
    await page.goto(LIST)
    await expect(starOn(page, 1, true)).toBeVisible()

    await starOn(page, 1, true).click()

    await expect(starOn(page, 1, false)).toBeVisible()
    expect(api.favourites).toEqual(new Set())
  })

  /**
   * This used to assert the refusal as `starOn(page, 1, copy.signedOut)` — the
   * star's own `aria-label` becoming the sentence, which is the attribute D56
   * deleted precisely because it is not *said* to anybody. What belongs in this
   * file is what the **star** does with a refusal: it goes back. Where the
   * sentence goes, and that it goes somewhere for a 429 and a dropped connection
   * too, is `favourite-feedback.spec.ts`.
   */
  test('a visitor’s star reverts, and claims nothing was stored', async ({ page }) => {
    // `POST /api/tenders/:id/favorito` is the only Radar route that refuses a
    // caller outright: a favourite is a row keyed on `users.id` and there is
    // nowhere to put one.
    const api = await world(page)
    api.favourites = null

    await page.goto(LIST)
    await expect(cards(page).first()).toBeVisible()

    // The star is drawn for a visitor too — §8's rule is that an account adds
    // capability, and a control that is simply absent teaches nobody anything.
    await starOn(page, 1, false).click()

    // Reverted: nothing was stored, so nothing may claim it was. Asserted as the
    // state the reader perceives, on all three cards.
    await expect(stars(page, true)).toHaveCount(0)
    await expect(stars(page, false)).toHaveCount(3)
    // And the sentence is on the screen rather than hidden in the control.
    await expect(page.getByText(copy.signedOut)).toBeVisible()
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

    const control = await box(starOn(page, 1, false))
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

  /**
   * A refresh that was already in flight must not undo a press.
   *
   * `revalidate()` runs when a restored snapshot is between a minute and thirty
   * minutes old, and it carries a picture of the server **from the moment its
   * request left**. Press a star while it is in flight and the reader's own
   * `POST` has confirmed a newer fact; letting the refresh win empties a star
   * they just filled. The window is short and it is at mount, which is exactly
   * when somebody is looking at the list.
   *
   * Driven, not waited on: the snapshot's `savedAt` is aged by hand so the
   * restore chooses `revalidate`, and the refresh's answer is held open and
   * built **before** the press, which is what makes it stale.
   */
  test('a refresh in flight does not undo a star pressed while it was open', async ({ page }) => {
    const api = await world(page)
    await page.goto(LIST)
    await expect(cards(page).first()).toBeVisible()

    /*
     * Age the snapshot past `REVALIDATE_AFTER_MS` (60 s) so the next mount
     * restores it *and* refreshes behind it.
     *
     * `addInitScript`, not `evaluate` before the reload, and that is not a
     * style choice: `radar-screen.tsx` re-writes the snapshot on `pagehide`,
     * which a reload fires, and it writes the copy the in-memory Map still
     * holds — so an entry aged in the outgoing document is replaced by a fresh
     * one on the way out. This runs in the *incoming* document, before any
     * application script reads storage.
     */
    await page.addInitScript(() => {
      for (let i = 0; i < sessionStorage.length; i += 1) {
        const key = sessionStorage.key(i)
        if (!key?.startsWith('licitaqui.radar.list:')) continue
        const entry = JSON.parse(sessionStorage.getItem(key)!)
        entry.savedAt = Date.now() - 90_000
        sessionStorage.setItem(key, JSON.stringify(entry))
      }
    })

    // The refresh's answer, composed now — before anything is pressed — and
    // delivered when this test says so. Registered after `installRadarApi`, so
    // it wins: Playwright runs the most recently added handler first.
    let deliver = () => {}
    const held = new Promise<void>((resolve) => {
      deliver = resolve
    })
    let asked = () => {}
    const reached = new Promise<void>((resolve) => {
      asked = resolve
    })
    const stale = {
      state: 'ready',
      group: 'compatible',
      tenders: tenderRun(3),
      // The whole point: the server had no marks when this was read.
      favourites: [] as string[],
      counts: { compatible: 3, check: 0, keyword: 0 },
      nextCursor: null,
      freshness: { state: 'fresh', updatedAt: new Date().toISOString(), ageSeconds: 90 },
    }
    // A regex, not a glob: `?` is a single-character wildcard in Playwright's
    // glob and would not match the query string this route always carries.
    await page.route(/\/api\/radar\/tenders(\?|$)/, async (route) => {
      asked()
      await held
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(stale),
      })
    })

    await page.reload()
    await expect(cards(page).first()).toBeVisible()
    await reached

    await starOn(page, 1, false).click()
    await expect(starOn(page, 1, true)).toBeVisible()
    expect(api.favourites, 'the POST landed').toEqual(new Set([ID(1)]))

    deliver()

    // The stale answer arrives and says nothing is marked. The star stays filled,
    // because the reader touched this tender after that answer was composed.
    await expect(starOn(page, 1, true)).toBeVisible()
    await expect(stars(page, false)).toHaveCount(2)
  })

  /**
   * A second press inside one round trip cannot leave the screen and the row
   * disagreeing.
   *
   * Two open toggles answer in whatever order the network returns them, and
   * applying the later answer leaves the star saying one thing and `favourites`
   * saying another — which the list then writes into `sessionStorage`, so the
   * wrong state survives a Back. `favourite-star.tsx` ignores a press while a
   * `POST` for that tender is open, which makes the last answer the only answer.
   */
  test('a second press inside one round trip cannot desync the star from the row', async ({
    page,
  }) => {
    const api = await world(page)
    await page.goto(LIST)
    await expect(cards(page).first()).toBeVisible()

    const gate = api.hold('favourite')

    await starOn(page, 1, false).click()
    await gate.reached
    // Optimistic: the star is already filled while the POST is open.
    await expect(starOn(page, 1, true)).toBeVisible()

    // The second press, with the first still in flight.
    await starOn(page, 1, true).click()
    gate.open()

    // One request, one row, and the screen agrees with it.
    await expect(starOn(page, 1, true)).toBeVisible()
    expect(api.calls.favourite, 'only one toggle left the browser').toHaveLength(1)
    expect(api.favourites).toEqual(new Set([ID(1)]))
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
    //
    // This used to read `aria-label` off `:focus`. That attribute is gone (D57),
    // and asserting an attribute would in any case not have said *which* card's
    // star had focus — which is the only interesting part. So: the first card's
    // own star, identified by the `<li>` it lives in.
    await expect(starOn(page, 1, false)).toBeFocused()
  })
})
