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
            tenderId: '99000000000001-1-000001/2026',
            value: 204,
            description: 'PERFURADOR DE PAPEL 02 FUROS ACO FUNDIDO 100 FOLHAS',
          },
          {
            tenderId: '99000000000002-1-000001/2026',
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
      page.getByText('Encontramos 6 editais encerrados com o mesmo produto'),
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
