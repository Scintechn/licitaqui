import { expect, test } from '@playwright/test'
import { messages } from '@/lib/messages'
import { installRadarApi } from '../fixtures/radar-api'
import { cards } from '../fixtures/screen'
import { company, MARTA, tenderRun } from '../fixtures/world'

/**
 * A CNPJ neither BrasilAPI nor CNPJá could read — Sci's search of 2026-10-09,
 * which drew zero editais under *"Os editais abaixo vêm só da palavra-chave;
 * tente o CNPJ de novo em alguns minutos"* with no keyword and nothing below.
 *
 * ## Why these are browser tests
 *
 * Two of the three things this pins happen **after** mount, which
 * `environment: 'node'` never reaches (CLAUDE.md §4c): the cursor moving to the
 * keyword field (`FocusKeyword`'s effect), and a restored list re-reading its
 * status in the background (`revalidate`). `radar-view.test.tsx` pins the
 * **mechanism** — which sentence for which state, and that the disclosure is
 * rendered open; `match-status.test.ts` pins the decision. This file pins the
 * **result** a reader sees.
 */

const copy = messages.radar.states
const UNREAD = company({ cnpj: MARTA.cnpj, mainCnae: null, segments: [] })
const QUERY = 'expediente'

test.describe('a CNPJ whose activities could not be read', () => {
  test('with no keyword: says why nothing is listed, opens the search, cursor in the keyword', async ({
    page,
  }) => {
    await installRadarApi(page, {
      companies: [{ company: UNREAD, tenders: [], manualCnae: true }],
    })

    await page.goto(`/radar?cnpj=${MARTA.cnpj}`)

    await expect(page.getByText(copy.manualCnaeBodyNoKeyword)).toBeVisible()
    // The sentence this card exists to retire, and the promise it made.
    await expect(page.getByText(/alguns minutos/)).toHaveCount(0)
    await expect(page.locator('#radar-q')).toBeVisible()
    await expect(page.locator('#radar-q')).toBeFocused()

    // Once per CNPJ, not once per load: another tab puts the screen through
    // its loading state and back, and must not pull the cursor (and a phone's
    // keyboard) back to the field after the reader moved it.
    await page.locator('#radar-q').blur()
    await page.getByRole('link', { name: /Verificar/ }).click()
    await expect(page).toHaveURL(/group=check/)
    await expect(page.getByText(copy.manualCnaeBodyNoKeyword)).toBeVisible()
    await expect(page.locator('#radar-q')).not.toBeFocused()
  })

  test('with a keyword: the card sits above the keyword’s editais, and leaves the cursor alone', async ({
    page,
  }) => {
    await installRadarApi(page, {
      companies: [
        {
          company: UNREAD,
          tenders: tenderRun(3, () => ({ group: 'keyword' })),
          manualCnae: true,
        },
      ],
    })

    await page.goto(`/radar?cnpj=${MARTA.cnpj}&q=${QUERY}`)

    await expect(cards(page).first()).toBeVisible()
    const card = page.getByText(copy.manualCnaeBodyKeyword)
    await expect(card).toBeVisible()
    // Above the list it describes.
    const cardBox = await card.boundingBox()
    const firstBox = await cards(page).first().boundingBox()
    expect(cardBox && firstBox && cardBox.y < firstBox.y).toBe(true)
    await expect(page.locator('#radar-q')).not.toBeFocused()
  })

  test('a CNPJ both sources say does not exist asks to check the number', async ({ page }) => {
    await installRadarApi(page, {
      companies: [{ company: UNREAD, tenders: [], manualCnae: true, cnpjNotFound: true }],
    })

    await page.goto(`/radar?cnpj=${MARTA.cnpj}`)

    await expect(page.getByText(copy.manualCnaeBodyNotFound)).toBeVisible()
    await expect(page.getByText(copy.manualCnaeBodyNoKeyword)).toHaveCount(0)
    // The number it asks to check is in reach, and the cursor is left alone.
    await expect(page.locator('input[name="cnpj"]')).toBeVisible()
    await expect(page.locator('#radar-q')).not.toBeFocused()
  })

  /**
   * The defect the new card would have exposed: a list saved in this state is
   * restored for half an hour, and its background refresh used to update the
   * editais and never the status — so the "could not read" card would have sat
   * above the company's real list after the worker read it.
   *
   * With a keyword, because only a list **with editais** is saved
   * (`radar-screen.tsx`'s save effect skips an empty one) — so this is the only
   * shape in which the stale status could ever be restored.
   */
  test('once the company is read, a restored list drops the card on its refresh', async ({
    page,
  }) => {
    await page.clock.install()
    await page.clock.resume()

    const rows = tenderRun(4, () => ({ group: 'keyword' }))
    const api = await installRadarApi(page, {
      companies: [{ company: UNREAD, tenders: rows, manualCnae: true }],
    })
    await page.goto(`/radar?cnpj=${MARTA.cnpj}&q=${QUERY}`)
    await expect(page.getByText(copy.manualCnaeBodyKeyword)).toBeVisible()
    await expect(cards(page)).toHaveCount(4)

    // The worker reads the company. Same editais, now with a company behind them.
    api.world.companies[0] = { company: MARTA.company, tenders: rows }

    const before = await page.evaluate(() => Date.now())
    await page.clock.fastForward('02:00')
    const after = await page.evaluate(() => Date.now())
    expect(after - before, 'past REVALIDATE_AFTER_MS, or this proves nothing').toBeGreaterThan(60_000)

    // The premise: a snapshot saved in the "could not read" state is there to
    // be restored. Without it the reload is a cold load, which decides the
    // status from scratch and would pass with or without the fix.
    const saved = await page.evaluate(() =>
      Object.keys(sessionStorage)
        .filter((name) => name.startsWith('licitaqui.radar.list:'))
        .map((name) => JSON.parse(sessionStorage.getItem(name) ?? '{}').status),
    )
    expect(saved).toContain('manualCnae')

    await page.reload()

    await expect(cards(page)).toHaveCount(4)
    await expect(page.getByText(copy.manualCnaeTitle)).toHaveCount(0)
  })
})
