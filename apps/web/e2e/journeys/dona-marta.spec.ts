import { expect, test } from '@playwright/test'
import { installRadarApi } from '../fixtures/radar-api'
import { card, cards, scrollY, trail } from '../fixtures/screen'
import { MARTA, OBJECT_TAIL, processo, tenderRun } from '../fixtures/world'

/**
 * **Dona Marta** — MEI, a papelaria in Campinas, no account.
 *
 * She arrives from a link somebody sent her, types her CNPJ, looks at the
 * Radar, opens an edital, reads the Objeto and the Itens, and goes back. None
 * of that may require an account, and the list she comes back to has to be the
 * list she left.
 *
 * ## What each test here is guarding
 *
 * The third one is #62. A Radar card is a plain `<a>`, so opening an edital
 * **unloads the document** and no React cleanup runs. Reproduced on production
 * before `lib/radar/list-cache.ts` existed: three pages loaded, scrolled to
 * 3 000 px, open a tender, press Back — zero cards, scroll 0, "Consultando o
 * CNPJ…" again. To the person reading, that is indistinguishable from having
 * lost the search.
 *
 * The fourth is #68: nine links dropped the search on the way. The fix made
 * the `search` argument required, which turns a bare link into a type error —
 * **but only for links**, not for a URL built with a template string. This one
 * walks the whole path and reads the address at the end of it.
 */

test.describe('Dona Marta · MEI, no account', () => {
  test('arrives from a link, types her CNPJ and sees her papelaria’s editais', async ({ page }) => {
    const api = await installRadarApi(page, {
      companies: [{ company: MARTA.company, tenders: tenderRun(3) }],
    })

    const visited = trail(page)
    await page.goto('/')

    // The CNPJ lookup is held open until the test lets it go: the waiting state
    // is asserted because the answer has not arrived, never because a clock
    // said it was time to look.
    const lookup = api.hold('cnpj')

    await page.getByLabel('CNPJ da empresa').fill(MARTA.cnpj)
    await page.getByRole('button', { name: 'Encontrar editais' }).click()

    await expect(page).toHaveURL(new RegExp(`/radar\\?cnpj=${MARTA.cnpj}`))
    await expect(page.getByText('Consultando o CNPJ…')).toBeVisible()
    await expect(page.getByText('Lendo as atividades registradas da empresa.')).toBeVisible()

    lookup.open()

    // Her Radar: the company name, how many CNAEs were read, and the editais.
    await expect(page.getByRole('heading', { name: 'Radar', level: 1 })).toBeVisible()
    await expect(page.getByText('Papelaria Dona Marta · 1 CNAE · Todo o Brasil')).toBeVisible()
    await expect(cards(page)).toHaveCount(3)

    // She is a visitor, and the screen says what that means instead of asking
    // her to sign up.
    await expect(page.getByText('Visitante')).toBeVisible()
    await expect(page.getByText('3 dias · 2 triagens')).toBeVisible()

    // At no point was she taken to a sign-up screen.
    expect(visited.filter((url) => url.includes('/conta'))).toEqual([])
    expect(api.calls.unexpected).toEqual([])
  })

  test('opens an edital and reads the whole Objeto and the itens, without an account', async ({
    page,
  }) => {
    const api = await installRadarApi(page, {
      companies: [{ company: MARTA.company, tenders: tenderRun(3) }],
    })

    const visited = trail(page)
    await page.goto(`/radar?cnpj=${MARTA.cnpj}&group=compatible`)

    // On the card she reads the start of the object, trimmed, and can see
    // there is more.
    await expect(card(page, processo(2))).toContainText('…')
    await card(page, processo(2)).click()

    // The address is the PNCP id, with the slash surviving as two segments.
    await expect(page).toHaveURL(/\/radar\/edital\/51885242000140-1-000002\/2026/)
    await expect(page.getByRole('heading', { level: 1 })).toContainText('…')

    // Brief §2.2 rule 4 applied to the whole screen: the agency's own words
    // come before any reading of ours. The Objeto is here **whole** — its tail
    // exists nowhere else, not on the card and not in the title — and it is
    // **above** the tabs (#64, #66).
    const objeto = page.getByText(OBJECT_TAIL)
    await expect(objeto).toBeVisible()
    const tabs = page.getByRole('tablist')
    const objetoBox = await objeto.boundingBox()
    const tabsBox = await tabs.boundingBox()
    expect(objetoBox!.y, 'the Objeto must come before the tabs (#64, #66)').toBeLessThan(tabsBox!.y)

    // Itens is the open tab: it is why Sci was opening PNCP beside us.
    await expect(page.getByRole('tab', { name: 'Itens' })).toHaveAttribute('aria-selected', 'true')
    // `.first()`: at 390px the items table is in the document twice — labelled
    // rows on a phone, a real `<table>` from `md` up — and the CSS picks. One
    // of the two is visible, and it is the one she reads.
    await expect(page.getByText('Item 1 · resma de papel A4', { exact: false }).first()).toBeVisible()

    // She can open Documentos; what is locked is the file, and the screen says
    // so instead of pushing her into a sign-up.
    await page.getByRole('tab', { name: 'Documentos' }).click()
    await expect(page.getByText('Edital e anexos · criar conta')).toBeVisible()

    await page.getByRole('link', { name: 'Voltar' }).click()
    await expect(page).toHaveURL(new RegExp(`/radar\\?cnpj=${MARTA.cnpj}`))

    expect(visited.filter((url) => url.includes('/conta'))).toEqual([])
    expect(api.calls.unexpected).toEqual([])
  })

  test('comes back from an edital to the list where she left it — three pages and the scroll', async ({
    page,
  }) => {
    const api = await installRadarApi(page, {
      companies: [{ company: MARTA.company, tenders: tenderRun(60) }],
      pageSize: 20,
    })

    await page.goto(`/radar?cnpj=${MARTA.cnpj}&group=compatible`)
    await expect(cards(page)).toHaveCount(20)

    // She pulls the list down: 20, 40, 60.
    await page.getByRole('button', { name: 'Ver mais editais' }).click()
    await expect(cards(page)).toHaveCount(40)
    await page.getByRole('button', { name: 'Ver mais editais' }).click()
    await expect(cards(page)).toHaveCount(60)
    await expect(page.getByText('Mostrando 60 de 60')).toBeVisible()

    // …and scrolls down to one that interests her, well below the fold.
    const chosen = card(page, processo(47))
    await chosen.scrollIntoViewIfNeeded()
    const before = await scrollY(page)
    expect(before, 'the test needs a real scroll to have anything to restore').toBeGreaterThan(1000)

    const cnpjReads = api.calls.cnpj.length
    const listReads = api.calls.tenders.length

    await chosen.click()
    await expect(page).toHaveURL(/\/radar\/edital\//)

    // "Voltar" here is a document navigation — the card is an `<a>` and the tab
    // rebuilds the Radar from scratch. It is exactly the path that lost
    // everything.
    await page.getByRole('link', { name: 'Voltar' }).click()

    await expect(cards(page)).toHaveCount(60)
    await expect(page.getByText('Mostrando 60 de 60')).toBeVisible()
    await expect(page.getByText('Consultando o CNPJ…')).toHaveCount(0)

    const after = await scrollY(page)
    expect(Math.abs(after - before), 'the scroll goes back where she was').toBeLessThan(120)

    // Nothing was asked for again: the snapshot is under a minute old, and
    // §3.1 says a re-read that soon would return the same rows. A
    // `company_lookup` charged to re-read the list she was reading ten seconds
    // ago is the cost this cache exists not to pay.
    expect(api.calls.cnpj.length, 'going back must not re-analyse the CNPJ').toBe(cnpjReads)
    expect(api.calls.tenders.length, 'going back must not re-search the list').toBe(listReads)
  })

  test('the search survives edital → triagem → back → back', async ({ page }) => {
    const api = await installRadarApi(page, {
      companies: [{ company: MARTA.company, tenders: tenderRun(5) }],
    })
    api.screening.state = 'ready'

    const search = `cnpj=${MARTA.cnpj}&uf=SP&q=expediente&group=compatible`
    await page.goto(`/radar?${search}`)
    await expect(cards(page)).toHaveCount(5)

    // The card's link carries the search with it — the four things that decide
    // which list this edital came from (`lib/radar/client.ts`).
    const first = card(page, processo(1))
    const href = await first.getAttribute('href')
    for (const part of ['cnpj=11222333000181', 'uf=SP', 'q=expediente', 'group=compatible']) {
      expect(href, `the card link dropped "${part}"`).toContain(part)
    }

    await first.click()
    await expect(page).toHaveURL(/q=expediente/)

    // …and the button that leads *forward* off this screen carries the same
    // search. This is the one that broke: "Voltar" was fixed and the outbound
    // link was not.
    const triagem = page.getByRole('link', { name: 'Ver triagem por IA' })
    const triagemHref = await triagem.getAttribute('href')
    for (const part of ['cnpj=11222333000181', 'uf=SP', 'q=expediente', 'group=compatible']) {
      expect(triagemHref, `the triagem link dropped "${part}"`).toContain(part)
    }

    await triagem.click()
    await expect(page).toHaveURL(/\/triagem\?/)
    await expect(page.getByText('Boa para empresa pequena')).toBeVisible()

    // Two presses of Voltar and she is on the list she came from, with the
    // filter and the tab intact.
    await page.getByRole('link', { name: 'Voltar' }).click()
    await expect(page).toHaveURL(/\/radar\/edital\/.*q=expediente/)

    await page.getByRole('link', { name: 'Voltar' }).click()
    const final = new URL(page.url())
    expect(final.pathname).toBe('/radar')
    expect(final.searchParams.get('cnpj')).toBe(MARTA.cnpj)
    expect(final.searchParams.get('uf')).toBe('SP')
    expect(final.searchParams.get('q')).toBe('expediente')
    expect(final.searchParams.get('group')).toBe('compatible')
    await expect(cards(page)).toHaveCount(5)
  })
})
