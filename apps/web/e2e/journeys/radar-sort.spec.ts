import { expect, test, type Page } from '@playwright/test'
import { format, messages } from '../../lib/messages'
import { installRadarApi } from '../fixtures/radar-api'
import { cards } from '../fixtures/screen'
import { MARTA, tenderRun } from '../fixtures/world'

/**
 * D51 — the order on the Radar is a control, and it is drawn in one line.
 *
 * `app/radar/sort-menu.test.tsx` pins the **mechanism**: three real `href`s, the
 * current order named, the control outside the filter `<summary>`, the hidden
 * `sort` field in the GET form. It cannot pin two things, both of which are the
 * reason this file exists (CLAUDE.md §4c):
 *
 * | what | why the unit test cannot see it |
 * |---|---|
 * | the row is still **one line** at 390px | `renderToStaticMarkup` has no boxes, and the label this control replaced was `absolute`: when it grows from "Ordenar: prazo" to "Ordenar: maior valor" it grows **over** the filter label rather than pushing it |
 * | the menu **closes** after choosing | `<details open>` is DOM state React does not own. It closes because the element is keyed on the active order, and a key only has an effect where there is a DOM to reconcile |
 *
 * There is a third thing only a browser can answer, and it is the whole premise
 * of the design: **the control works with JavaScript off.** That is asserted in
 * its own `describe` below, with a context that has none.
 *
 * ## What this file does not claim
 *
 * It does not claim the rows come back in the right order. Every `/api/**`
 * answer here is `e2e/fixtures/radar-api.ts`, which does not sort — deliberately,
 * because the suite is hermetic (see `playwright.config.ts`). *The rows are
 * ordered correctly* is `lib/radar/sort.db.test.ts`, against Postgres, across
 * four page boundaries in each of the three orders. Here the question is only
 * whether the reader can ask.
 */

const list = messages.radar.list
const CNPJ = MARTA.cnpj
const SEARCH = `/radar?cnpj=${CNPJ}&uf=SP&group=compatible`

/** The disclosure that opens the orders, named after the order in effect. */
function trigger(page: Page, order: string) {
  return page.getByLabel(`${list.sort} ${order}`)
}

/** One of the three orders, named after what choosing it does. */
function option(page: Page, order: string) {
  return page.getByRole('link', { name: format(list.sortBy, { ordem: order }) })
}

/** "Trocar empresa ou filtros" — the other label on the same line. */
function filterLabel(page: Page) {
  return page.getByText(list.changeCompany, { exact: true })
}

test.describe('D51 · the Radar list can be ordered', () => {
  test.beforeEach(async ({ page }) => {
    await installRadarApi(page, {
      companies: [{ company: MARTA.company, tenders: tenderRun(6) }],
    })
    await page.goto(SEARCH)
    await expect(cards(page).first()).toBeVisible()
  })

  test('Dona Marta can ask for the dearest editais first, and the address says so', async ({
    page,
  }) => {
    await expect(trigger(page, list.sortOrders.deadline)).toBeVisible()
    await trigger(page, list.sortOrders.deadline).click()

    const maior = option(page, list.sortOrders.valueDesc)
    await expect(maior).toBeVisible()
    await maior.click()

    await expect(page).toHaveURL(/sort=valueDesc/)
    // The search she was in is still the search she is in.
    await expect(page).toHaveURL(new RegExp(`cnpj=${CNPJ}`))
    await expect(page).toHaveURL(/uf=SP/)
    await expect(page).toHaveURL(/group=compatible/)
    await expect(cards(page).first()).toBeVisible()

    // The row now says which order it is in, and the menu has closed behind
    // her: the `<details>` is keyed on the active order, so the navigation
    // mounts a new, shut one. Without that key it would hang open over the list.
    await expect(trigger(page, list.sortOrders.valueDesc)).toBeVisible()
    await expect(option(page, list.sortOrders.valueAsc)).toBeHidden()
  })

  test('the way back to the deadline order is the address with no sort at all', async ({ page }) => {
    await page.goto(`${SEARCH}&sort=valueAsc`)
    await expect(cards(page).first()).toBeVisible()
    await trigger(page, list.sortOrders.valueAsc).click()
    await option(page, list.sortOrders.deadline).click()

    await expect(page).toHaveURL(new RegExp(`cnpj=${CNPJ}`))
    await expect(page).not.toHaveURL(/sort=/)
    await expect(trigger(page, list.sortOrders.deadline)).toBeVisible()
  })

  test('applying a filter keeps the order she chose', async ({ page }) => {
    await page.goto(`${SEARCH}&sort=valueDesc`)
    await expect(cards(page).first()).toBeVisible()

    await filterLabel(page).click()
    await page.getByLabel(messages.radar.landing.keywordLabel).fill('papel')
    await page.getByRole('button', { name: list.apply }).click()

    await expect(page).toHaveURL(/q=papel/)
    await expect(page).toHaveURL(/sort=valueDesc/)
  })

  /**
   * The other half of the same rule, and the only place it can be asserted.
   *
   * `FilterRow`'s hidden `group` field is gated on `groupChosen`, but its
   * `onSubmit` — the path a reader with JavaScript actually takes — passed
   * `query.group` unconditionally, so the two halves of one form disagreed: with
   * scripting the elected tab was pinned into the next search, without it the
   * election stood. Both read `groupChosen` now.
   *
   * It cannot be pinned in `sort-menu.test.tsx`: `onSubmit` is a handler, and
   * `renderToStaticMarkup` emits no handlers. So it is here, driven as a reader
   * drives it.
   */
  test('a tab the counts elected is not pinned by applying a filter', async ({ page }) => {
    // No `group=` in the address: the tab on screen is `bestGroup()`'s election.
    await page.goto(`/radar?cnpj=${CNPJ}`)
    await expect(cards(page).first()).toBeVisible()
    await expect(page).not.toHaveURL(/group=/)

    await filterLabel(page).click()
    // The UF control is a checkbox panel since 2026-10-09 (multi-UF).
    await page.locator('#radar-uf').click()
    await page.getByRole('checkbox', { name: 'Minas Gerais (MG)' }).check()
    await page.getByRole('button', { name: list.apply }).click()

    await expect(page).toHaveURL(/uf=MG/)
    // The election is re-run against the new counts rather than carried over —
    // a tab nobody chose must never pin a search, because it can be the empty one.
    await expect(page).not.toHaveURL(/group=/)
  })

  /**
   * The 390px frame, which is the one the board was drawn at.
   *
   * The label this control replaced was `position: absolute` over the right end
   * of the filter row, and that is kept — the form inside the filter
   * `<details>` is full width and shrinking the disclosure would shrink the form
   * with it. The cost of `absolute` is that an over-long label does not wrap or
   * push: it lands **on top of** "Trocar empresa ou filtros". "Ordenar: prazo"
   * always fitted; "Ordenar: maior valor" plus a chevron does not, by some 35px,
   * which is why the "Ordenar:" prefix is hidden below 480px.
   *
   * Both widths are asserted for the **longest** of the three orders, because
   * the default is the case that was never in danger.
   */
  for (const { width, prefix } of [
    { width: 390, prefix: false },
    { width: 480, prefix: true },
    { width: 720, prefix: true },
  ]) {
    test(`${width}px · the order and the filter label share one line, never a pixel`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`${SEARCH}&sort=valueDesc`)
      await expect(cards(page).first()).toBeVisible()

      const control = trigger(page, list.sortOrders.valueDesc)
      await expect(control).toBeVisible()

      const sort = await control.boundingBox()
      const label = await filterLabel(page).boundingBox()
      if (!sort || !label) throw new Error('both labels must have a box')

      // Side by side: the order starts after the filter label ends.
      expect(sort.x, `${width}px: the order overlaps "${list.changeCompany}"`).toBeGreaterThanOrEqual(
        label.x + label.width,
      )
      // One line: the two boxes share a vertical band rather than stacking.
      expect(Math.abs(sort.y - label.y)).toBeLessThan(sort.height)
      // Inside the frame, with the 20px gutter respected.
      expect(sort.x + sort.width).toBeLessThanOrEqual(width - 16)

      // And the prefix is there, or deliberately is not. `innerText`, never
      // `textContent`: the prefix is hidden with `display: none`, which
      // `textContent` cannot see — it would read "Ordenar: maior valor" at every
      // width and this assertion would be about the markup, not the screen.
      const shown = await control.innerText()
      expect(shown).toContain(list.sortOrders.valueDesc)
      expect(shown.includes(list.sort), `${width}px: "${list.sort}" visible`).toBe(prefix)
    })
  }
})

/**
 * The control is in the **first byte of HTML**, which is the claim that is
 * actually true and the one the design rests on.
 *
 * A `<select>` could not make it: with no script, changing a select submits
 * nothing. Three `<a href>`s inside a `<details>` need none — the disclosure and
 * the navigation are both the browser's.
 *
 * **What is deliberately *not* asserted here is "the page works with JavaScript
 * off".** It does not, and that predates D51 by every parameter: `app/radar/page.tsx`
 * wraps `RadarScreen` in a `<Suspense>` whose fallback is another `RadarView`, and
 * removing a streamed fallback is React's inline script. With scripting disabled
 * both copies stay in the document — two sort controls, and the fallback's one
 * built from a query it does not have yet. So the honest question is whether the
 * server sends the control, not whether a scriptless browser can finish the page,
 * and that is what this reads: the raw HTML, with no browser involved.
 */
test.describe('D51 · the order ships in the HTML', () => {
  test('the server sends all three orders as addresses, before any script runs', async ({
    request,
  }) => {
    const html = await (await request.get(SEARCH)).text()

    // The trigger, named after the order in effect.
    expect(html).toContain(`aria-label="${list.sort} ${list.sortOrders.deadline}"`)

    for (const order of [list.sortOrders.deadline, list.sortOrders.valueDesc, list.sortOrders.valueAsc]) {
      expect(html).toContain(`aria-label="${format(list.sortBy, { ordem: order })}"`)
    }
    // Real addresses, carrying the search, with the default spelt as its absence.
    expect(html).toContain(`href="/radar?cnpj=${CNPJ}&amp;uf=SP&amp;group=compatible"`)
    expect(html).toContain(`href="/radar?cnpj=${CNPJ}&amp;uf=SP&amp;group=compatible&amp;sort=valueDesc"`)
    expect(html).toContain(`href="/radar?cnpj=${CNPJ}&amp;uf=SP&amp;group=compatible&amp;sort=valueAsc"`)
    // Nothing on this row is a `<button>` or a `<select>` pretending to be one.
    expect(html).not.toContain('name="sortSelect"')
  })
})
