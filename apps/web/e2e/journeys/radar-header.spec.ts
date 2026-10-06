import { expect, test } from '@playwright/test'
import { installRadarApi } from '../fixtures/radar-api'
import { cards, groupTabs } from '../fixtures/screen'
import { MARTA, tenderRun } from '../fixtures/world'

/**
 * D19 — the Radar header reports the company the list is actually grouped by.
 *
 * Sci's screenshot, 2026-10-06, of `/radar?q=canvas&group=compatible`: the
 * header read **"Sua empresa · sem CNAE lido · Todo o Brasil"**, and directly
 * under it **"Compatíveis 13"** and **"seu CNAE atende"**. His question on
 * 2026-09-28 was the right one — *"I didnt enter my CNPJ, so how those tenders
 * can be compatible with a null CNPJ?"*
 *
 * ## Why this has to be a browser test
 *
 * The cause is a state the URL cannot express. `GET /api/radar/tenders`
 * resolves the CNPJ as `?cnpj= ?? visitors.cnpj` and groups on that company's
 * segments; the screen resolved it from `?cnpj=` alone, so with no `?cnpj=` it
 * held `null` and the header described a company it had never been told about.
 * The cookie carrying that CNPJ is `httpOnly` — no browser code can read it,
 * which is exactly why the header had to be told rather than left to work it
 * out.
 *
 * `renderToStaticMarkup` cannot reach any of that: the company arrives in a
 * response, after mount, and `environment: 'node'` runs no effects
 * (CLAUDE.md §4c). `app/radar/radar-header.test.tsx` pins the **mechanism** —
 * one input, and the header and tab help as functions of it. This file pins the
 * **result**: a Radar opened with no `?cnpj=` at all.
 */

const COMPANY = MARTA.company
/** The word every fixture object contains, so the keyword search finds them. */
const QUERY = 'expediente'

test.describe('D19 · the header names the company the list grouped by', () => {
  /**
   * The screenshot, reproduced: no `?cnpj=` anywhere, and the list grouped by
   * the CNPJ this device searched last.
   */
  test('a CNPJ in the visitor cookie is named, not reported as "sem CNAE lido"', async ({
    page,
  }) => {
    await installRadarApi(page, {
      companies: [{ company: COMPANY, tenders: tenderRun(6), cnaeCount: 4 }],
      cookieCnpj: MARTA.cnpj,
    })

    await page.goto(`/radar?q=${QUERY}&group=compatible`)
    await expect(cards(page).first()).toBeVisible()

    // The list is grouped by her company, so the header says whose it is.
    await expect(page.getByText('Papelaria Dona Marta')).toBeVisible()
    await expect(page.getByText('4 CNAEs')).toBeVisible()
    // The sentence this card exists to delete.
    await expect(page.getByText('sem CNAE lido')).toHaveCount(0)

    // And the tabs beside it still mean what they say.
    await expect(groupTabs(page).getByText('Compatíveis')).toBeVisible()
    await expect(page.getByText('seu CNAE atende')).toBeVisible()

    // The URL never gained a CNPJ: the header learned it from the response.
    expect(new URL(page.url()).searchParams.get('cnpj')).toBeNull()
  })

  /**
   * The other half of the acceptance criteria: with no company anywhere the
   * screen says so, and nothing on it claims a CNAE match — even on the
   * `compatible` tab, which a visitor can open straight from the address bar.
   */
  test('with no company at all it says so, and claims no CNAE anywhere', async ({ page }) => {
    await installRadarApi(page, {
      companies: [{ company: COMPANY, tenders: tenderRun(6) }],
      // No cookieCnpj: this device has never searched a CNPJ.
    })

    await page.goto(`/radar?q=${QUERY}&group=compatible`)
    await expect(page.getByText('Sem empresa informada')).toBeVisible()
    await expect(page.getByText('seu CNAE atende')).toHaveCount(0)
    await expect(page.getByText('sem CNAE lido para comparar')).toBeVisible()
    await expect(page.getByText('Papelaria Dona Marta')).toHaveCount(0)
  })

  /**
   * A CNPJ typed into the URL: the same single source answers, and the count is
   * the number of CNAEs on record rather than the number of segments they reach
   * (one segment, three CNAEs, in this world).
   */
  test('a CNPJ in the URL is named, and the count is CNAEs and not segments', async ({ page }) => {
    await installRadarApi(page, {
      companies: [{ company: COMPANY, tenders: tenderRun(6), cnaeCount: 3 }],
    })

    await page.goto(`/radar?cnpj=${MARTA.cnpj}&group=compatible`)
    await expect(cards(page).first()).toBeVisible()
    // One assertion on the whole line, because `getByText` resolves to the `<p>`:
    // an `exact: true` match on "1 CNAE" can never fire against
    // "Papelaria Dona Marta · 3 CNAEs · Todo o Brasil" and would be an inert
    // guard dressed as a check.
    const line = page.getByText('Papelaria Dona Marta')
    await expect(line).toHaveText(/· 3 CNAEs ·/)
    // `COMPANY.segments.length` is 1 — what the line used to render.
    expect(COMPANY.segments).toHaveLength(1)
    await expect(line).not.toHaveText(/· 1 CNAE ·/)
  })
})
