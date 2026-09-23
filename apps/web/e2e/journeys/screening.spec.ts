import { expect, test, type Page } from '@playwright/test'
import { installRadarApi } from '../fixtures/radar-api'
import { card } from '../fixtures/screen'
import { MARTA, processo, tenderRun } from '../fixtures/world'

/**
 * **Dona Marta asks for an AI reading of an edital** — and the waiting is the
 * product.
 *
 * ## #68, the more expensive of the two
 *
 * §3.1 gives the client sixty seconds: twenty ticks, three seconds apart. That
 * budget was written for a read whose job writes its row in one hop — a
 * `company_lookup`, one BrasilAPI call. An `ai_screening` is not that: it is
 * `sync_files`, a PDF download (§7.2 allows 120 s), `extract_text` and then
 * the lite model (90 s). The two budgets never agreed, and the client
 * **stopped reading** at 60 s — silently.
 *
 * Measured on production on 2026-09-22, CNPJ 36955612000185, tender
 * `13654405000195-1-000033/2026`: the screen said "está demorando" at 60 s and
 * made no further request; the row was readable at **≈178 s**. The only way
 * for the person to see their own answer was to navigate away and come back.
 *
 * So what this test asserts is not "the honest card appears" — that already
 * happened. It is that **after the deadline the screen keeps reading**, and
 * that the answer takes the card's place with no second navigation.
 *
 * ## Why the clock is Playwright's and not the system's
 *
 * Waiting sixty real seconds would be a `sleep` wearing a test's clothes. The
 * page's clock is installed and advanced (`page.clock`), so the deadlines
 * under test are the product's own — `POLL_TIMEOUT_MS`, `WATCH_INTERVAL_MS` —
 * and not the patience of whoever runs the suite. What is asserted is still a
 * condition: how many times the screen asked.
 */

const EDITAL = '51885242000140-1-000001/2026'

/**
 * Advance the page's clock in steps rather than in one jump.
 *
 * The poll is `await sleep(3s)` → `await fetch` → `await sleep(3s)`: only one
 * timer is ever scheduled at a time, and the next one is not born until the
 * answer arrives. A single `runFor(70_000)` would fire **one** timer and leave
 * the rest of the loop scheduled in a future the clock has already passed.
 * Each `await` here hands control back to the event loop so the answers land,
 * and the next step fires the timers they scheduled.
 */
async function advance(page: Page, ms: number, step = 5_000): Promise<void> {
  for (let moved = 0; moved < ms; moved += step) {
    await page.clock.runFor(Math.min(step, ms - moved))
  }
}

test.describe('Dona Marta · the AI triagem', () => {
  test('the reading outlasts the deadline, the screen says so and does not stop reading (#68)', async ({
    page,
  }) => {
    const api = await installRadarApi(page, {
      companies: [{ company: MARTA.company, tenders: tenderRun(3) }],
    })
    api.screening.state = 'pending'

    // The clock has to be installed before the document loads, or the poll's
    // `setTimeout`s are scheduled on the real one.
    await page.clock.install()
    await page.goto(`/radar/edital/${EDITAL}/triagem?cnpj=${MARTA.cnpj}&group=compatible`)

    await expect(page.getByText('Lendo o edital…')).toBeVisible()

    // Polled, not read at an instant. "Lendo o edital…" is also the screen's
    // **initial** state — `screening-screen.tsx`'s `INITIAL`, and the route's
    // Suspense fallback — so it is on screen before the `POST` has left. Read
    // straight after the visibility check, this counter measures how fast the
    // machine is, which is how it passed on a laptop and failed on a CI box.
    await expect
      .poll(() => api.calls.screeningPost.length, { message: 'one ask, not one per tick' })
      .toBe(1)

    // The poll loop has to have made its first read before the clock moves, or
    // `advance()` fires timers that do not exist yet and the whole wait starts
    // one tick out of step.
    await expect
      .poll(() => api.calls.screeningGet.length, { message: 'the poll loop never started' })
      .toBeGreaterThan(0)

    // §3.1's sixty seconds pass with the job still running.
    await advance(page, 70_000)
    await expect(page.getByText('A leitura está demorando mais que o normal')).toBeVisible()
    await expect(
      page.getByText('Ela continua rodando por aqui e aparece nesta tela assim que terminar'),
    ).toBeVisible()

    // "Keeps reading" is measured across both routes, not only on the read:
    // the poll asks the **job** whether it is worth re-reading and only
    // re-reads when the answer is yes (`lib/radar/poll.ts`) — twenty questions
    // a minute on the cheap endpoint instead of twenty reads. #68 was the
    // screen stopping asking.
    const questions = () => api.calls.jobs.length + api.calls.screeningGet.length
    const byTheDeadline = questions()

    await advance(page, 40_000)
    await expect
      .poll(questions, 'after the deadline the screen stopped reading — #68 is back')
      .toBeGreaterThan(byTheDeadline)

    // The worker finishes. The answer takes the card's place, no navigation.
    const address = page.url()
    api.screening.state = 'ready'
    await advance(page, 25_000)

    await expect(page.getByText('Boa para empresa pequena')).toBeVisible()
    await expect(page.getByText('A leitura está demorando mais que o normal')).toHaveCount(0)
    expect(page.url(), 'the answer arrived on the same screen, no second navigation').toBe(address)
    expect(api.calls.screeningPost.length, 'and without spending another triagem').toBe(1)
  })

  test('every claim in the reading shows the page of the edital it came from', async ({ page }) => {
    const api = await installRadarApi(page, {
      companies: [{ company: MARTA.company, tenders: tenderRun(3) }],
    })
    api.screening.state = 'ready'

    await page.goto(`/radar/edital/${EDITAL}/triagem?cnpj=${MARTA.cnpj}&group=compatible`)

    await expect(page.getByText('Boa para empresa pequena')).toBeVisible()
    // §2.2 rule 4: a conclusion without its source is a defect, not a design
    // choice. Every row carries its page, and the footer says how many checked
    // out.
    await expect(page.getByText('p.43').first()).toBeVisible()
    await expect(page.getByText('6 de 6 páginas citadas conferem com o edital.')).toBeVisible()
    // §2.2 rule 5: the AI notice on every result screen.
    await expect(
      page.getByText('Não substitui assessoria jurídica ou contábil.').first(),
    ).toBeVisible()
    // §10: the allowance stays in sight, on the screen where it is spent.
    await expect(page.getByText('1 de 2 sem conta')).toBeVisible()
  })

  test('re-opening a triagem she already asked for does not charge again, and the button says so (#70)', async ({
    page,
  }) => {
    const api = await installRadarApi(page, {
      companies: [{ company: MARTA.company, tenders: tenderRun(3) }],
    })
    api.screening.state = 'ready'

    await page.goto(`/radar?cnpj=${MARTA.cnpj}&group=compatible`)
    await card(page, processo(1)).click()

    // First time: the button is the usual one, and asking costs one of the two.
    await expect(page.getByRole('link', { name: 'Ver triagem por IA' })).toBeVisible()
    await page.getByRole('link', { name: 'Ver triagem por IA' }).click()
    await expect(page.getByText('Boa para empresa pequena')).toBeVisible()
    await expect(page.getByText('1 de 2 sem conta')).toBeVisible()

    // She goes back to the edital. The button now knows the reading is hers.
    await page.getByRole('link', { name: 'Voltar' }).click()
    await expect(page.getByRole('link', { name: 'Ver a triagem que você pediu' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Ver triagem por IA' })).toHaveCount(0)

    const spent = api.calls.screeningPost.length
    await page.getByRole('link', { name: 'Ver a triagem que você pediu' }).click()
    await expect(page.getByText('Boa para empresa pequena')).toBeVisible()

    // One more ask — the route answers `ready` from cache and `quota.spend`
    // de-duplicates on the tender id — and the allowance **does not move**.
    expect(api.calls.screeningPost.length).toBe(spent + 1)
    await expect(page.getByText('1 de 2 sem conta')).toBeVisible()
    await expect(page.getByText('2 de 2 sem conta')).toHaveCount(0)
  })

  test('a reading that exists but is not hers is still her first time (#70)', async ({ page }) => {
    const api = await installRadarApi(page, {
      companies: [{ company: MARTA.company, tenders: tenderRun(3) }],
    })
    // Somebody else already asked for this edital: the analysis exists (§3.2
    // shares the reading) but Dona Marta has spent nothing on it. The switch
    // is `spent`, never `ready` — Sci's ruling, and what this test pins.
    api.availability.set(EDITAL, { ready: true, spent: false })

    await page.goto(`/radar/edital/${EDITAL}?cnpj=${MARTA.cnpj}&group=compatible`)

    await expect(page.getByRole('link', { name: 'Ver triagem por IA' })).toBeVisible()
    await expect(page.getByRole('link', { name: 'Ver a triagem que você pediu' })).toHaveCount(0)
  })

  test('when the triagens run out the screen says how many there were and offers the account', async ({
    page,
  }) => {
    const api = await installRadarApi(page, {
      companies: [{ company: MARTA.company, tenders: tenderRun(3) }],
    })
    api.screening.used = 2
    api.screening.state = 'quotaExceeded'

    await page.goto(`/radar/edital/${EDITAL}/triagem?cnpj=${MARTA.cnpj}&group=compatible`)

    await expect(page.getByText('Suas triagens acabaram')).toBeVisible()
    await expect(page.getByText('Sem conta são 2 triagens.', { exact: false })).toBeVisible()

    // And the way to the account brings her back to this same triagem: without
    // the `?next=`, creating an account would strand her on some `/conta`,
    // away from the edital she was reading.
    const waysBack = await page
      .getByRole('link', { name: 'Criar conta' })
      .evaluateAll((links) =>
        links.map((link) => decodeURIComponent(link.getAttribute('href') ?? '')),
      )
    expect(waysBack.length, 'the quota screen has to offer the account').toBeGreaterThan(0)
    expect(
      waysBack.some(
        (href) =>
          href.startsWith('/conta/criar?next=') &&
          href.includes(`/radar/edital/${EDITAL}/triagem`) &&
          href.includes(`cnpj=${MARTA.cnpj}`),
      ),
      `no "Criar conta" comes back to the triagem: ${waysBack.join(' | ')}`,
    ).toBe(true)
  })
})
