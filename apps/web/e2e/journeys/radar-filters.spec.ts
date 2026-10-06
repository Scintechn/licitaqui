import { expect, test, type Locator, type Page } from '@playwright/test'
import { installRadarApi } from '../fixtures/radar-api'
import { cards } from '../fixtures/screen'
import { MARTA, tenderRun } from '../fixtures/world'

/**
 * D52 — the filter row went from three controls to five, and it has to be drawn
 * by **this column's** width.
 *
 * `app/radar/radar-filters.test.tsx` pins the mechanism: the container, the two
 * thresholds, the absence of any viewport query above 720px. It cannot pin the
 * result — `environment: 'node'` has no boxes (CLAUDE.md §4c), so a row that
 * draws four 140px controls inside a 720px column passes every assertion there.
 * This file measures.
 *
 * ## The arithmetic the widths below come from
 *
 * The form is in `main` (`max-w-[1120px]`) inside `px-gutter`, beside
 * `app-shell.tsx`'s rail — in the layout flow from `lg` (1024px), **264px**
 * wide, or 56px collapsed, and that state is `localStorage`. So the form's own
 * width is
 *
 *   min(viewport − rail, 1120) − 2×20
 *
 * | viewport | rail | the form | columns |
 * |---|---|---|---|
 * | 390 | — | 350 | 1 |
 * | 1024 | 264 | **720** | 2 |
 * | 1024 | 56 | 928 | 4 |
 * | 1440 | 264 | 1080 | 4 |
 *
 * Rows two and three are the whole point: **the same window, two answers**, and
 * no media query can tell them apart. A `min-[880px]:` viewport query would
 * draw four controls in 720px at 1024 — D29 and D30 again, one screen along.
 */

const CNPJ = MARTA.cnpj

/** The five controls, in the order they are drawn, found the way a reader finds them. */
function controls(page: Page): Locator[] {
  return [
    page.getByLabel('CNPJ da empresa'),
    page.getByLabel('UF onde você entrega'),
    page.getByLabel('Modalidade'),
    page.getByLabel('ME/EPP'),
    page.getByLabel('Ou procure por palavra-chave (opcional)'),
  ]
}

function apply(page: Page): Locator {
  return page.getByRole('button', { name: 'Aplicar filtros' })
}

type Box = { x: number; y: number; width: number; height: number }

async function boxes(page: Page): Promise<Box[]> {
  const found: Box[] = []
  for (const control of [...controls(page), apply(page)]) {
    const box = await control.boundingBox()
    expect(box, 'every control in the open form has a box').not.toBeNull()
    found.push(box!)
  }
  return found
}

/** How many of them share the topmost row. */
function firstRow(found: Box[]): number {
  const top = Math.min(...found.map((box) => box.y))
  return found.filter((box) => Math.abs(box.y - top) < 4).length
}

/**
 * The filters live behind a disclosure, so the test opens it the way a person
 * does. §4b: a test that rendered the form without asking whether anything can
 * reach it would be the unit, not the path.
 */
async function openFilters(page: Page): Promise<void> {
  await page.getByText('Trocar empresa ou filtros').click()
  await expect(page.getByLabel('Modalidade')).toBeVisible()
}

/** `'1'` is the only value `COLLAPSED_KEY` in `components/app-shell.tsx` reads. */
async function collapseRail(page: Page): Promise<void> {
  await page.evaluate(() => localStorage.setItem('licitaqui.rail.collapsed', '1'))
  await page.reload()
  await expect(cards(page).first()).toBeVisible()
  await openFilters(page)
}

test.describe('D52 · the filter row is sized by its own column', () => {
  test.beforeEach(async ({ page }) => {
    await installRadarApi(page, {
      companies: [{ company: MARTA.company, tenders: tenderRun(6) }],
    })
    await page.goto(`/radar?cnpj=${CNPJ}&group=compatible`)
    await expect(cards(page).first()).toBeVisible()
  })

  test('390px · one control per row, and nothing hangs off the phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openFilters(page)

    const found = await boxes(page)
    // Six boxes, six rows: the column is 350px and a control is full width.
    expect(firstRow(found)).toBe(1)
    expect(new Set(found.map((box) => Math.round(box.y))).size).toBe(6)

    const viewport = await page.evaluate(() => document.documentElement.clientWidth)
    for (const box of found) {
      expect(box.x, 'a control starts inside the screen').toBeGreaterThanOrEqual(0)
      expect(Math.round(box.x + box.width)).toBeLessThanOrEqual(viewport)
    }
    // The whole document, not only these boxes: D48 is what one unbroken string
    // did to the price screen, and a 390px check is the only thing that sees it.
    const scroll = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }))
    expect(scroll.width).toBeLessThanOrEqual(scroll.client)
  })

  test('1024px · two columns, because the rail leaves the form 720px', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 })
    await openFilters(page)

    const found = await boxes(page)
    // The window is 1024 — past 880 — and the form is 720, so two.
    expect(firstRow(found)).toBe(2)

    // And nothing reaches past the column, whatever the window says.
    const column = await page.locator('main').boundingBox()
    expect(column).not.toBeNull()
    for (const box of found) {
      expect(Math.round(box.x + box.width)).toBeLessThanOrEqual(
        Math.round(column!.x + column!.width),
      )
    }
  })

  /**
   * **The discriminating case, and measured as one.**
   *
   * Replacing `@min-[880px]:` with the viewport `min-[880px]:` was tried while
   * writing this file: the test above still passed, because Tailwind emits the
   * `@container` rule after the `@media` one and it wins the tie at 1024px. This
   * test is the one that went red. Same window, two answers — and the state that
   * decides is `localStorage`, which no media query can read at all.
   */
  test('1024px · four across once the reader collapses the rail to 56px', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 })
    await openFilters(page)
    expect(firstRow(await boxes(page))).toBe(2)

    // 1024 − 56 = 968, less the gutters: 928px, and four fit. Same window, and
    // the difference lives in `localStorage` where no media query can read it.
    await collapseRail(page)
    expect(firstRow(await boxes(page))).toBe(4)
  })

  test('1440px · four across, with the keyword and the button on their own row', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await openFilters(page)

    const found = await boxes(page)
    expect(firstRow(found)).toBe(4)
    // The keyword and the button are the two that are not on the first row, and
    // they share the second — two rows in total, not three.
    expect(new Set(found.map((box) => Math.round(box.y))).size).toBe(2)
  })

  /**
   * **The share and the bookmark**: a cold load of an address that already
   * carries both filters.
   *
   * Everything else in this file reaches the filtered state by *applying* a
   * filter, which exercises `router.push` and then the effect. That is not the
   * path a link in a WhatsApp group takes. The first version of this file did
   * not have this test, and `radar-filters.test.tsx` cannot stand in for it:
   * that one hands `query.modality` straight to `RadarView`, so it proves
   * `FilterRow` draws what it is given and says nothing about whether
   * `RadarScreen` reads `?modality=` at all.
   */
  test('a shared address arrives already filtered, before anything is clicked', async ({
    page,
  }) => {
    const asked: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/api/radar/tenders')) asked.push(request.url())
    })

    await page.goto(`/radar?cnpj=${CNPJ}&group=compatible&modality=dispensa&meepp=exclusive`)
    await expect(cards(page).first()).toBeVisible()

    // The very first request for the list carried both filters: the reader was
    // never shown an unfiltered list for a frame.
    expect(asked[0], `the first list request: ${asked.join(' ')}`).toContain('modality=dispensa')
    expect(asked[0]).toContain('meepp=exclusive')

    // …and the controls say what the address says, so the reader can see which
    // filters they arrived with.
    await openFilters(page)
    await expect(page.getByLabel('Modalidade')).toHaveValue('dispensa')
    await expect(page.getByLabel('ME/EPP')).toHaveValue('exclusive')
  })

  /**
   * The seam, not the layout: the control is in a real GET form, so choosing a
   * modality has to reach the address bar and the route. Asserted in a browser
   * because `readSearch` ↔ `radarHref` ↔ `tendersUrl` agreeing in a unit test
   * says nothing about whether the `<select>` is wired to any of them.
   */
  test('choosing a filter reaches the URL and the request', async ({ page }) => {
    const asked: string[] = []
    page.on('request', (request) => {
      if (request.url().includes('/api/radar/tenders')) asked.push(request.url())
    })

    await openFilters(page)
    await page.getByLabel('Modalidade').selectOption('dispensa')
    await page.getByLabel('ME/EPP').selectOption('exclusive')
    await apply(page).click()

    await expect(page).toHaveURL(/modality=dispensa/)
    await expect(page).toHaveURL(/meepp=exclusive/)
    await expect(cards(page).first()).toBeVisible()
    expect(
      asked.some((url) => url.includes('modality=dispensa') && url.includes('meepp=exclusive')),
      `the list was asked for the filters: ${asked.join(' ')}`,
    ).toBe(true)
  })
})
