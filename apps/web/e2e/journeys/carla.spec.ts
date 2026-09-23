import { expect, test } from '@playwright/test'
import { installRadarApi, type CompanyWorld } from '../fixtures/radar-api'
import { card, cards } from '../fixtures/screen'
import { CARLA, processo, tenderRun } from '../fixtures/world'

/**
 * **Carla** — bookkeeper, several clients, one afternoon and one tab.
 *
 * ## The trap she exists to catch
 *
 * `rememberUserCnpj` only ever fills a `null`. That is deliberate — *"changing
 * a company is an account setting, not a side effect of one search"* — but the
 * setting did not exist, so **the first company anybody happened to search
 * became permanent**. For Carla that is not an implementation detail: it is
 * the second client showing up with the first one's name on top.
 *
 * On the screens the rule is simple, and it is what the tests below assert:
 * **every screen speaks about the CNPJ in the address bar**, and going back to
 * a client brings back that client's list. If the trap returns in any form — a
 * cache keyed wrong, a company name kept outside the lookup, a snapshot shared
 * between CNPJs — this is where it shows.
 *
 * The half that needs a session — changing the CNPJ **on the account**, at
 * `/conta` — is in `e2e/accounts/`, because it needs a real sign-in.
 */

const limpeza = CARLA.limpeza
const hospitalar = CARLA.hospitalar

/** Her two clients, with editais that could not be mistaken for each other. */
function clients(hospitalCount = 9): CompanyWorld[] {
  return [
    { company: limpeza.company, tenders: tenderRun(4) },
    {
      company: hospitalar.company,
      tenders: tenderRun(hospitalCount, (index) => ({
        id: `33444555000163-1-${String(index + 1).padStart(6, '0')}/2026`,
        object:
          `AQUISIÇÃO DE MATERIAL HOSPITALAR, PROCESSO ${processo(500 + index + 1)}, ` +
          'PARA A REDE MUNICIPAL DE SAÚDE, CONFORME TERMO DE REFERÊNCIA',
      })),
    },
  ]
}

test.describe('Carla · bookkeeper, two clients', () => {
  test('each client appears with its own name and its own editais', async ({ page }) => {
    const api = await installRadarApi(page, { companies: clients() })

    await page.goto(`/radar?cnpj=${limpeza.cnpj}&group=compatible`)
    await expect(page.getByText('Brilho Limpeza', { exact: false })).toBeVisible()
    await expect(cards(page)).toHaveCount(4)

    // Second client, same tab, a minute later.
    await page.goto(`/radar?cnpj=${hospitalar.cnpj}&group=compatible`)
    await expect(page.getByText('Vida Hospitalar', { exact: false })).toBeVisible()
    await expect(cards(page)).toHaveCount(9)
    await expect(page.getByText('Brilho Limpeza')).toHaveCount(0)
    await expect(card(page, processo(501))).toBeVisible()

    // And the second search really was for the second CNPJ — not a re-read of
    // the first company with a new list laid over it.
    expect(api.calls.cnpj.length, 'two clients, two lookups').toBe(2)
    const lastList = api.calls.tenders.at(-1) ?? ''
    expect(lastList).toContain(`cnpj=${hospitalar.cnpj}`)
    expect(lastList).not.toContain(limpeza.cnpj)
  })

  test('going back to the first client brings the first list, not the second', async ({ page }) => {
    await installRadarApi(page, { companies: clients() })

    await page.goto(`/radar?cnpj=${limpeza.cnpj}&group=compatible`)
    await expect(cards(page)).toHaveCount(4)

    await page.goto(`/radar?cnpj=${hospitalar.cnpj}&group=compatible`)
    await expect(cards(page)).toHaveCount(9)

    // The list cache is kept per search (`listKey`), and the CNPJ is one of the
    // four things that make the key. If it were not, she would be looking at
    // nine hospital editais with "Brilho Limpeza" written above them.
    await page.goto(`/radar?cnpj=${limpeza.cnpj}&group=compatible`)
    await expect(page.getByText('Brilho Limpeza', { exact: false })).toBeVisible()
    await expect(cards(page)).toHaveCount(4)
    await expect(page.getByText('Vida Hospitalar')).toHaveCount(0)
  })

  test('an edital of the second client goes back to the second client’s list', async ({ page }) => {
    await installRadarApi(page, { companies: clients(3) })

    await page.goto(`/radar?cnpj=${limpeza.cnpj}&group=compatible`)
    await expect(cards(page)).toHaveCount(4)

    await page.goto(`/radar?cnpj=${hospitalar.cnpj}&group=compatible`)
    await card(page, processo(502)).click()
    await expect(page).toHaveURL(/33444555000163-1-000002/)

    await page.getByRole('link', { name: 'Voltar' }).click()
    expect(new URL(page.url()).searchParams.get('cnpj')).toBe(hospitalar.cnpj)
    await expect(page.getByText('Vida Hospitalar', { exact: false })).toBeVisible()
    await expect(cards(page)).toHaveCount(3)
  })
})
