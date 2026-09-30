import { expect, test } from '@playwright/test'
import { installRadarApi } from '../fixtures/radar-api'
import { card } from '../fixtures/screen'
import { processo, RICARDO, tenderRun } from '../fixtures/world'

/**
 * **Ricardo** — ME in IT, wants an account and the weekly Telegram alert.
 *
 * ## What is here and what is not
 *
 * His journey crosses a border these tests do not: Google does not let anyone
 * automate a sign-in, and `/conta` and `/conta/alertas` need a session **and**
 * a database. So what stays in this project is the half any visitor walks, and
 * which has already broken:
 *
 *  - both ways in exist on the screen (**U2** — while the e-mail link was off,
 *    someone who will not use a Google account could not create one at all:
 *    `/conta/criar` offered Google or nothing);
 *  - someone who taps the bell without a session is **invited in**, not
 *    discarded;
 *  - every path out to the account carries `?next=`, to bring Ricardo back to
 *    the edital he was reading.
 *
 * The half with a session — the `/start` in Telegram, the pending/linked/
 * failed states, changing the account's CNPJ (**E3**) — is in
 * `e2e/accounts/ricardo-telegram.spec.ts`, and skips with its reason in plain
 * sight when the environment cannot run it.
 */

test.describe('Ricardo · ME, wants an account and alerts', () => {
  test('finds both ways in, and neither of them is a dead end', async ({ page }) => {
    await page.goto('/conta/criar')

    await expect(page.getByRole('heading', { name: 'Entre ou crie sua conta grátis' })).toBeVisible()

    // U2: Google **and** the e-mail link. If the environment configured
    // neither, the screen has to say so — what it may never do is draw a
    // button that fails halfway.
    const google = page.getByRole('button', { name: 'Entrar com Google' })
    const email = page.getByLabel('Seu e-mail')
    const noWayIn = page.getByText('Entrar não funciona neste endereço')

    if (await noWayIn.isVisible()) {
      await expect(google).toHaveCount(0)
      await expect(email).toHaveCount(0)
      // Even with no sign-in the Radar still serves: the path does not end here.
      await expect(page.getByRole('link', { name: 'Ir para o Radar' })).toBeVisible()
      return
    }

    await expect(google).toBeVisible()
    await expect(email).toBeVisible()
    await expect(page.getByRole('button', { name: 'Receber link de acesso' })).toBeVisible()

    // Consent is required and never pre-ticked (LGPD art. 8 §4).
    const consent = page.locator('input[name="consent"]')
    await expect(consent).not.toBeChecked()
    await expect(consent).toHaveAttribute('required', '')

    // And he can carry on without an account, which is what the Landing promises.
    await expect(page.getByRole('link', { name: 'Continuar sem conta' })).toBeVisible()
  })

  test('the Radar’s bell leads to the alerts, and without a session he is invited in', async ({
    page,
  }) => {
    await installRadarApi(page, {
      companies: [{ company: RICARDO.company, tenders: tenderRun(3) }],
    })

    await page.goto(`/radar?cnpj=${RICARDO.cnpj}&group=compatible`)
    await page.getByRole('link', { name: 'Alertas' }).click()

    // `/conta/alertas` without a session is `/conta/criar` — not an error and
    // not an empty shell: there is nothing there that is his yet.
    await expect(page).toHaveURL(/\/conta\/criar/)
    await expect(page.getByRole('heading', { name: 'Entre ou crie sua conta grátis' })).toBeVisible()
  })

  test('what is locked leads to the account carrying the way back', async ({ page }) => {
    const api = await installRadarApi(page, {
      companies: [{ company: RICARDO.company, tenders: tenderRun(3) }],
    })
    api.screening.state = 'ready'

    await page.goto(`/radar?cnpj=${RICARDO.cnpj}&uf=SP&group=compatible`)
    await card(page, processo(1)).click()

    // On the tender screen the files are a tab with a padlock — he can see the
    // agency published documents before being asked to sign up for them (§8).
    await page.getByRole('tab', { name: 'Documentos' }).click()
    const locked = page.getByRole('link', { name: /Edital e anexos/ })
    await expect(locked).toBeVisible()
    // **That FINDING is closed.** This block used to point at a bare
    // `ACCOUNT_HREF` with no `?next=`, so signing up from here landed on
    // `/conta` and lost the edital — a link no type check could reach, because
    // `accountHref()`'s argument is optional. `Files` takes the way back as a
    // prop now, and both screens pass it, so neither can quietly drop it.
    const tenderHrefBack = decodeURIComponent((await locked.getAttribute('href')) ?? '')
    expect(tenderHrefBack).toContain('/conta/criar?next=')
    expect(tenderHrefBack).toContain('51885242000140-1-000001/2026')

    // On the triagem, "Documentos" is a **tab** since D31 — it opens the same
    // locked block in place instead of sending him to another page. What has
    // to survive that change is the way back: the signup still has to return
    // him to this edital, with this search, after he creates the account.
    await page.getByRole('link', { name: 'Ver triagem por IA' }).click()
    await expect(page.getByText('Boa para empresa pequena')).toBeVisible()

    await page.getByRole('tab', { name: 'Documentos' }).click()
    const onTriagem = page.getByRole('link', { name: /Edital e anexos/ })
    await expect(onTriagem).toBeVisible()

    const href = decodeURIComponent((await onTriagem.getAttribute('href')) ?? '')
    expect(href).toContain('/conta/criar?next=')
    expect(href, 'the way back lost the edital').toContain(
      '/radar/edital/51885242000140-1-000001/2026',
    )
    expect(href, 'the way back lost the search').toContain(`cnpj=${RICARDO.cnpj}`)
    expect(href, 'the way back lost the UF').toContain('uf=SP')
  })
})
