import { expect, test, type Page } from '@playwright/test'
import { installRadarApi } from '../fixtures/radar-api'
import { item, MARTA, processo, tender } from '../fixtures/world'

/**
 * E22 — the evidence ladder, asserted on the **path**.
 *
 * `price-band.test.ts` pins the arithmetic and `price-view.test.tsx` pins each
 * rung's markup. Neither can fail on the thing most likely to break, and this
 * is not a guess: deleting the single line in `price-screen.tsx` that passes
 * `evidence` to `PriceView` leaves the whole suite green and `tsc` silent —
 * measured 2026-10-02, by doing it.
 *
 * That is CLAUDE.md's five-times-repeated defect — `tenders.short_title`,
 * `locked_block_clicked`, `radar.list.changeCompany`,
 * `radar.opportunity.screeningCost`, `alert_deliveries.opened_at`: every one a
 * truthful task report about work that rendered nothing, with a green suite
 * throughout. The unit tests here would have passed in all five cases.
 *
 * So this file asks the only question they cannot: **does a reader see it.**
 * It drives the real screen, through the real fetch, through `bandStateFrom`,
 * into the real view — the chain `environment: 'node'` cannot run because it
 * has no `useEffect` (§4c).
 */

const TENDER_ID = '51885242000140-1-000081/2026'

/**
 * **Compras.gov.br purchase keys, not PNCP control numbers.**
 *
 * `PriceSample.tenderId` has carried `catalog_prices.id_compra` since B35, and
 * since D37 the screen *prints* it — so a fixture still in the old
 * `…-1-000001/2026` shape would render no citation at all and every assertion
 * below it would pass on a row that lost half its content.
 *
 * `929909 · 06 · 00107 · 2026`, from the one real price row the repo holds
 * (`worker/tests/test_catalog_prices.py`'s `RAW_ROW`).
 */
const COMPRA_A = '92990906001072026'
const COMPRA_B = '92990906001082026'

/** The band answer for the item on screen, whatever item that turns out to be. */
async function serveBand(page: Page, body: unknown): Promise<void> {
  // Registered after `installRadarApi`, so it wins: Playwright matches the
  // most recently added route first, and the fixture's catch-all would
  // otherwise log this as an unexpected call.
  await page.route('**/api/tenders/**/band**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    }),
  )
}

async function openPriceScreen(page: Page): Promise<void> {
  const edital = tender({
    id: TENDER_ID,
    object: `AQUISIÇÃO DE PERFURADOR DE PAPEL, PROCESSO ${processo(81)}`,
    items: [item(1)],
    itemCount: 1,
  })
  await installRadarApi(page, { companies: [{ company: MARTA.company, tenders: [edital] }] })
}

test.describe('E22 · the evidence ladder reaches the reader', () => {
  test('a thin rung renders its count, its prices and what was matched', async ({ page }) => {
    await openPriceScreen(page)
    // Two editais: below `MIN_SAMPLE`, so `priceBand` refuses and the screen
    // used to say "ainda sem dados de vencedores" — wrong for ten items in
    // every eleven it appeared on (measured 2026-10-01).
    await serveBand(page, {
      state: 'ready',
      band: null,
      evidence: {
        editais: 2,
        samples: [
          {
            tenderId: COMPRA_A,
            value: 204,
            description: 'PERFURADOR DE PAPEL 02 FUROS ACO FUNDIDO 100 FOLHAS',
          },
          {
            tenderId: COMPRA_B,
            value: 180.5,
            description: 'PERFURADOR 2 FUROS CAPACIDADE 100 FOLHAS',
          },
        ],
      },
    })
    await page.goto(`/radar/edital/${TENDER_ID}/preco?cnpj=${MARTA.cnpj}&group=compatible`)

    await expect(page.getByText('Encontramos 2 resultados parecidos')).toBeVisible()
    // The prices, as money — the rung's whole content.
    await expect(page.getByText('R$ 204,00')).toBeVisible()
    await expect(page.getByText('R$ 180,50')).toBeVisible()
    // **What was matched.** At two editais nothing has checked the product
    // heuristic, so this is what the reader judges instead of a claim.
    await expect(page.getByText(/PERFURADOR DE PAPEL 02 FUROS/)).toBeVisible()
    await expect(page.getByText(/PERFURADOR 2 FUROS/)).toBeVisible()
    // The sentence that explains the missing faixa without promising one.
    await expect(
      page.getByText(/Mostramos a faixa quando encontramos pelo menos 5 editais/),
    ).toBeVisible()
    // And the sentence it replaced is gone.
    await expect(page.getByText('Ainda sem dados de vencedores')).toHaveCount(0)
  })

  /**
   * D37 — the half `environment: 'node'` cannot reach (§4c).
   *
   * `price-view.test.tsx` pins the *mechanism*: the identifier is in the
   * markup, an unreadable one renders nothing, the breakpoint is a container
   * query. None of that can fail on a click that does nothing, a clipboard that
   * receives the wrong string, or a row drawn 264px too wide — there are no
   * events and no boxes in that suite. These three tests are the result.
   */
  test('a reader can take the purchase id away with them', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await openPriceScreen(page)
    await serveBand(page, {
      state: 'ready',
      band: null,
      evidence: {
        editais: 1,
        samples: [
          { tenderId: COMPRA_A, value: 204, description: 'PERFURADOR DE PAPEL 02 FUROS' },
        ],
      },
    })
    await page.goto(`/radar/edital/${TENDER_ID}/preco?cnpj=${MARTA.cnpj}&group=compatible`)

    // **The citation is on screen**, which is the card's whole acceptance
    // criterion: before D37 this value reached the component and was a React
    // key and nothing else.
    //
    // By test id, not by text: the id is deliberately in the markup **twice** —
    // once as the selectable number and once inside the button's accessible
    // name, which is what distinguishes four otherwise identical "Copiar"
    // controls. `getByText` is a strict-mode violation on that, and the first
    // version of this test failed exactly there.
    await expect(page.getByTestId('compra-id')).toHaveText(COMPRA_A)

    /**
     * **By accessible name, which is the assertion that matters.** Four of
     * these render at once and the visible label on all four is just
     * *"Copiar"*; what distinguishes them is the id in the button's accessible
     * name, and that is a user-visible property no string assertion in
     * `price-view.test.tsx` can confirm — it would pass on an `sr-only` span
     * that the accessibility tree never joins to the button. Only a browser
     * computes a name.
     *
     * (The `data-testid`s on this row are a deliberate exception to this
     * suite's "select what a person sees" rule, and they are the only two in
     * the app: the identifier is in the markup **twice** by design, so
     * `getByText` is a strict-mode violation, and the layout wrapper below has
     * no user-visible handle at all.)
     */
    const copy = page.getByRole('button', { name: new RegExp(`Copiar\\s+${COMPRA_A}`) })
    await expect(copy).toBeVisible()
    await copy.click()

    // Read the clipboard before looking for the "Copiado" swap: the state
    // reverts on a timer, and asserting the label first makes the test race its
    // own timeout. `fundadores.spec.ts` learned this the same way.
    const clipboard = await page.evaluate(() => navigator.clipboard.readText())
    expect(clipboard).toBe(COMPRA_A)
    // And what the reader copied is exactly what they were shown — not a
    // re-derived or re-padded value.
    await expect(page.getByTestId('compra-id')).toHaveText(clipboard)
  })

  test('the id and its price stay in the column when the desktop rail appears', async ({
    page,
  }) => {
    /**
     * **D29's width, exactly.** At 1024px the shell puts a 264px rail in the
     * layout flow and `main` takes 40px of gutter, so this row is drawn in
     * 1024 − 264 − 40 = **720px** — the width at which a viewport breakpoint
     * above 720 is wrong by up to 264px. The row gained an identifier and a
     * control at D37, so this is the moment it could overflow.
     */
    await page.setViewportSize({ width: 1024, height: 900 })
    await openPriceScreen(page)
    await serveBand(page, {
      state: 'ready',
      band: null,
      evidence: {
        editais: 2,
        samples: [
          {
            tenderId: COMPRA_A,
            value: 204,
            description: 'PERFURADOR DE PAPEL 02 FUROS ACO FUNDIDO 100 FOLHAS CABO LONGO',
          },
          { tenderId: COMPRA_B, value: 180.5, description: 'PERFURADOR 2 FUROS 100 FOLHAS' },
        ],
      },
    })
    await page.goto(`/radar/edital/${TENDER_ID}/preco?cnpj=${MARTA.cnpj}&group=compatible`)

    await expect(page.getByTestId('compra-id').first()).toHaveText(COMPRA_A)
    await expect(page.getByText('R$ 204,00')).toBeVisible()

    /**
     * **Measured on the row, not on the page.** The defect this width exists to
     * catch is the price being *pushed out of its row*, and because the
     * description wraps (`min-w-0 break-words`) that need not move the page at
     * all — a page-level check can stay green straight through the regression
     * it was placed against. So both: the row does not overflow itself, and the
     * price's right edge is inside the row's.
     */
    const rowOverflow = await page
      .getByTestId('evidence-row-layout')
      .first()
      .evaluate((node) => node.scrollWidth - node.clientWidth)
    expect(rowOverflow, 'the row overflowed its own box').toBeLessThanOrEqual(0)

    const row = await page.getByTestId('evidence-row-layout').first().boundingBox()
    const price = await page.getByText('R$ 204,00').first().boundingBox()
    expect(row).not.toBeNull()
    expect(price).not.toBeNull()
    expect(price!.x + price!.width, 'the price escaped the row').toBeLessThanOrEqual(
      row!.x + row!.width + 1,
    )

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)

    /**
     * **And the breakpoint actually fired.** Without this the test is
     * vacuous in the quietest way: if Tailwind emitted no rule for
     * `@min-[520px]:flex-row` the row would stay a column at every width,
     * nothing would overflow, and both layout tests here would still pass.
     * `flex-direction` is the one observable that separates "the container
     * query applied" from "the class string is in the markup", and only a
     * browser can read it.
     */
    const direction = await page
      .getByTestId('evidence-row-layout')
      .first()
      .evaluate((node) => getComputedStyle(node).flexDirection)
    expect(direction, 'a 720px column is above the 520px breakpoint').toBe('row')
  })

  test('the citation survives a phone, where it has to stack', async ({ page }) => {
    // 390px: below the 520px container breakpoint, so the description takes its
    // own line and the price and its source sit together underneath.
    await page.setViewportSize({ width: 390, height: 844 })
    await openPriceScreen(page)
    await serveBand(page, {
      state: 'ready',
      band: null,
      evidence: {
        editais: 1,
        samples: [
          {
            tenderId: COMPRA_A,
            value: 204,
            description: 'PERFURADOR DE PAPEL 02 FUROS ACO FUNDIDO 100 FOLHAS CABO LONGO',
          },
        ],
      },
    })
    await page.goto(`/radar/edital/${TENDER_ID}/preco?cnpj=${MARTA.cnpj}&group=compatible`)

    await expect(page.getByTestId('compra-id')).toHaveText(COMPRA_A)
    await expect(page.getByTestId('copy-compra')).toBeVisible()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    expect(overflow).toBeLessThanOrEqual(0)

    // The other side of the breakpoint, for the reason given above: at 390px
    // the row must stack. A pair that reads `row` here and `row` at 1024 would
    // mean the query never ran.
    const direction = await page
      .getByTestId('evidence-row-layout')
      .first()
      .evaluate((node) => getComputedStyle(node).flexDirection)
    expect(direction, 'a phone is below the 520px breakpoint').toBe('column')
  })

  test('at 560px the container is narrower than the window, and the row knows it', async ({
    page,
  }) => {
    /**
     * **The width that tells a container query from a viewport one** — and the
     * only one here that can. The 1024px and 390px cases above are *both*
     * satisfied by a plain `min-[520px]` **viewport** query: at 1024 the window
     * is also above 520, at 390 also below it. D29, D30 and D32 are every one
     * of them container-vs-viewport, so a pair that cannot separate those is
     * not testing the rule.
     *
     * Arithmetic, and it is why 560: below `lg` there is no rail, `main` is
     * `px-gutter` at **20px** a side and the Card adds `p-4` at **16px**, so the
     * row's container is 560 − 40 − 32 = **488px**. That is below the 520px
     * breakpoint while the *window* is above it — so a container query stacks
     * here and a viewport query would not.
     */
    await page.setViewportSize({ width: 560, height: 900 })
    await openPriceScreen(page)
    await serveBand(page, {
      state: 'ready',
      band: null,
      evidence: {
        editais: 1,
        samples: [
          { tenderId: COMPRA_A, value: 204, description: 'PERFURADOR DE PAPEL 02 FUROS' },
        ],
      },
    })
    await page.goto(`/radar/edital/${TENDER_ID}/preco?cnpj=${MARTA.cnpj}&group=compatible`)
    await expect(page.getByTestId('compra-id')).toHaveText(COMPRA_A)

    const width = await page
      .getByTestId('evidence-row-layout')
      .first()
      .evaluate((node) => node.clientWidth)
    expect(width, 'the container must be below 520 for this test to discriminate').toBeLessThan(520)

    const direction = await page
      .getByTestId('evidence-row-layout')
      .first()
      .evaluate((node) => getComputedStyle(node).flexDirection)
    expect(direction, 'a 560px window holds a sub-520px column — a viewport query would say row').toBe(
      'column',
    )
  })

  test('the top rung shows the count and what was matched, and no winner price', async ({
    page,
  }) => {
    await openPriceScreen(page)
    // Sci, 2026-10-02: above the gate the values are withheld, because four
    // sampled prices rebuild the band. `LockedEvidence` has no price field, so
    // this body is the most a locked answer can carry.
    await serveBand(page, {
      state: 'locked',
      evidence: {
        editais: 6,
        matched: ['PERFURADOR DE PAPEL 02 FUROS ACO FUNDIDO', 'PERFURADOR 2 FUROS 100 FOLHAS'],
      },
    })
    await page.goto(`/radar/edital/${TENDER_ID}/preco?cnpj=${MARTA.cnpj}&group=compatible`)

    await expect(
      page.getByText('Encontramos 6 compras públicas do mesmo item'),
    ).toBeVisible()
    // Both descriptions, not just the first: a `MatchedList` rendering only
    // `items[0]` would otherwise pass.
    await expect(page.getByText(/PERFURADOR DE PAPEL 02 FUROS/)).toBeVisible()
    await expect(page.getByText(/PERFURADOR 2 FUROS 100 FOLHAS/)).toBeVisible()
    await expect(page.getByText('Ainda sem dados de vencedores')).toHaveCount(0)
  })

  test('a locked answer carrying prices still shows none of them', async ({ page }) => {
    await openPriceScreen(page)
    /**
     * **The drifted payload, and the only version of this check that can
     * fail.**
     *
     * The first attempt asserted `strong.tabular-nums` had count 0 on an
     * ordinary locked answer. That holds for free: the two elements carrying
     * that class are the band row and `EvidenceRow`, and a `locked` body with
     * no `samples` makes both unreachable by *any* implementation of those
     * branches. An assertion that cannot fail is worse than none, because it
     * reads as coverage.
     *
     * This body is what a route regression would actually produce — the server
     * stopped calling `withoutPrices` and sent the entitled shape with
     * `state: 'locked'`. `price-view.tsx` narrows **structurally**, not off
     * `bandLocked`, so the prices must still not be drawn.
     */
    await serveBand(page, {
      state: 'locked',
      evidence: {
        editais: 6,
        samples: [
          { tenderId: 'x-1-000001/2026', value: 204, description: 'PERFURADOR DE PAPEL LEAKED' },
          { tenderId: 'y-1-000001/2026', value: 180.5, description: 'PERFURADOR 2 FUROS LEAKED' },
        ],
      },
    })
    await page.goto(`/radar/edital/${TENDER_ID}/preco?cnpj=${MARTA.cnpj}&group=compatible`)

    // The lock itself is still drawn, so the screen is in the state we think.
    await expect(page.getByLabel(/plano Essencial/).first()).toBeVisible()
    // And not one figure from that payload reached the reader.
    await expect(page.getByText('R$ 204,00')).toHaveCount(0)
    await expect(page.getByText('R$ 180,50')).toHaveCount(0)
    await expect(page.getByText(/LEAKED/)).toHaveCount(0)
  })

  test('nothing found still says nothing was found', async ({ page }) => {
    await openPriceScreen(page)
    await serveBand(page, { state: 'ready', band: null, evidence: null })
    await page.goto(`/radar/edital/${TENDER_ID}/preco?cnpj=${MARTA.cnpj}&group=compatible`)

    // The rung that was always right, and must stay reachable: no band and no
    // evidence is genuinely "no number exists for anybody".
    await expect(page.getByText('Ainda sem dados de vencedores')).toBeVisible()
    await expect(page.getByText(/Encontramos/)).toHaveCount(0)
  })
})
