import { expect, test } from '@playwright/test'

/**
 * **Seu Jorge** — does not use a Google account, and is not going to start.
 *
 * While `AUTH_MAGIC_LINK` was off, `/conta/criar` offered Google or nothing:
 * he **could not create an account at all** (**U2**). His is the one journey
 * of the four with a real external dependency — he needs an inbox.
 *
 * ## What runs and what does not
 *
 * | test | needs | runs? |
 * |---|---|---|
 * | asking for the link | a published environment with e-mail on | yes, with `E2E_BASE_URL` |
 * | signing in with it | his inbox | only with the link pasted into `E2E_MAGIC_LINK_URL` |
 *
 * The second one **is not automated and does not pretend to be**. Reading the
 * inbox would mean e-mail credentials in CI, which is exactly the kind of
 * secret `CLAUDE.md` forbids carrying around — and standing up a Mailosaur is
 * one more account on the eve of a launch. So the human step is explicit: Sci
 * opens the inbox, copies the link and runs the test with it. The rest — that
 * the link is single-use — the test checks by itself, because that is where
 * the defect nobody notices until it happens to a customer lives.
 *
 * ```
 * E2E_BASE_URL=https://… E2E_MAGIC_LINK_EMAIL=jorge@… \
 *   pnpm --filter @licitaqui/web exec playwright test --project=accounts  # asks for the link
 * E2E_BASE_URL=https://… E2E_MAGIC_LINK_URL='https://…/api/auth/callback/resend?token=…' \
 *   pnpm --filter @licitaqui/web exec playwright test --project=accounts  # signs in with it
 * ```
 *
 * **State on 2026-09-23: the second half has never run.** Nobody has walked
 * this journey end to end yet, and the test is skipped, not green.
 */

const BASE = process.env.E2E_BASE_URL
const EMAIL = process.env.E2E_MAGIC_LINK_EMAIL
const LINK = process.env.E2E_MAGIC_LINK_URL

test.describe('Seu Jorge · signing in without a Google account (U2)', () => {
  test('asks for the access link and the screen confirms it was sent', async ({ page }) => {
    test.skip(
      !BASE || !EMAIL,
      'sends a real e-mail: needs a published environment and a test address ' +
        '(E2E_BASE_URL + E2E_MAGIC_LINK_EMAIL). The address must not be the owner of the Resend ' +
        'account — the test key silently drops everyone else, which is the failure U2 exists to ' +
        'rule out.',
    )

    await page.goto('/conta/criar')

    const field = page.getByLabel('Seu e-mail')
    await expect(
      field,
      'without the e-mail link, someone who will not use Google cannot create an account (U2)',
    ).toBeVisible()

    await field.fill(EMAIL ?? '')
    await page.locator('input[name="consent"]').check()
    await page.getByRole('button', { name: 'Receber link de acesso' }).click()

    await expect(page.getByText('Link enviado')).toBeVisible()
    await expect(
      page.getByText('Abra o seu e-mail e clique no link para entrar.', { exact: false }),
    ).toBeVisible()
  })

  test('signs in with the link, and the link does not work twice', async ({ page, context }) => {
    test.skip(
      !BASE || !LINK,
      'human step: open the inbox, copy the link from the e-mail and run with ' +
        'E2E_MAGIC_LINK_URL=<the link>. Reading the inbox from here would need e-mail ' +
        'credentials in CI, and a test that faked the sign-in would be worse than a skipped one.',
    )

    await page.goto(LINK ?? '/')

    // He is in: the account is his, with no password and no Google.
    await expect(page).toHaveURL(/\/conta|\/radar/)
    await page.goto('/conta')
    await expect(page.getByRole('heading', { name: 'Sua conta' })).toBeVisible()

    // The same link, in a clean context, must not sign anyone in again (U2:
    // single use). `newContext()` does not inherit the config's `baseURL`, so
    // it is passed explicitly or the `goto('/conta')` below has nothing to
    // resolve against.
    const other = await context.browser()?.newContext({ baseURL: BASE })
    const second = await other?.newPage()
    if (second) {
      await second.goto(LINK ?? '/')
      await second.goto('/conta')
      await expect(
        second.getByRole('heading', { name: 'Entre ou crie sua conta grátis' }),
        'the access link signed someone in twice',
      ).toBeVisible()
      await other?.close()
    }
  })
})
