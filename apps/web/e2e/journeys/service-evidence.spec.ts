import { expect, test, type Page } from '@playwright/test'
import { installRadarApi } from '../fixtures/radar-api'
import { item, MARTA, processo, tender } from '../fixtures/world'

/**
 * D40 — the **result** half (CLAUDE.md §4c).
 *
 * `fallback-evidence.test.ts` pins that the fallback cannot compute a band,
 * `band/route.test.ts` pins that the route never puts one beside it, and
 * `price-view.test.tsx` pins which strings the markup holds. None of those can
 * fail on the question that actually matters to Sci, which is **what is on the
 * screen** — and this repo has five recorded cases of a truthful task report
 * about work that rendered nothing, every one with a green suite.
 *
 * So this file drives the real screen, through the real fetch, through
 * `bandStateFrom` and into the real view: the chain `environment: 'node'`
 * cannot run because it has no `useEffect`. Deleting the `source` read in
 * `price-view.tsx` leaves the unit suite green and fails here.
 *
 * The payload is Sci's own item, 2026-10-05: a software licence whose four
 * past results ran **R$ 339,99 to R$ 6.363,00** — the 19× spread that is the
 * whole argument for showing the results and refusing the band.
 */

const TENDER_ID = '51885242000140-1-000082/2026'

async function serveBand(page: Page, body: unknown): Promise<void> {
  // Registered after `installRadarApi` so it wins: Playwright matches the most
  // recently added route first.
  await page.route('**/api/tenders/**/band**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    }),
  )
}

/** One item, a **service**, so `?item=` is absent and the view resolves it. */
async function openServiceItem(page: Page, kind: 'S' | 'M' = 'S'): Promise<void> {
  const edital = tender({
    id: TENDER_ID,
    object: `CONTRATAÇÃO DE LICENÇA DE USO DE SOFTWARE DE GESTÃO, PROCESSO ${processo(82)}`,
    items: [
      item(1, {
        kind,
        description: 'Licença de uso de software de gestão administrativa, por 12 meses',
        unit: 'Unidade',
        segment: 'Tecnologia da informação',
      }),
    ],
    itemCount: 1,
  })
  await installRadarApi(page, { companies: [{ company: MARTA.company, tenders: [edital] }] })
}

/** The awards rung, exactly as `fallbackEvidenceForItem` returns it. */
const AWARDS_RUNG = {
  state: 'ready',
  band: null,
  evidence: {
    editais: 4,
    source: 'awards',
    samples: [
      {
        tenderId: '99000000000001-1-000001/2026',
        value: 6363,
        description: 'LICENCA ANUAL DE ERP CORPORATIVO COM SUPORTE TECNICO',
      },
      {
        tenderId: '99000000000002-1-000001/2026',
        value: 2400,
        description: 'CESSAO DE DIREITO DE USO DE SISTEMA WEB DE GESTAO',
      },
      {
        tenderId: '99000000000003-1-000001/2026',
        value: 890.5,
        description: 'LOCACAO DE SOFTWARE DE GESTAO DE PROTOCOLO',
      },
      {
        tenderId: '99000000000004-1-000001/2026',
        value: 339.99,
        description: 'LICENCA DE USO DE ANTIVIRUS CORPORATIVO',
      },
    ],
  },
}

test.describe('D40 · past winners come back, and never as a band', () => {
  test('a service item shows its results, area-framed, with no preço máximo', async ({ page }) => {
    await openServiceItem(page)
    await serveBand(page, AWARDS_RUNG)
    await page.goto(`/radar/edital/${TENDER_ID}/preco?cnpj=${MARTA.cnpj}&group=compatible`)

    // **The regression B35 caused, closed.** This is the sentence Sci met on
    // this exact item.
    await expect(page.getByText('Ainda sem dados de vencedores')).toHaveCount(0)

    // The results reached the reader: the count, the extremes of the 19×
    // spread, and the words each price closed under.
    await expect(page.getByText('Encontramos 4 resultados parecidos')).toBeVisible()
    await expect(page.getByText('R$ 6.363,00')).toBeVisible()
    await expect(page.getByText('R$ 339,99')).toBeVisible()
    await expect(page.getByText(/LICENCA ANUAL DE ERP CORPORATIVO/)).toBeVisible()
    await expect(page.getByText(/LICENCA DE USO DE ANTIVIRUS/)).toBeVisible()

    // Sci's heading for this rung, and the one it replaces — the heading of a
    // figure nothing on this path computes.
    // `{ exact: true }`: the approved help sentence contains the phrase
    // *"contratações parecidas"* too, so a substring match is a strict-mode
    // violation on a service — which is how this assertion first failed. The
    // heading is its own node.
    await expect(page.getByText('Contratações parecidas', { exact: true })).toBeVisible()
    await expect(page.getByText('Seu preço máximo de compra')).toHaveCount(0)
  })

  test('it claims the area, not the item', async ({ page }) => {
    await openServiceItem(page)
    await serveBand(page, AWARDS_RUNG)
    await page.goto(`/radar/edital/${TENDER_ID}/preco?cnpj=${MARTA.cnpj}&group=compatible`)

    await expect(page.getByText(/Mostramos contratações parecidas, da mesma área/)).toBeVisible()
    // `evidenceHelp` promises the faixa at five editais; the fallback never
    // draws one at any count.
    await expect(page.getByText(/Mostramos a faixa quando encontramos pelo menos 5 editais/)).toHaveCount(0)
    await expect(page.getByText(/o mesmo produto/)).toHaveCount(0)
    await expect(page.getByText(/compras públicas do mesmo item/)).toHaveCount(0)
  })

  test('no band, no range, no margin control on this rung', async ({ page }) => {
    await openServiceItem(page)
    await serveBand(page, AWARDS_RUNG)
    await page.goto(`/radar/edital/${TENDER_ID}/preco?cnpj=${MARTA.cnpj}&group=compatible`)

    // The rung drew, so these negatives are about the band and not about an
    // empty page.
    await expect(page.getByText('Encontramos 4 resultados parecidos')).toBeVisible()
    await expect(page.getByText('Teto para manter a margem que você informou')).toHaveCount(0)
    await expect(page.getByText('Sua margem')).toHaveCount(0)
    // `bandSample` — "N compras públicas" — is drawn only beside a band.
    await expect(page.getByText(/compras públicas/)).toHaveCount(0)
  })

  test('never shows a service a locked bar, not even before the answer lands', async ({ page }) => {
    /**
     * **The one state only a browser can show.** `price-screen.tsx` holds
     * `bandLocked = true` until the band request resolves, and
     * `environment: 'node'` runs no effect, so the unit suite only ever sees
     * the state it is handed. Here the route is held open, the screen is
     * asserted mid-flight, and then released.
     *
     * A locked bar says *a number exists and your plan does not include it*.
     * For a service none exists for anybody, and D40 lengthened this window by
     * putting a trigram query inside the request it waits on.
     */
    await openServiceItem(page)
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route('**/api/tenders/**/band**', async (route) => {
      await held
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(AWARDS_RUNG),
      })
    })
    await page.goto(`/radar/edital/${TENDER_ID}/preco?cnpj=${MARTA.cnpj}&group=compatible`)

    // The screen is up — the item is on it — and the band answer has not landed.
    await expect(page.getByText(/Licença de uso de software de gestão/).first()).toBeVisible()
    await expect(page.getByText('Venceu em compras do mesmo item')).toHaveCount(0)
    await expect(page.getByText('Seu preço máximo de compra')).toHaveCount(0)

    release()
    await expect(page.getByText('Encontramos 4 resultados parecidos')).toBeVisible()
  })

  test('a material the catalogue missed gets the results and no serviços sentence', async ({
    page,
  }) => {
    // The scope widened on 2026-10-05: open materials the catalogue cannot
    // match take this rung too (counts in `docs/PRICE_BAND.md` §0.2). The approved
    // sentence names serviços, so it must not appear for them, and no sentence
    // is written in its place — docs/CLAIMS.md carries the gap.
    await openServiceItem(page, 'M')
    await serveBand(page, AWARDS_RUNG)
    await page.goto(`/radar/edital/${TENDER_ID}/preco?cnpj=${MARTA.cnpj}&group=compatible`)

    await expect(page.getByText('Encontramos 4 resultados parecidos')).toBeVisible()
    // `{ exact: true }`: the approved help sentence contains the phrase
    // *"contratações parecidas"* too, so a substring match is a strict-mode
    // violation on a service — which is how this assertion first failed. The
    // heading is its own node.
    await expect(page.getByText('Contratações parecidas', { exact: true })).toBeVisible()
    await expect(page.getByText('Seu preço máximo de compra')).toHaveCount(0)
    await expect(page.getByText(/Serviços raramente se repetem/)).toHaveCount(0)
  })
})
