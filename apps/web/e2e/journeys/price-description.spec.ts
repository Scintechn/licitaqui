import { expect, test, type Page } from '@playwright/test'
import { installRadarApi } from '../fixtures/radar-api'
import { item, MARTA, processo, tender } from '../fixtures/world'

/**
 * D38 — the reader can open the whole description.
 *
 * `price-view.test.tsx` pins the **mechanism**: that the full text is in the
 * markup and that it is a `<details>` rather than a clamp. It cannot pin the
 * **result**, because `environment: 'node'` has no boxes and runs no effects,
 * so it cannot tell a disclosure a reader can open from one that renders and
 * never opens — which is §4c's second blind class exactly.
 *
 * This file asks the question the unit test cannot: *does clicking it reveal
 * the rest.*
 *
 * The case is Sci's, 2026-10-05, on a software licence whose four results ran
 * **R$ 339,99 to R$ 6.363,00**: *"they can be a good comparison, because of
 * that I request to see the whole description."* A 19× spread is either four
 * unlike things or one volatile market, and reading what each one bought is
 * the only way a reader tells those apart.
 */

const TENDER_ID = '51885242000140-1-000081/2026'

const HEAD = 'Cessão Temporária de Direitos Sobre Programas de Computador Locação de Software'
/** The half truncation removed — and the half that decides comparability. */
const TAIL = 'treinamento presencial e atualizações legais por 12 meses'
const FULL = `${HEAD} Cessão de direito de uso de solução integrada de gestão com suporte técnico, ${TAIL}`

async function openPriceScreen(page: Page): Promise<void> {
  const edital = tender({
    id: TENDER_ID,
    object: `CESSÃO DE DIREITO DE USO DE SOFTWARE, PROCESSO ${processo(81)}`,
    items: [{ ...item(1), description: FULL }],
    itemCount: 1,
  })
  await installRadarApi(page, { companies: [{ company: MARTA.company, tenders: [edital] }] })
  await page.route('**/api/tenders/**/band**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        state: 'ready',
        band: null,
        evidence: {
          editais: 4,
          samples: [
            { tenderId: '99000000000001-1-000001/2026', value: 6363, description: FULL },
            { tenderId: '99000000000002-1-000001/2026', value: 339.99, description: FULL },
          ],
        },
      }),
    }),
  )
  await page.goto(`/radar/edital/${TENDER_ID}/preco?cnpj=${MARTA.cnpj}&group=compatible`)
}

test.describe('D38 · the whole description is reachable', () => {
  test('the item being priced opens to its full text', async ({ page }) => {
    await openPriceScreen(page)

    // Collapsed: the head is readable and the tail is not *shown*. `toBeHidden`
    // rather than `toHaveCount(0)` on purpose — the text is in the DOM, which
    // is what makes it findable by find-in-page and by a screen reader.
    await expect(page.getByText(new RegExp(HEAD.slice(0, 40))).first()).toBeVisible()
    const tail = page.getByText(new RegExp(TAIL)).first()
    await expect(tail).toBeHidden()

    await page.getByText('Ver descrição completa').first().click()

    await expect(tail).toBeVisible()
  })

  test('the item number stays with the description when it opens', async ({ page }) => {
    await openPriceScreen(page)
    // "Item 1 ·" rides inside the summary. Rendered outside it, it would be
    // stranded above a block that opens away from it.
    await expect(page.getByText(/Item 1 ·/).first()).toBeVisible()
    await page.getByText('Ver descrição completa').first().click()

    // **Asserted on the open block, not on `.first()`.** Both copies of the
    // prefix are in the DOM — the collapsed summary keeps its own, hidden by
    // `group-open:hidden` — so `.first()` resolves to the hidden one and this
    // test failed against a component that was behaving correctly. The
    // question is whether the number is with the text *a reader is now
    // looking at*, which is the expanded paragraph.
    const open = page.locator('details[open] > p').first()
    await expect(open).toBeVisible()
    await expect(open).toContainText('Item 1 ·')
    await expect(open).toContainText(TAIL)
  })

  test('a past result opens to the words it closed under', async ({ page }) => {
    await openPriceScreen(page)

    // The two prices are 19x apart. Both carry the same head, so the head
    // cannot distinguish them -- which is the reason the rest must be
    // reachable rather than a nicety.
    await expect(page.getByText('R$ 6.363,00')).toBeVisible()
    await expect(page.getByText('R$ 339,99')).toBeVisible()

    const controls = page.getByText('Ver descrição completa')
    // One for the item, one per evidence row carrying a long description.
    expect(await controls.count()).toBeGreaterThan(1)

    await controls.last().click()
    await expect(page.getByText(new RegExp(TAIL)).last()).toBeVisible()
  })

  test('closes again, so a long list stays a list', async ({ page }) => {
    await openPriceScreen(page)
    const control = page.getByText('Ver descrição completa').first()
    await control.click()
    await expect(page.getByText(new RegExp(TAIL)).first()).toBeVisible()
    await page.getByText('Ver menos').first().click()
    await expect(page.getByText(new RegExp(TAIL)).first()).toBeHidden()
  })
})
