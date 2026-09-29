import { expect, test } from '@playwright/test'
import { installRadarApi } from '../fixtures/radar-api'
import { editalPath } from '../../lib/radar/client'
import { MARTA, tender } from '../fixtures/world'

/**
 * **Dona Marta clicks *Documentos* and wants the documents** — card D24.
 *
 * ## The defect this exists for
 *
 * Sci, on production, 2026-09-29, signed in on Essencial: *"I clicked in the
 * TAB Documentos, and doesnt present the documents"*. The address bar read
 * `…/11546530000156-1-000027/2026?…&tab=files` and the screen showed **Itens**.
 * The tender had three real documents in `tender_files`, every one with a URL.
 * Nothing was locked and nothing was missing; the screen simply did not open
 * the tab it had been sent to open.
 *
 * `?tab=files` *was* read, by the `useState` initialiser on the Opportunity
 * screen. One render later the loader's `setTab('items')` — there so that
 * moving to a different tender does not keep the previous one's open tab —
 * ran on **mount**, where there is no previous tender, and threw the choice
 * away. The parameter worked for exactly one frame.
 *
 * ## Why this is a journey and not a unit test
 *
 * It could not have been a unit test. `vitest.config.mts` sets
 * `environment: 'node'`, so `useEffect` never runs in that suite: a test that
 * rendered the screen would read the initial state, see `'files'`, and pass —
 * while the browser showed `'items'`. The entire class of "an effect undoes
 * what the first render decided" is invisible there, by construction.
 *
 * The one test that touched `?tab=files` before this asserted the **href the
 * screening screen draws**. Nobody asserted that following it arrived
 * anywhere. That is CLAUDE.md's standing pattern — *the test exercised the
 * unit, not the path* — and the fix for the padlock (#173) shipped straight
 * into it: the link was corrected and the destination was never asked.
 *
 * So both tests below end on a **document that is on screen**, not on a prop,
 * a tab's `aria-selected`, or an href.
 */

const EDITAL = '11546530000156-1-000027/2026'

/** The three files the real tender carries, which is why they are named here. */
const FILES = [
  {
    sequence: 1,
    title: '06___Edital___Pregao_Eletronico_n_10___2026.pdf',
    docType: 'Projeto Executivo',
    url: 'https://pncp.gov.br/arquivos/1',
    publishedAt: null,
    pages: 24,
    noText: false,
  },
  {
    sequence: 2,
    title: 'Termo_de_Referencia.pdf',
    docType: 'Outros Documentos',
    url: 'https://pncp.gov.br/arquivos/2',
    publishedAt: null,
    pages: 11,
    noText: false,
  },
]

function withFiles() {
  // `files` is an array and not `null`: §8 hands the URLs to an account, and
  // Sci was signed in. A `null` here would be testing the padlock instead.
  return tender({ id: EDITAL, files: FILES })
}

async function world(page: Parameters<typeof installRadarApi>[0]) {
  return installRadarApi(page, {
    companies: [{ company: MARTA.company, tenders: [withFiles()] }],
    visitor: null,
  })
}

test.describe('Dona Marta · Documentos', () => {
  test('arriving on ?tab=files shows the documents, not the Itens table', async ({ page }) => {
    // The regression itself. Before the fix this reached the screen with
    // Documentos selected for one render and Itens selected thereafter, so
    // asserting on the *document* is what makes it fail.
    await world(page)

    await page.goto(`${editalPath(EDITAL)}?cnpj=${MARTA.cnpj}&tab=files`)

    await expect(page.getByRole('link', { name: /Termo_de_Referencia/ })).toBeVisible()
    await expect(page.getByRole('tab', { name: 'Documentos' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  test('the tab survives the screen finishing its load', async ({ page }) => {
    // The defect was a *race*: correct on the first render, wrong once the
    // loader ran. A test that asserted immediately would have passed against
    // the bug. So this one waits for the load to have visibly completed — the
    // Itens count is rendered from the answer — and only then looks at the tab.
    await world(page)

    await page.goto(`${editalPath(EDITAL)}?cnpj=${MARTA.cnpj}&tab=files`)
    await expect(page.getByRole('tab', { name: 'Itens' })).toBeVisible()
    await page.waitForLoadState('networkidle')

    await expect(page.getByRole('link', { name: /Termo_de_Referencia/ })).toBeVisible()
  })

  test('switching to Itens and back still works — the reset was not simply removed', async ({
    page,
  }) => {
    // The cheap fix would have been deleting `setTab('items')`, which would
    // break the thing it was there for. The tab is still a live control.
    await world(page)

    await page.goto(`${editalPath(EDITAL)}?cnpj=${MARTA.cnpj}&tab=files`)
    await expect(page.getByRole('link', { name: /Termo_de_Referencia/ })).toBeVisible()

    await page.getByRole('tab', { name: 'Itens' }).click()
    await expect(page.getByRole('link', { name: /Termo_de_Referencia/ })).toBeHidden()

    await page.getByRole('tab', { name: 'Documentos' }).click()
    await expect(page.getByRole('link', { name: /Termo_de_Referencia/ })).toBeVisible()
  })
})
