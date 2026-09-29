import { expect, test } from '@playwright/test'
import { installRadarApi } from '../fixtures/radar-api'
import { item, MARTA, processo, tender } from '../fixtures/world'

/**
 * D29 — the tender's two-column block is sized by the block, not by the window.
 *
 * The columns used to be `min-[900px]:`, a **viewport** query. D20 then put a
 * rail beside the content — `hidden lg:block` from 1024px, 264px wide — and
 * nothing reconciled the two numbers, so from 1024px to about 1164px the block
 * drew two columns inside roughly 760px.
 *
 * `opportunity-view.test.tsx` pins the *mechanism* (a container, a container
 * query, no viewport query). It cannot pin the *result*: `renderToStaticMarkup`
 * has no layout, so a unit test would pass on a block that still overlaps. That
 * is CLAUDE.md §4b's pattern — the test exercising the unit and not the path —
 * and it is why this file exists. Here the question is asked the only way it
 * can be answered: measure both sections and see whether they are beside each
 * other.
 *
 * The widths are chosen at the boundaries, not in the comfortable middle:
 *
 *   390    phone, no rail            stacked
 *   1023   just below `lg`, no rail  side by side  (content 983)
 *   1024   `lg`, rail 264            **stacked**   (content 720 — the defect)
 *   1164   rail 264                  side by side  (content 860 — the threshold)
 *   1440   rail 264                  side by side
 */

const TENDER_ID = '51885242000140-1-000080/2026'

/** Whether the two sections are drawn beside each other rather than stacked. */
async function sideBySide(page: import('@playwright/test').Page): Promise<boolean> {
  const why = page.locator('section').filter({ hasText: 'Por que este edital apareceu' }).first()
  const operation = page.locator('section').filter({ hasText: 'Operação' }).first()
  const [a, b] = await Promise.all([why.boundingBox(), operation.boundingBox()])
  if (!a || !b) throw new Error('both sections must be on screen')
  // `items-start` puts the columns on one baseline, so equal tops and a
  // rightward offset is two columns; anything else is the stacked flow.
  return Math.abs(a.y - b.y) < 4 && b.x > a.x + a.width / 2
}

test.describe('D29 · the tender block asks its own width', () => {
  test.beforeEach(async ({ page }) => {
    const edital = tender({
      id: TENDER_ID,
      object: `AQUISIÇÃO DE MATERIAL DE LIMPEZA, PROCESSO ${processo(80)}`,
      items: [item(1), item(2)],
      itemCount: 2,
    })
    await installRadarApi(page, { companies: [{ company: MARTA.company, tenders: [edital] }] })
    await page.goto(`/radar/edital/${TENDER_ID}?cnpj=${MARTA.cnpj}&group=compatible`)
    await expect(page.getByText('Por que este edital apareceu para você')).toBeVisible()
  })

  for (const { width, columns, why } of [
    { width: 390, columns: false, why: 'a phone has room for one' },
    { width: 1023, columns: true, why: 'below `lg` there is no rail, so the content is 983px' },
    { width: 1024, columns: false, why: 'the rail takes 264px and leaves 720px — the defect D29 fixes' },
    { width: 1164, columns: true, why: 'the content reaches 860px, the threshold' },
    { width: 1440, columns: true, why: 'plainly wide enough' },
  ]) {
    test(`${width}px · ${columns ? 'two columns' : 'stacked'} — ${why}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      expect(await sideBySide(page)).toBe(columns)
    })
  }

  /**
   * The rail is collapsible to 56px and that state lives in `localStorage`, so
   * no media query can observe it. A viewport query is wrong here in both
   * directions: it drew two columns where there was no room, and it would
   * refuse them where there is.
   */
  test('1024px with the rail collapsed · two columns, because the content is 920px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 900 })
    expect(await sideBySide(page)).toBe(false)

    // `COLLAPSED_KEY` in `components/app-shell.tsx`, and `'1'` is the only
    // value it reads as collapsed.
    await page.evaluate(() => localStorage.setItem('licitaqui.rail.collapsed', '1'))
    await page.reload()
    await expect(page.getByText('Por que este edital apareceu para você')).toBeVisible()
    expect(await sideBySide(page)).toBe(true)
  })
})
