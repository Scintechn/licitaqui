import { expect, test } from '@playwright/test'
import { installRadarApi } from '../fixtures/radar-api'
import { card, cards, groupTabs, noFabricatedZero, noUrgency, scrollY } from '../fixtures/screen'
import { daysAgo, item, MARTA, OBJECT_TAIL, processo, tender, tenderRun } from '../fixtures/world'

/**
 * **Dona Marta again, with one question:** *is this edital worth my time?*
 *
 * These are not usability tests. They are the framing rules of legal brief
 * §2.2 checked on the screen, which is the only place they are worth
 * anything. Each one comes from a defect that reached production:
 *
 * | # | what was wrong |
 * |---|---|
 * | #72 | `R$ 0,00` on five screens. PNCP's zero is not a price: it is what it writes when the budget is withheld |
 * | #72 | "sigiloso" and "não informado" are different facts and were saying the same thing |
 * | #61 | a **suspended** edital printing "último dia", "restantes" and "✓ Ainda dá tempo" — §2.2 rule 6 |
 * | #62 | the chosen tab empty with 36 editais one chip away, and the screen silent about it |
 * | 09-23 | the chips and the filter row doing nothing at all with a list on screen — found here, fixed in the PR that unfailed the last two tests |
 */

test.describe('Dona Marta · is this worth my time?', () => {
  test('an edital with no published value says "Valor não informado" — and no R$ 0,00', async ({
    page,
  }) => {
    // What PNCP actually returns on these rows: zero on the total and zero on
    // every item (#72: `94703980000132-1-000080/2026` is one of them).
    const noValue = tender({
      id: '51885242000140-1-000080/2026',
      object: `AQUISIÇÃO DE MATERIAL DE LIMPEZA, PROCESSO ${processo(80)}, SEM ORÇAMENTO PUBLICADO PELO ÓRGÃO`,
      estimatedValue: '0',
      confidentialBudget: false,
      items: [
        item(1, { unitEstimatedValue: '0', totalValue: '0' }),
        item(2, { unitEstimatedValue: null, totalValue: null }),
      ],
      itemCount: 2,
    })

    await installRadarApi(page, { companies: [{ company: MARTA.company, tenders: [noValue] }] })

    await page.goto(`/radar?cnpj=${MARTA.cnpj}&group=compatible`)
    await expect(card(page, processo(80))).toContainText('Valor não informado')
    await noFabricatedZero(page)

    await card(page, processo(80)).click()
    await expect(page.getByText('Valor não informado')).toBeVisible()
    await expect(page.getByText('Valor sigiloso')).toHaveCount(0)
    await noFabricatedZero(page)

    // …and in the items table, where twenty rows of `R$ 0,00` would be twenty
    // fabricated prices.
    await expect(page.getByRole('tab', { name: 'Itens' })).toHaveAttribute('aria-selected', 'true')
    await noFabricatedZero(page)
  })

  test('an edital with a confidential budget says "Valor sigiloso", which is a different fact', async ({
    page,
  }) => {
    const confidential = tender({
      id: '51885242000140-1-000081/2026',
      object: `CONTRATAÇÃO DE SERVIÇOS, PROCESSO ${processo(81)}, COM ORÇAMENTO SIGILOSO DECLARADO`,
      // The zero on the row is still there; what changes is that the agency
      // declared the budget secret.
      estimatedValue: '0',
      confidentialBudget: true,
    })

    await installRadarApi(page, { companies: [{ company: MARTA.company, tenders: [confidential] }] })

    await page.goto(`/radar?cnpj=${MARTA.cnpj}&group=compatible`)
    await expect(card(page, processo(81))).toContainText('Valor sigiloso')
    await expect(card(page, processo(81))).not.toContainText('Valor não informado')
    await noFabricatedZero(page)

    await card(page, processo(81)).click()
    await expect(page.getByText('Valor sigiloso')).toBeVisible()
    await noFabricatedZero(page)
  })

  test('a suspended edital shows the banner and no hurry — not in the list, the edital or the triagem', async ({
    page,
  }) => {
    const suspended = tender({
      id: '13654405000195-1-000033/2026',
      object: `AQUISIÇÃO DE INSUMOS, PROCESSO ${processo(33)}, SUSPENSA PELO ÓRGÃO`,
      status: 'Suspensa',
      pncpUpdatedAt: daysAgo(1),
    })

    const api = await installRadarApi(page, {
      companies: [{ company: MARTA.company, tenders: [suspended, ...tenderRun(2)] }],
    })
    api.screening.state = 'ready'

    await page.goto(`/radar?cnpj=${MARTA.cnpj}&group=compatible`)

    // In the list: the status is visible **before** she opens it — §3.3,
    // because otherwise she spends the click to find out.
    const suspendedCard = card(page, processo(33))
    await expect(suspendedCard).toContainText('Suspensa')
    await expect(suspendedCard).not.toContainText('Proposta até')
    await expect(suspendedCard).toContainText('Data anterior')
    // The others stay normal: the rule suppresses urgency about this edital,
    // not urgency on the whole screen.
    await expect(card(page, processo(1))).toContainText('Proposta até')

    await suspendedCard.click()
    await expect(page.getByRole('status').first()).toContainText('Edital SUSPENSO pelo órgão em')
    await expect(page.getByText('Suspensão não é cancelamento', { exact: false })).toBeVisible()
    await expect(page.getByText('Prazo suspenso')).toBeVisible()
    await expect(page.getByText('data anterior')).toBeVisible()
    await noUrgency(page)

    // §3.5: the same banner on every AI result screen for this edital. Someone
    // who arrived straight at the triagem from a link would have no other way
    // of learning the tender had been stopped.
    await page.getByRole('link', { name: 'Ver triagem por IA' }).click()
    await expect(page.getByRole('status').first()).toContainText('Edital SUSPENSO pelo órgão em')
    await noUrgency(page)
  })

  test('when the chosen tab is empty she lands on the one that has editais', async ({ page }) => {
    await installRadarApi(page, { companies: [{ company: MARTA.company, tenders: toCheck() }] })

    // No `?group=` — she chose no tab, she came from the Landing's search.
    await page.goto(`/radar?cnpj=${MARTA.cnpj}`)

    // The count on the chip is said out loud, not only drawn: "Verificar 12
    // editais" is the chip's accessible name, and a bare `0` next to
    // "Verificar" was a digit with no noun.
    await expect(groupTabs(page).getByRole('link', { name: 'Verificar 12 editais' })).toHaveAttribute(
      'aria-current',
      'page',
    )
    await expect(cards(page)).toHaveCount(12)
    await expect(page.getByText('pode haver exigências')).toBeVisible()
  })

  test('an empty tab says how many editais are in the other one and leads there', async ({
    page,
  }) => {
    await installRadarApi(page, { companies: [{ company: MARTA.company, tenders: toCheck() }] })

    // Compatíveis on purpose — the address a shared link carries.
    await page.goto(`/radar?cnpj=${MARTA.cnpj}&group=compatible`)

    await expect(page.getByText('Nenhum edital compatível agora')).toBeVisible()
    const shortcut = page.getByRole('link', { name: 'Ver 12 editais em Verificar' })
    await expect(shortcut).toBeVisible()
    await shortcut.click()
    await expect(cards(page)).toHaveCount(12)
  })

  /**
   * **The defect these two found on 2026-09-23, now fixed.** They ran as
   * `test.fail()` for the hours in between and are ordinary assertions now,
   * which is the only honest state for a test whose subject works: a
   * `test.fail()` left behind after the fix goes red and teaches everyone to
   * ignore it.
   *
   * What was wrong: with a list on screen, **the Radar's entire navigation did
   * nothing**. A chip changed the address to `?group=check` and left the
   * Compatíveis list where it was; "Aplicar filtros" changed it to `uf=RJ` and
   * left the list where it was. No request left in either case. It came back
   * only on a full document load or once the snapshot expired (30 min) — and
   * three chips and a filter row are all the navigation this screen has.
   *
   * Cause, in `app/radar/radar-screen.tsx`: the effect that writes the
   * snapshot depends on `[key, data]` and is declared **before** the effect
   * that loads. A client-side navigation re-renders with the **new** key while
   * `data` is still the list read for the **old** one, so the write stamped the
   * previous list under the new search's key. The loader then found a direct
   * hit in `restoreList` and returned without asking for anything — and
   * because the snapshot held the very array already on screen, without
   * re-rendering either.
   *
   * Two guards, both in the fix. `Data` carries the key it was read for and
   * the writing effect bails when that disagrees with the key on screen, so a
   * snapshot can only ever be written under the key it belongs to. And
   * `restoreList` refuses a **direct** hit whose `snapshot.group` disagrees
   * with the group asked for — the check the `auto` path already made.
   *
   * What these must never start asserting is that coming back to the *same*
   * search fetches. It must not, and `dona-marta.spec.ts` holds that line. The
   * distinction is the whole fix: same key restores, a different key fetches.
   */
  test('switching tabs with a list on screen switches the list', async ({ page }) => {
    const api = await installRadarApi(page, {
      companies: [{ company: MARTA.company, tenders: [...tenderRun(3), ...toCheck()] }],
    })

    await page.goto(`/radar?cnpj=${MARTA.cnpj}&group=compatible`)
    await expect(cards(page)).toHaveCount(3)
    const asked = api.calls.tenders.length

    await groupTabs(page).getByRole('link', { name: 'Verificar 12 editais' }).click()
    await expect(page).toHaveURL(/group=check/)

    // The list is the other one — twelve editais a secondary CNAE reaches, not
    // the three the main one does.
    await expect(cards(page)).toHaveCount(12)
    await expect(groupTabs(page).getByRole('link', { name: /^Verificar/ })).toHaveAttribute(
      'aria-current',
      'page',
    )

    // …and it came from the route rather than from the snapshot of the tab she
    // just left, which is the half of this that was silently wrong.
    await expect
      .poll(() => api.calls.tenders.length, { message: 'the new tab was never even requested' })
      .toBeGreaterThan(asked)
    expect(api.calls.tenders.at(-1), 'and it was asked for as Verificar').toContain('group=check')
  })

  /** The same defect on the other control of the screen. See the note above. */
  test('changing the filters and applying re-runs the search', async ({ page }) => {
    const api = await installRadarApi(page, {
      companies: [{ company: MARTA.company, tenders: [...tenderRun(3), ...cleaning()] }],
    })

    // Eight compatible editais with no keyword: three about expediente, five
    // about limpeza.
    await page.goto(`/radar?cnpj=${MARTA.cnpj}&group=compatible`)
    await expect(cards(page)).toHaveCount(8)
    const asked = api.calls.tenders.length

    // Both fields of the row, because both are the same submit: the UF is the
    // one the defect was reproduced on, and the keyword is what makes the
    // answer visibly a different list rather than the same rows re-drawn.
    await page.getByText('Trocar empresa ou filtros', { exact: true }).click()
    await page.getByLabel('UF onde você entrega').selectOption('RJ')
    await page.getByLabel('Ou procure por palavra-chave (opcional)').fill('limpeza')
    await page.getByRole('button', { name: 'Aplicar filtros' }).click()

    await expect(page).toHaveURL(/uf=RJ/)
    await expect(cards(page)).toHaveCount(5)
    await expect(card(page, processo(201))).toBeVisible()

    await expect
      .poll(() => api.calls.tenders.length, { message: 'the search with the new UF never left' })
      .toBeGreaterThan(asked)
    expect(api.calls.tenders.at(-1)).toContain('state=RJ')
    expect(api.calls.tenders.at(-1)).toContain('q=limpeza')
  })

  /**
   * The narrow case between the two halves of the fix, which neither of the
   * tests above reaches and which the fix could easily have broken.
   *
   * She searched from the Landing, so the URL carries no `?group=` and the
   * list is filed under `auto`. Clicking the chip she is **already on** is a
   * client-side navigation to `?group=compatible`: a new key, for a list that
   * is already on screen and correct. `restoreList` matches it sideways and
   * the rows do not change — so the screen has nothing to re-render, and the
   * temptation is to do nothing at all.
   *
   * Doing nothing would leave the state stamped with the old key, and from
   * there the snapshot would never be re-saved under the key this URL looks
   * for: `rememberScroll` would write to a key nothing was stored under and
   * the way back would lose her place. That is #57/#62 coming back through the
   * side door, so it is asserted on the scroll — the thing it would cost.
   */
  test('the chip she is already on keeps the list, and the way back keeps her place', async ({
    page,
  }) => {
    const api = await installRadarApi(page, {
      companies: [{ company: MARTA.company, tenders: tenderRun(30) }],
      pageSize: 30,
    })

    // No `?group=` — this is the address the Landing's search produces.
    await page.goto(`/radar?cnpj=${MARTA.cnpj}`)
    await expect(cards(page)).toHaveCount(30)
    const asked = api.calls.tenders.length

    await groupTabs(page).getByRole('link', { name: /^Compatíveis/ }).click()
    await expect(page).toHaveURL(/group=compatible/)

    // Same list, and no reason to ask for it again: the key changed, but
    // `restoreList` recognises the snapshot as this very search's.
    await expect(cards(page)).toHaveCount(30)
    expect(api.calls.tenders.length, 'the same list must not be re-requested').toBe(asked)

    const chosen = card(page, processo(24))
    await chosen.scrollIntoViewIfNeeded()
    const before = await scrollY(page)
    expect(before, 'the test needs a real scroll to have anything to restore').toBeGreaterThan(1000)

    await chosen.click()
    await expect(page).toHaveURL(/\/radar\/edital\//)
    await page.getByRole('link', { name: 'Voltar' }).click()

    await expect(cards(page)).toHaveCount(30)
    const after = await scrollY(page)
    expect(Math.abs(after - before), 'the scroll goes back where she was').toBeLessThan(120)
  })
})

/**
 * Five editais about cleaning materials, which the keyword "limpeza" finds and
 * the rest of this world does not. They exist so that "the filter row ran the
 * search again" can be asserted on the **list** and not only on a request
 * counter: the fixture's world has no UF dimension, so a UF change alone comes
 * back with the same rows and proves nothing to a reader of the screen.
 */
function cleaning() {
  return tenderRun(5, (index) => ({
    id: `51885242000140-3-${String(index + 1).padStart(6, '0')}/2026`,
    object:
      `AQUISIÇÃO DE MATERIAL DE LIMPEZA, PROCESSO ${processo(201 + index)}, ` +
      `PARA A UNIDADE ADMINISTRATIVA ${index + 1} DA SECRETARIA MUNICIPAL DE SAÚDE, ` +
      `CONFORME CONDIÇÕES, QUANTIDADES E EXIGÊNCIAS ${OBJECT_TAIL}`,
  }))
}

/** Twelve editais a secondary CNAE reaches — the Verificar tab, populated. */
function toCheck() {
  return tenderRun(12, (index) => ({
    id: `51885242000140-2-${String(index + 1).padStart(6, '0')}/2026`,
    group: 'check' as const,
    matchedSegments: [
      {
        segment: 'Material de escritório e papelaria',
        fit: 'check' as const,
        fromMainCnae: false,
        fromSecondaryCnae: true,
      },
    ],
  }))
}
