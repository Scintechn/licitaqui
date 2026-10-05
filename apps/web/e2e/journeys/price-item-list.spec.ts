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

async function openPriceScreen(page: Page): Promise<void> {
  const edital = tender({
    id: TENDER_ID,
    object: `AQUISIÇÃO DE MATERIAL DE EXPEDIENTE, PROCESSO ${processo(34)}`,
    itemCount: COUNT,
    items: Array.from({ length: COUNT }, (_, index) =>
      item(index + 1, {
        description:
          index + 1 === COUNT ? NEEDLE : `Resma de papel A4 75 g/m², pacote com 500 folhas`,
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
  await page.goto(`/radar/edital/${TENDER_ID}/preco?cnpj=${MARTA.cnpj}&group=compatible`)
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
    // And item 31 is in the DOM (find-in-page, screen readers) and not shown.
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
    // 44px is `--spacing-touch`, the floor for one chip, so this says the box
    // does not hold all 31 of them — which is the whole point of the bound.
    expect(box.client, 'and the box is a readable height, not 31 rows').toBeLessThan(COUNT * 44)
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
