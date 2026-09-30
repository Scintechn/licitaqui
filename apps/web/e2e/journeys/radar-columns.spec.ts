import { expect, test, type Page } from '@playwright/test'
import { installRadarApi } from '../fixtures/radar-api'
import { cards } from '../fixtures/screen'
import { MARTA, tenderRun } from '../fixtures/world'

/**
 * D30 — the Radar list is sized by its own column, not by the window.
 *
 * The grid used to be `min-[900px]:grid-cols-2 min-[1280px]:grid-cols-3`,
 * **viewport** queries. D20 then put a rail in the layout flow beside the
 * content — `hidden lg:block` from 1024px, 264px wide, collapsible to 56px
 * through `localStorage` — and nothing reconciled the numbers. The list is
 * `main` (`max-w-[1120px]`) inside `px-gutter`, so it measures
 * `min(viewport − rail, 1120) − 2×20`, and at 1280px with the rail out that is
 * 976px drawn as three columns: ~318px cards, on the screen people spend the
 * most time on.
 *
 * `radar-view.test.tsx` pins the *mechanism* — the container, its placement,
 * both thresholds, no viewport query. It cannot pin the *result*:
 * `renderToStaticMarkup` has no layout, so a unit test passes on a grid that
 * still draws three columns in 976px. That is CLAUDE.md §4b's pattern, the
 * test exercising the unit and not the path, and it is why this file exists.
 * Here the question is asked the only way it can be answered — measure the
 * cards and count the ones sharing the top row.
 *
 * ## The widths, and why these ones
 *
 * Every case is a boundary, and **none sits on a threshold**. 1164px is the
 * exact width at which the column reaches 860.000px, and a test pinned there
 * asserts that a floating-point tie breaks the way it broke today: one CSS
 * pixel lost anywhere above `main` — a border, a padding, a scrollbar — flips
 * it. So the threshold is proved from 4px below and 16px above instead.
 *
 * `viewport` here means `documentElement.clientWidth`, not the window. They
 * are the same in headless Chromium, which hides scrollbars, and they differ
 * by ~15px for a real reader on Windows or Linux — so a person at a 1170px
 * window is one column, not two. That is the rule working on the width it was
 * actually given; it is written down because the numbers below would
 * otherwise look like promises about window sizes.
 */

const CNPJ = MARTA.cnpj

/**
 * How many cards are drawn beside each other on the first row.
 *
 * Only cards with a box: an element matching the href prefix but hidden has
 * `y === 0`, which would become the minimum and be counted as row one. No such
 * card exists on this screen today, but `tender-items.tsx` two directories
 * over is built exactly that way — `hidden md:block` beside `md:hidden` — so
 * the shape is live in this codebase and the filter is cheap.
 */
async function columns(page: Page, expected: number): Promise<number> {
  const boxes = await cards(page).evaluateAll((els) =>
    els
      .map((el) => el.getBoundingClientRect())
      .filter((box) => box.width > 0 && box.height > 0)
      .map((box) => box.y),
  )
  // More cards than the answer, or "three of three" would confirm four
  // columns as readily as three.
  expect(boxes.length, 'the list needs more cards than the columns it draws').toBeGreaterThan(
    expected,
  )
  const first = Math.min(...boxes)
  // Equal tops is one row: a grid puts every row on one baseline, whatever the
  // cards in it happen to be tall.
  return boxes.filter((y) => Math.abs(y - first) < 4).length
}

/** `'1'` is the only value `COLLAPSED_KEY` in `components/app-shell.tsx` reads. */
async function collapseRail(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.setItem('licitaqui.rail.collapsed', '1'))
  await page.reload()
  await expect(cards(page).first()).toBeVisible()
}

test.describe('D30 · the Radar list asks its own width', () => {
  test.beforeEach(async ({ page }) => {
    await installRadarApi(page, {
      companies: [{ company: MARTA.company, tenders: tenderRun(6) }],
    })
    await page.goto(`/radar?cnpj=${CNPJ}&group=compatible`)
    await expect(cards(page).first()).toBeVisible()
  })

  for (const { width, expected, why } of [
    { width: 390, expected: 1, why: 'a phone: the column is 350px' },
    { width: 1023, expected: 2, why: 'just below `lg`, no rail yet — the column is 983px' },
    { width: 1024, expected: 1, why: 'the rail takes 264px and leaves 720px — the defect D30 fixes' },
    { width: 1160, expected: 1, why: 'the column is 856px, four short of the two-column threshold' },
    { width: 1180, expected: 2, why: 'the column is 876px, and two columns have room' },
    { width: 1280, expected: 2, why: 'the column is 976px, and the window used to say three' },
    { width: 1380, expected: 2, why: 'the column is 1076px, four short of the third column' },
    { width: 1440, expected: 3, why: '`main` is at its 1120px cap, so the column is 1080px' },
  ]) {
    test(`${width}px · ${expected} column${expected > 1 ? 's' : ''} — ${why}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      expect(await columns(page, expected)).toBe(expected)
    })
  }

  /**
   * The rail collapses to 56px and that state lives in `localStorage`, which no
   * media query can observe. Both directions of that blindness are below, and
   * they are **different widths**, because at 1024 the old rule happened to
   * agree with the new one once the rail was out of the way.
   */
  test('1024px · one column with the rail out, two when it retracts to 56px', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 })
    expect(await columns(page, 1)).toBe(1)

    // 1024 − 56 = 968, less the gutters: 928px, and two columns fit.
    await collapseRail(page)
    expect(await columns(page, 2)).toBe(2)
  })

  /**
   * The one band where the window **under**-counted: from 1176px with the rail
   * retracted the column is already at `main`'s 1120px cap, so it measures the
   * same 1080px it has at 1440px with the rail out — where three columns were
   * never in dispute — and the old `min-[1280px]` refused them anyway.
   *
   * It is also the only place a card gets narrower than it used to (535 → 353),
   * which is the reason to state it in a test rather than leave it to be found.
   */
  test('1200px with the rail collapsed · three columns, because the column is 1080px', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1200, height: 900 })
    expect(await columns(page, 2)).toBe(2)

    await collapseRail(page)
    expect(await columns(page, 3)).toBe(3)
  })
})
