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

  test('is never served another company’s list, now that it is cached at all', async ({
    page,
  }) => {
    /*
     * **This test used to assert the opposite, and the change is the card.**
     *
     * Until D60 it was called *"is never served from the cache, because its key
     * cannot see the cookie"*, and it was right: `listKey` was the search and
     * nothing else, so for an address carrying neither `?cnpj=` nor `?q=` it
     * constrained **nothing** — Carla's two clients shared one key. D55
     * therefore switched the snapshot off for this shape, and the assertion
     * guarded that decision: a second visit *had* to ask the route again.
     *
     * The cost was the journey the cache exists for, which
     * `radar-snapshot-identity.spec.ts` now covers: coming back from an edital
     * opened here re-read page 1, lost the scroll and threw away every "Ver
     * mais editais" page. `listKey` now opens with the caller's opaque scope, so
     * the key names what the route resolved and the two clients' lists are two
     * entries.
     *
     * What survives from the old test is the half that was never about caching:
     * **a changed company is never served the previous one's rows.** It is the
     * same journey, asserted the other way round — not "a request was made" but
     * "this is the right company, and none of the other one's cards are here".
     */
    const api = await installRadarApi(page, {
      companies: clients(),
      cookieCnpj: limpeza.cnpj,
    })

    await page.goto('/radar')
    await expect(cards(page)).toHaveCount(4)
    await expect(page.getByText('Brilho Limpeza')).toBeVisible()

    // She moves to her other client, which is what writes `visitors.cnpj` — and
    // what stamps the cookie stating its generation. Both move together, which
    // is what `setCookieCnpj` is for: assigning to `world.cookieCnpj` alone
    // would move the answers and not the key, and *that* is the defect.
    await api.setCookieCnpj(hospitalar.cnpj)

    // Back to the same bare address, seconds later — inside
    // `REVALIDATE_AFTER_MS`, where a direct key hit is served with **no request
    // at all**. The old key would have handed back Brilho's four editais under
    // Brilho's name while the device is on Vida, and nothing on screen would
    // have said so.
    await page.goto('/radar')

    await expect(page.getByText('Vida Hospitalar')).toBeVisible()
    await expect(cards(page)).toHaveCount(9)
    await expect(page.getByText('Brilho Limpeza')).toHaveCount(0)
    await expect(page.getByText('4 CNAEs')).toHaveCount(0)
    assertBare(page.url())

    // And the header has not been swapped over the previous company's rows,
    // which is the shape D19 fixed and D55's first attempt at this card
    // recreated: `revalidate` merges page 1 by id. A changed scope is a key
    // miss, so that merge has no input — asserted on screen, where the mixture
    // would be visible, rather than by counting requests.
    await expect(page.getByText(processo(501)), 'Vida’s rows, not Brilho’s').toBeVisible()
  })
})
