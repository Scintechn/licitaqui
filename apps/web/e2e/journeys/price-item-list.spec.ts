import { expect, test, type Page } from '@playwright/test'
import { installRadarApi } from '../fixtures/radar-api'
import { item, MARTA, processo, tender } from '../fixtures/world'

/**
 * D34 — a 251-item edital is navigable without scrolling it.
 *
 * Sci, 2026-10-01, on `77817476000144-1-000034/2026`: *"imagine the tender has
 * more than 31 items… we need a new arrangement to view those items,
 * expand/collapse. But scrolling 31 items is not the best practice."*
 *
 * **Which test does which (CLAUDE.md §4c).** `item-picker.test.tsx` pins the
 * *mechanism*: the `<details>`, the count sentence, the chosen item inside the
 * `<summary>`, the cap, the two pure functions, and the absence of any viewport
 * breakpoint. It cannot pin the *result*, because `environment: 'node'` runs no
 * effect, has no boxes and cannot type — so it cannot tell a disclosure that
 * opens from one that renders and never opens, and it cannot know whether the
 * box actually filters anything. That is this file.
 *
 * The edital here has **31 items**, Sci's own number, with one item at the far
 * end that only a search can reach.
 */

const TENDER_ID = '77817476000144-1-000034/2026'
const COUNT = 31
/** Item 31: the row a reader can reach by typing and not by looking. */
const NEEDLE = 'GRAMPEADOR DE MESA para até 100 folhas'

/**
 * The real tender's length, past `LIST_CAP`, for the two cases the cap owns.
 *
 * 251 is Sci's own edital. It matters that it is **more than 50**: the first
 * version of the picker capped the rows with a plain `slice`, so opening the
 * list on a high-numbered item drew fifty chips that did not include it — and
 * no fixture in either suite was long enough to notice.
 */
const LONG = 251
/** A 70-character unbroken run, which PNCP item text really does carry. */
const CODE = 'CATMAT390124ELEMENTOFILTRANTECOALESCENTE0750MMX0120MMREF12345678'

async function openPriceScreen(page: Page, count = COUNT, atItem?: number): Promise<void> {
  const edital = tender({
    id: TENDER_ID,
    object: `AQUISIÇÃO DE MATERIAL DE EXPEDIENTE, PROCESSO ${processo(34)}`,
    itemCount: count,
    items: Array.from({ length: count }, (_, index) =>
      item(index + 1, {
        // Item 1 — the one the screen opens on, so the one whose chip rides in
        // the `<summary>` — carries an unbroken 70-character code, because
        // that is the worst case PNCP actually publishes and the one a
        // string assertion cannot judge. The last item is the needle only a
        // search can reach.
        description:
          index === 0
            ? CODE
            : index + 1 === count
              ? NEEDLE
              : `Resma de papel A4 75 g/m², pacote com 500 folhas`,
      }),
    ),
  })
  await installRadarApi(page, { companies: [{ company: MARTA.company, tenders: [edital] }] })
  // Registered after the fixture so it wins; the band itself is not this
  // card's subject, and the empty answer is the quietest one on the screen.
  await page.route('**/api/tenders/**/band**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ state: 'ready', band: null, evidence: null }),
    }),
  )
  const at = atItem === undefined ? '' : `&item=${atItem}`
  await page.goto(`/radar/edital/${TENDER_ID}/preco?cnpj=${MARTA.cnpj}&group=compatible${at}`)
}

/** The chip for one item, inside the picker's own list. */
function chip(page: Page, number: number) {
  return page.locator(`a[href*="item=${number}"]`).first()
}

test.describe('D34 · the item list collapses, counts and searches', () => {
  test('31 items arrive collapsed, with the count and the item being priced', async ({ page }) => {
    await openPriceScreen(page)

    // The count a reader can check: one item on screen, 31 in the edital.
    await expect(page.getByText(`Mostrando 1 de ${COUNT} itens`)).toBeVisible()
    // The chosen item survives the collapse — and the assertion is scoped to
    // the summary, because the screen also prints the item above the picker
    // and an unscoped match would pass with the chip gone.
    await expect(page.locator('summary').getByText(/Item 1 ·/)).toBeVisible()
    // And item 31 is in the DOM — which is what makes it findable by
    // find-in-page in current Chrome — and not shown. **Not** "and screen
    // readers": the content of a closed `<details>` is not exposed to
    // assistive technology, which is why the summary chip carries
    // `aria-current` of its own.
    await expect(chip(page, COUNT)).toBeHidden()
  })

  test('it opens on demand and the whole list is there', async ({ page }) => {
    await openPriceScreen(page)
    await page.getByText('Ver mais itens').click()

    await expect(chip(page, COUNT)).toBeVisible()
    await expect(page.getByText(`Mostrando ${COUNT} de ${COUNT} itens`)).toBeVisible()
  })

  test('the open list is bounded, so it cannot push the price card off screen', async ({
    page,
  }) => {
    await openPriceScreen(page)
    await page.getByText('Ver mais itens').click()

    // The defect was a column taller than the card it leads to. Only a browser
    // knows this: the list scrolls inside itself rather than growing the page.
    const list = page.locator('details nav')
    const box = await list.evaluate((node) => ({
      client: node.clientHeight,
      scroll: node.scrollHeight,
    }))
    expect(box.scroll, 'the list is longer than the box it is drawn in').toBeGreaterThan(box.client)
    // Against the **viewport**, not against 31 × 44px: that number is 1 364px,
    // larger than any viewport this suite runs at, so it would have gone on
    // passing if the fixture ever shrank. `60dvh` of 844 is ~506.
    const viewport = page.viewportSize()
    expect(viewport, 'the journeys project pins a viewport').not.toBeNull()
    expect(box.client, 'and the box is a fraction of the screen').toBeLessThan(
      (viewport as { height: number }).height * 0.7,
    )
  })

  test('typing finds the one item a reader could not have scrolled to', async ({ page }) => {
    await openPriceScreen(page)
    await page.getByText('Ver mais itens').click()

    // Named by the group it searches — it has no words of its own (D47).
    const box = page.getByRole('searchbox', { name: 'Itens do edital' })
    await box.fill('grampeador')

    await expect(chip(page, COUNT)).toBeVisible()
    await expect(chip(page, 1)).toBeHidden()
    // `filter({ visible: true })` because the summary carries the sentence
    // twice — the collapsed count and the open one, one of them `display:
    // none` — and with one match left they read the same words. Both are true
    // of the state that shows them; this asks the one on screen.
    await expect(
      page.getByText(`Mostrando 1 de ${COUNT} itens`).filter({ visible: true }),
    ).toBeVisible()
  })

  test('the accent is not a wall: `ate` finds `até`', async ({ page }) => {
    await openPriceScreen(page)
    await page.getByText('Ver mais itens').click()
    await page.getByRole('searchbox', { name: 'Itens do edital' }).fill('ATE 100')

    await expect(chip(page, COUNT)).toBeVisible()
    await expect(chip(page, 1)).toBeHidden()
  })

  test('clearing the box gives the list back', async ({ page }) => {
    await openPriceScreen(page)
    await page.getByText('Ver mais itens').click()
    const box = page.getByRole('searchbox', { name: 'Itens do edital' })
    await box.fill('grampeador')
    await expect(chip(page, 1)).toBeHidden()

    await box.fill('')
    await expect(chip(page, 1)).toBeVisible()
    await expect(page.getByText(`Mostrando ${COUNT} de ${COUNT} itens`)).toBeVisible()
  })

  test('collapsing it again leaves the chosen item on screen', async ({ page }) => {
    await openPriceScreen(page)
    await page.getByText('Ver mais itens').click()
    await expect(chip(page, COUNT)).toBeVisible()

    await page.getByText('Ver menos').first().click()

    await expect(chip(page, COUNT)).toBeHidden()
    // The one thing a collapse must never hide: which item you are reading.
    await expect(page.locator('summary').getByText(/Item 1 ·/)).toBeVisible()
  })

  /**
   * **The defect the first version shipped and neither suite could see.**
   *
   * Both suites chose item 1 and the browser fixture had 31 items, so the cap
   * was never exercised in a browser at all. With 251 items and `?item=251`,
   * `matched.slice(0, 50)` drew fifty chips that did not include item 251 —
   * and the summary chip is hidden while the list is open, so nothing on the
   * screen was marked as the page the reader was on.
   */
  test('an item past the cap is still in the list it opens', async ({ page }) => {
    await openPriceScreen(page, LONG, LONG)

    await expect(page.getByText(`Mostrando 1 de ${LONG} itens`)).toBeVisible()
    await page.getByText('Ver mais itens').click()

    // Drawn, visible, and the row the reader is on.
    const current = page.locator('details nav a[aria-current="page"]')
    await expect(current).toHaveCount(1)
    await expect(current).toBeVisible()
    await expect(current).toHaveAttribute('href', new RegExp(`item=${LONG}$`))
    // Still a capful, not 251 rows.
    await expect(page.locator('details nav a')).toHaveCount(50)
  })

  /**
   * **`EvidenceRow`'s class of defect, one screen over.** `trimObject` caps
   * the *length*, not the token count, and PNCP item text carries long
   * unspaced catalogue codes — so a 70-character chip label can be one
   * unbreakable run. `CHIP` is a flex container, so without `min-w-0
   * break-words` the label's min-content width pushes the chip past its
   * column, and the chip inside the `<summary>` has no scrolling ancestor to
   * contain it. `environment: 'node'` has no boxes, so only this can fail.
   *
   * The assertion is against **the picker's own right edge** rather than the
   * document's, and deliberately: writing it as "no horizontal page scroll"
   * made it fail on a defect that is not this card's. `price-view.tsx`'s item
   * heading — `LongText`'s short branch, inside a `div.text-body` with no
   * `break-words` — really does overflow on the same text, measured here at
   * **561px inside a 390px viewport**. That is **D48**, carded, not absorbed:
   * a test that passes once somebody else's bug is fixed would have proven
   * nothing about this one.
   */
  test('a 70-character code stays inside the picker, collapsed and open', async ({ page }) => {
    await openPriceScreen(page)
    await expect(page.locator('summary')).toBeVisible()

    const overflow = () =>
      page.evaluate(() => {
        const picker = document.querySelector('details')
        if (picker === null) throw new Error('no picker on the screen')
        const edge = picker.getBoundingClientRect().right
        const worst = [...picker.querySelectorAll('*')]
          .map((node) => node.getBoundingClientRect().right)
          .reduce((a, b) => Math.max(a, b), 0)
        return Math.round(worst - edge)
      })

    expect(await overflow(), 'nothing sticks out of the collapsed picker').toBeLessThanOrEqual(1)
    await page.getByText('Ver mais itens').click()
    expect(await overflow(), 'nor out of the open one').toBeLessThanOrEqual(1)
  })

  test('choosing another item moves the screen to it', async ({ page }) => {
    await openPriceScreen(page)
    await page.getByText('Ver mais itens').click()
    await chip(page, 4).click()

    await expect(page).toHaveURL(/item=4/)
    // The search that got her here travels with the click (#68's seam).
    await expect(page).toHaveURL(new RegExp(`cnpj=${MARTA.cnpj}`))
    await expect(page.getByText(`Mostrando 1 de ${COUNT} itens`)).toBeVisible()
  })
})
