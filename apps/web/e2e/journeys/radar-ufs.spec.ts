import { expect, test, type Page } from '@playwright/test'
import { installRadarApi } from '../fixtures/radar-api'
import { cards } from '../fixtures/screen'
import { MARTA, tenderRun } from '../fixtures/world'

/**
 * More than one UF (2026-10-09). A customer who delivers to several states had
 * a `<select>` offering one of them or the whole country.
 *
 * ## Why these are browser tests
 *
 * Everything that makes the control a control is a handler or an effect —
 * ticking a region ticks its states, a partly ticked region is indeterminate
 * (a DOM property with no attribute), Escape and a click outside close the
 * panel, the button's text follows the boxes — and `environment: 'node'` runs
 * none of them (CLAUDE.md §4c). `components/uf-picker.test.tsx` pins the first
 * render and `lib/radar/ufs.test.ts` the strings; this file pins what a reader
 * can do with it, end to end: the landing form, the Radar's request, an edital
 * and back.
 */

async function open(page: Page, id: string) {
  await page.locator(`#${id}`).click()
}

const indeterminate = (page: Page, name: string) =>
  page.getByRole('checkbox', { name, exact: true }).evaluate((box) => (box as HTMLInputElement).indeterminate)

test.describe('choosing several UFs', () => {
  test('from the landing: a region plus one more state reaches the Radar, the route and back', async ({
    page,
  }) => {
    const api = await installRadarApi(page, {
      companies: [{ company: MARTA.company, tenders: tenderRun(3) }],
    })
    await page.goto('/')

    await page.getByLabel('CNPJ da empresa').fill(MARTA.cnpj)
    await open(page, 'uf')
    await page.getByRole('checkbox', { name: 'Sudeste', exact: true }).check()
    await page.getByRole('checkbox', { name: 'Bahia (BA)' }).check()
    // Five ticked: three named, and the rest counted (approved copy).
    await expect(page.locator('#uf-value')).toHaveText('BA, ES, MG e mais 2')

    await page.getByRole('button', { name: 'Encontrar editais' }).click()
    await expect(page).toHaveURL(/\/radar\?/)
    expect(new URL(page.url()).searchParams.getAll('uf')).toEqual(['BA', 'ES', 'MG', 'RJ', 'SP'])

    // The route is asked for every one of them — not the last, which is what
    // `Object.fromEntries` would have kept on the server.
    await expect(cards(page).first()).toBeVisible()
    const asked = new URL(api.calls.tenders.at(-1) ?? '', 'https://x.test').searchParams
    expect(asked.getAll('state')).toEqual(['BA', 'ES', 'MG', 'RJ', 'SP'])

    // The header says the same thing the button did.
    await expect(page.getByText('BA, ES, MG e mais 2').first()).toBeVisible()

    // An edital and back: every UF survives the round trip.
    await cards(page).first().click()
    await expect(page).toHaveURL(/\/radar\/edital\//)
    await page.getByRole('link', { name: 'Voltar' }).click()
    await expect(page).toHaveURL(/\/radar\?/)
    expect(new URL(page.url()).searchParams.getAll('uf')).toEqual(['BA', 'ES', 'MG', 'RJ', 'SP'])
  })

  test('on the Radar: regions tick their states, a partial region is indeterminate, and Todo o Brasil clears', async ({
    page,
  }) => {
    await installRadarApi(page, {
      companies: [{ company: MARTA.company, tenders: tenderRun(3) }],
    })
    await page.goto(`/radar?cnpj=${MARTA.cnpj}&uf=SP`)
    await expect(cards(page).first()).toBeVisible()

    await page.getByText('Trocar empresa ou filtros', { exact: true }).click()
    await expect(page.locator('#radar-uf-value')).toHaveText('São Paulo (SP)')
    await open(page, 'radar-uf')

    // One of Sudeste's four: the region is neither ticked nor clear.
    expect(await indeterminate(page, 'Sudeste')).toBe(true)
    await expect(page.getByRole('checkbox', { name: 'Sudeste', exact: true })).not.toBeChecked()

    // Ticking it ticks the other three, and the button names the region.
    await page.getByRole('checkbox', { name: 'Sudeste', exact: true }).check()
    for (const name of ['Espírito Santo (ES)', 'Minas Gerais (MG)', 'Rio de Janeiro (RJ)']) {
      await expect(page.getByRole('checkbox', { name })).toBeChecked()
    }
    expect(await indeterminate(page, 'Sudeste')).toBe(false)
    await expect(page.locator('#radar-uf-value')).toHaveText('Sudeste')

    // Escape closes the panel and gives the button back its focus.
    await page.keyboard.press('Escape')
    await expect(page.getByRole('checkbox', { name: 'Sudeste', exact: true })).toBeHidden()

    await page.getByRole('button', { name: 'Aplicar filtros' }).click()
    await expect(page).toHaveURL(/uf=RJ/)
    expect(new URL(page.url()).searchParams.getAll('uf')).toEqual(['ES', 'MG', 'RJ', 'SP'])

    // Todo o Brasil clears every box, and the search carries no UF at all.
    // The filters are an uncontrolled `<details>` and stay open across a
    // client-side apply, so pressing their summary again would close them.
    if (!(await page.locator('#radar-uf').isVisible())) {
      await page.getByText('Trocar empresa ou filtros', { exact: true }).click()
    }
    await open(page, 'radar-uf')
    await page.getByRole('checkbox', { name: 'Todo o Brasil' }).check()
    await expect(page.getByRole('checkbox', { name: 'Minas Gerais (MG)' })).not.toBeChecked()
    await expect(page.locator('#radar-uf-value')).toHaveText('Todo o Brasil')
    await page.getByRole('button', { name: 'Aplicar filtros' }).click()
    await expect.poll(() => new URL(page.url()).searchParams.getAll('uf')).toEqual([])
  })

  test('an old single-UF link still opens on that UF', async ({ page }) => {
    const api = await installRadarApi(page, {
      companies: [{ company: MARTA.company, tenders: tenderRun(3) }],
    })
    await page.goto(`/radar?cnpj=${MARTA.cnpj}&uf=sp`)
    await expect(cards(page).first()).toBeVisible()
    const asked = new URL(api.calls.tenders.at(-1) ?? '', 'https://x.test').searchParams
    expect(asked.getAll('state')).toEqual(['SP'])
  })
})
