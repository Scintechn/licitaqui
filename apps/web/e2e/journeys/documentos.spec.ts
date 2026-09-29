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
 * So the two tests that guard the defect end on a **document that is on
 * screen**, not on a prop or an href. Both are mutation-checked red against
 * the restored bug.
 *
 * ## What this file does *not* claim
 *
 * There is no reset to defend. The first fix added a ref so the loader reset
 * the tab only when the tender id changed — dead code: `id` is the `[...id]`
 * catch-all segment, and the App Router keys that subtree by a cache key
 * containing the segment value, so a different tender **remounts** the screen
 * and `useState` re-reads the new URL. The branch could never execute. It was
 * removed rather than tested, and this note exists so nobody adds it back.
 */

const EDITAL = '11546530000156-1-000027/2026'

/** The three files the real tender carries, which is why they are named here. */
const FILES = [
  {
    sequence: 3,
    title: '07___Publicacao___Pregao_n_10___2026.pdf',
    docType: 'Outros Documentos',
    url: 'https://pncp.gov.br/arquivos/3',
    publishedAt: null,
    pages: 2,
    noText: false,
  },
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
  // Sci was signed in. A `null` here would be testing the padlock instead —
  // and on **this** screen `files` is the whole of it. `WorldOptions.visitor`
  // reaches `/api/radar/cnpj` and the screening routes only; `GET
  // /api/tenders/:id` carries no visitor and the Opportunity screen passes
  // none to the view, so it is `files` alone that says "signed in" here.
  return tender({ id: EDITAL, files: FILES })
}

async function world(page: Parameters<typeof installRadarApi>[0]) {
  return installRadarApi(page, {
    companies: [{ company: MARTA.company, tenders: [withFiles()] }],
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

  test('without the parameter it still opens on Itens', async ({ page }) => {
    // The other half. Reading `?tab=files` must not make Documentos the
    // default for everybody — this is the assertion that fails if somebody
    // ever "fixes" the tab by hardcoding it.
    await world(page)

    await page.goto(`${editalPath(EDITAL)}?cnpj=${MARTA.cnpj}`)

    await expect(page.getByRole('tab', { name: 'Itens' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('link', { name: /Termo_de_Referencia/ })).toBeHidden()
  })

  test('the strip is still a live control after the URL has chosen for it', async ({ page }) => {
    // Deep-linking into a tab must not freeze it. This exercises the **strip**
    // and nothing else: it neither needs nor proves anything about resetting
    // the tab when the tender changes, which no code here does — the App
    // Router remounts the screen on a new id and `useState` reads the new URL.
    await world(page)

    await page.goto(`${editalPath(EDITAL)}?cnpj=${MARTA.cnpj}&tab=files`)
    await expect(page.getByRole('link', { name: /Termo_de_Referencia/ })).toBeVisible()

    await page.getByRole('tab', { name: 'Itens' }).click()
    await expect(page.getByRole('link', { name: /Termo_de_Referencia/ })).toBeHidden()

    await page.getByRole('tab', { name: 'Documentos' }).click()
    await expect(page.getByRole('link', { name: /Termo_de_Referencia/ })).toBeVisible()
  })
})
