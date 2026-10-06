import { expect, test } from '@playwright/test'
import { messages } from '@/lib/messages'
import { installRadarApi, type CompanyWorld } from '../fixtures/radar-api'
import { cards } from '../fixtures/screen'
import { CARLA, processo, tenderRun } from '../fixtures/world'

/**
 * D55 — a bare `/radar` resumes the company the device already searched.
 *
 * ## Why this has to be a browser test
 *
 * Everything about it is unreachable from `environment: 'node'`. The CNPJ is in
 * `visitors.cnpj`, behind an `httpOnly` cookie no page script can read; the
 * decision happens **after mount**, in an effect that suite never runs
 * (CLAUDE.md §4c); and the thing being asserted is that a URL carrying
 * *neither* `?cnpj=` nor `?q=` ends up with a grouped list. The tell was in
 * D19's own browser test, which had to append `?q=expediente` to reach the
 * cookie path at all — the very `?q=` these tests exist to drop.
 *
 * `app/radar/bare-radar.test.tsx` pins the **mechanism**: the in-flight status,
 * which answer counts as the refusal, and which query shapes depend on the
 * cookie. This file pins the **result**.
 *
 * ## No `?cnpj=` and no `?q=` in any URL below
 *
 * That is the point, so every `goto` is asserted to be bare. A test that
 * accidentally carried either parameter would pass against the defect.
 */

const copy = messages.radar
const limpeza = CARLA.limpeza
const hospitalar = CARLA.hospitalar

/** Her two clients, with editais that could not be mistaken for each other. */
function clients(): CompanyWorld[] {
  return [
    { company: limpeza.company, tenders: tenderRun(4), cnaeCount: 4 },
    {
      company: hospitalar.company,
      cnaeCount: 2,
      tenders: tenderRun(9, (index) => ({
        id: `33444555000163-1-${String(index + 1).padStart(6, '0')}/2026`,
        object:
          `AQUISIÇÃO DE MATERIAL HOSPITALAR, PROCESSO ${processo(500 + index + 1)}, ` +
          'PARA A REDE MUNICIPAL DE SAÚDE, CONFORME TERMO DE REFERÊNCIA',
      })),
    },
  ]
}

/** Neither half of the search is in the address — the whole premise. */
function assertBare(url: string): void {
  const params = new URL(url).searchParams
  expect(params.get('cnpj'), 'this test is only about a URL with no CNPJ').toBeNull()
  expect(params.get('q'), 'this test is only about a URL with no keyword').toBeNull()
}

test.describe('D55 · bare /radar uses the CNPJ it already has', () => {
  test('resumes the cookie company’s list and names it in the header', async ({ page }) => {
    const api = await installRadarApi(page, {
      companies: clients(),
      cookieCnpj: limpeza.cnpj,
    })

    await page.goto('/radar')

    // The list the route grouped by `visitors.cnpj`, and the header that
    // belongs to it (D19 made the route report it).
    await expect(cards(page)).toHaveCount(4)
    await expect(page.getByText('Brilho Limpeza')).toBeVisible()
    await expect(page.getByText('4 CNAEs')).toBeVisible()

    // The sentence this card exists to delete, and the one the screen used to
    // draw before any request left.
    await expect(page.getByText(copy.states.needCnpjTitle)).toHaveCount(0)

    // It learned the company from the answer, not from the address: the URL is
    // still bare, and no `POST /api/radar/cnpj` ever happened — there was no
    // CNPJ in the page to post.
    assertBare(page.url())
    expect(api.calls.cnpj, 'nothing in the page could have posted a CNPJ').toEqual([])
    expect(api.calls.tenders.length, 'the route was asked').toBeGreaterThan(0)
    expect(api.calls.tenders.every((url) => !url.includes('cnpj='))).toBe(true)
  })

  test('with no cookie it still says to start from the CNPJ — after asking', async ({ page }) => {
    const api = await installRadarApi(page, {
      companies: clients(),
      // This device has never searched a CNPJ.
    })

    await page.goto('/radar')

    await expect(page.getByText(copy.states.needCnpjTitle)).toBeVisible()
    await expect(cards(page)).toHaveCount(0)
    // No company is claimed and no CNAE match is asserted anywhere.
    await expect(page.getByText(copy.list.noCompany)).toBeVisible()
    await expect(page.getByText(copy.list.groupHint.compatible)).toHaveCount(0)

    // And it is the route's answer that said so, not the screen's own guess:
    // the short-circuit this card removed made no request at all.
    expect(api.calls.tenders.length, 'the refusal must be an answer').toBeGreaterThan(0)
    assertBare(page.url())
  })

  test('never flashes the refusal while the list is in flight', async ({ page }) => {
    const api = await installRadarApi(page, {
      companies: clients(),
      cookieCnpj: limpeza.cnpj,
    })
    const gate = api.hold('tenders')

    await page.goto('/radar')
    await gate.reached

    // The one frame that would be a lie. D24 is the same shape in reverse: a
    // state that was correct for exactly one render and then replaced.
    await expect(page.getByText(copy.states.analyzingListTitle)).toBeVisible()
    await expect(page.getByText(copy.states.needCnpjTitle)).toHaveCount(0)
    // Nor the other read's wording: no CNPJ was posted, so nothing is being
    // looked up.
    await expect(page.getByText(copy.states.analyzingCompanyTitle)).toHaveCount(0)
    // And the header withholds rather than denying a company it cannot see.
    await expect(page.getByText(copy.list.noCompany)).toHaveCount(0)
    await expect(page.getByText(copy.list.groupHintNoCnae)).toHaveCount(0)

    gate.open()
    await expect(cards(page)).toHaveCount(4)
    await expect(page.getByText(copy.states.needCnpjTitle)).toHaveCount(0)
  })

  test('is never served from the cache, because its key cannot see the cookie', async ({
    page,
  }) => {
    const api = await installRadarApi(page, {
      companies: clients(),
      cookieCnpj: limpeza.cnpj,
    })

    await page.goto('/radar')
    await expect(cards(page)).toHaveCount(4)
    await expect(page.getByText('Brilho Limpeza')).toBeVisible()

    // She moves to her other client — which is what writes `visitors.cnpj`.
    // The cookie is the route's business, so the world holds it.
    api.world.cookieCnpj = hospitalar.cnpj

    // Back to the same bare address, seconds later — inside
    // `REVALIDATE_AFTER_MS`, where `list-cache.ts` serves a direct key hit with
    // **no request at all**. `listKey` has no CNPJ in it, so that snapshot
    // would hand back Brilho's four editais under Brilho's name while the
    // device is on Vida, and nothing on screen would say so.
    const asked = api.calls.tenders.length
    await page.goto('/radar')

    await expect(page.getByText('Vida Hospitalar')).toBeVisible()
    await expect(cards(page)).toHaveCount(9)
    await expect(page.getByText('Brilho Limpeza')).toHaveCount(0)
    expect(
      api.calls.tenders.length,
      'a list whose CNPJ is only in the cookie must not come from the cache',
    ).toBeGreaterThan(asked)
    assertBare(page.url())
  })
})
