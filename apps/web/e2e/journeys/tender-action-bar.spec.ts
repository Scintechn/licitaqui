import { expect, test, type Locator, type Page } from '@playwright/test'
import { installRadarApi } from '../fixtures/radar-api'
import { item, MARTA, processo, tender } from '../fixtures/world'
import { messages } from '@/lib/messages'

/**
 * D25 (3) — the fixed action bar covers nothing, and exists only below `lg`.
 *
 * Sci's journey, 2026-09-29: *"the decision is below the fold"*. The bar takes
 * the tender screen's one action out of the scroll — and a `fixed` element is
 * out of flow, so the same move that puts the action on screen puts it **over**
 * the end of the page. On these screens the end of the page is the last row of
 * the Itens list, which is exactly what the card predicted would clip.
 *
 * `opportunity-view.test.tsx` pins the *mechanism*: the bar is asked for, it is
 * `lg:hidden`, it is `z-40`, and the `main` asks for the clearance.
 * `environment: 'node'` has no boxes, so it cannot tell whether the clearance
 * is **enough** — a `pb-4` would pass every one of those assertions and still
 * bury the last item. That is CLAUDE.md §4b's pattern, the test exercising the
 * unit and not the path, and it is why this file exists.
 */

const TENDER_ID = '51885242000140-1-000080/2026'
const copy = messages.radar.opportunity

/**
 * The bar's own box, selected by the classes that *are* the mechanism.
 *
 * Normally these journeys select the way a person finds things — by the words
 * on screen. There is no word for "the fixed container": its label belongs to
 * the button inside it, and what has to be measured is the container. The
 * class is the thing under test, so naming it here is naming the subject.
 */
function actionBar(page: Page): Locator {
  // **Not `.sticky`.** Whether the bar is in the flow is the thing these tests
  // measure, so selecting on it would make the clipping checks pass by not
  // finding a `fixed` bar at all rather than by finding nothing under it.
  // `bottom-0` and `z-40` are what makes it "the bar" in either scheme.
  return page.locator('div.bottom-0.z-40')
}

async function scrollToEnd(page: Page): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  // One frame for the scroll to settle before anything is measured.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => done(null))))
}

test.describe('D25 (3) · the tender action bar', () => {
  test.beforeEach(async ({ page }) => {
    const edital = tender({
      id: TENDER_ID,
      object: `AQUISIÇÃO DE MATERIAL DE LIMPEZA, PROCESSO ${processo(80)}`,
      // Enough rows that the list is what the bar would cover.
      items: Array.from({ length: 20 }, (_, i) => item(i + 1)),
      itemCount: 20,
    })
    await installRadarApi(page, { companies: [{ company: MARTA.company, tenders: [edital] }] })
    await page.goto(`/radar/edital/${TENDER_ID}?cnpj=${MARTA.cnpj}&group=compatible`)
    await expect(page.getByText('Por que este edital apareceu para você')).toBeVisible()
  })

  test('390px · the action is on screen without scrolling for it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 })
    const bar = actionBar(page)
    await expect(bar).toBeVisible()

    // Pinned to the bottom of the viewport, not sitting in the page flow.
    const [box, viewport] = await Promise.all([
      bar.boundingBox(),
      page.evaluate(() => window.innerHeight),
    ])
    expect(box).not.toBeNull()
    expect(Math.abs((box!.y + box!.height) - viewport)).toBeLessThan(2)
  })

  test('1280px · no bar, because the rail is in the flow and no offset is right', async ({
    page,
  }) => {
    // The rail is 56px or 264px of layout and that state is `localStorage`, so
    // a `fixed` bar has no correct `left` at this width in either state. The
    // in-page CTA is what a desktop reader uses, and it is already visible.
    await page.setViewportSize({ width: 1280, height: 900 })
    await expect(actionBar(page)).toBeHidden()
    await expect(page.getByRole('link', { name: copy.screeningCta })).toBeVisible()
  })

  /**
   * The assertion the unit test cannot make. `BAR_CLEARANCE` is a number
   * chosen from the bar's parts; this is what checks the number is right.
   */
  /**
   * The assertion no unit test can make — and the one the first version of
   * this file only appeared to make.
   *
   * It measured `main li` last, which on this screen is the last **item**, not
   * the last content: the `mt-auto` block below `<Record>` (the PNCP link, the
   * portal button, the freshness caption) sits 286px further down. So the
   * check had 286px of slack against a ~90px bar, and setting the old
   * `BAR_CLEARANCE` to `pb-0` left it green. That is the shape CLAUDE.md §4b
   * names: a test that cannot fail on the defect it is named for.
   *
   * This measures the **lowest bottom of anything inside `main`**, which is
   * the real end of the page, and it does it at the three widths where the
   * bar's own height differs — 320, 360 and 390 — and in both label states,
   * because "Ver a triagem que você pediu" wraps below 390 and makes the bar
   * 32px taller.
   */
  for (const width of [320, 360, 390]) {
    for (const spent of [false, true]) {
      test(`${width}px · nothing is under the bar, ${
        spent ? 'with the longer returning label' : 'first visit'
      }`, async ({ page }) => {
        if (spent) {
          await page.goto(
            `/radar/edital/${TENDER_ID}/triagem?cnpj=${MARTA.cnpj}&group=compatible`,
          )
          await page.goBack()
          await expect(page.getByText('Por que este edital apareceu para você')).toBeVisible()
        }
        await page.setViewportSize({ width, height: 720 })
        await scrollToEnd(page)

        const lowest = await page.evaluate(() => {
          const main = document.querySelector('main')
          if (main === null) return null
          let bottom = Number.NEGATIVE_INFINITY
          for (const el of main.querySelectorAll('*')) {
            const box = el.getBoundingClientRect()
            if (box.width > 0 && box.height > 0) bottom = Math.max(bottom, box.bottom)
          }
          return bottom
        })
        const bar = await actionBar(page).boundingBox()
        expect(lowest).not.toBeNull()
        expect(bar).not.toBeNull()
        expect(
          lowest!,
          'the end of the page must finish above the bar, not under it',
        ).toBeLessThanOrEqual(bar!.y + 0.5)
      })
    }
  }

  /**
   * **The action the bar exists for, followed.** The four journey specs now
   * scope their locator to `main`, so without this nothing in the suite ever
   * presses the bar's primary — the control this card is about would be
   * reachable, measured, and never once used.
   */
  test('390px · the primary slot opens the triagem', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 })
    await actionBar(page).getByRole('link', { name: copy.screeningCta }).click()
    await expect(page).toHaveURL(/\/triagem\?/)
  })

  test('390px · both slots clear the 44px touch target', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 })
    const buttons = actionBar(page).getByRole('link')
    await expect(buttons).toHaveCount(2)
    for (const box of await buttons.evaluateAll((els) =>
      els.map((el) => el.getBoundingClientRect().height),
    )) {
      // `--spacing-touch` is 44px; `--spacing-control` is 48 and is what these
      // buttons take, so this is the floor rather than the target.
      expect(box).toBeGreaterThanOrEqual(44)
    }
  })

  /**
   * The second slot leads to the record, and the record is on this page. A
   * link to a fragment nothing defines would be an approved control leading
   * nowhere — the same shape as `radar.list.changeCompany`, approved copy
   * rendered in no file.
   */
  test('390px · the second slot lands on the Itens and Documentos block', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 780 })
    await actionBar(page).getByRole('link', { name: copy.barRecord }).click()

    await expect(page).toHaveURL(/#/)
    const hash = new URL(page.url()).hash.slice(1)
    const target = page.locator(`#${hash}`)
    await expect(target).toBeVisible()
    await expect(target.getByRole('tab', { name: copy.tabs.items })).toBeVisible()
  })
})
