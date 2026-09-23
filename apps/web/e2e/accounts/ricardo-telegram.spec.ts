import { expect, test } from '@playwright/test'
import { SESSION_COOKIE } from '@/lib/auth/config'

/**
 * **Ricardo turns Telegram on** — the half of his journey that needs a real
 * account (**E3**).
 *
 * ## Why this file does not run by default
 *
 * `/conta/alertas` needs a session **and** a database. There is no way for a
 * test to create a session without going through Google — which forbids
 * automation — or the e-mail link, which needs an inbox. So it runs against a
 * real environment, with a session cookie for a test account, and skips with
 * its reason written out when it does not have one. **It never pretends to
 * have passed.**
 *
 * ```
 * E2E_BASE_URL=https://… \
 * E2E_SESSION_COOKIE=<the authjs.session-token value of a test account> \
 *   pnpm test:e2e --project=accounts
 * ```
 *
 * ## The defect it keeps
 *
 * Observed on production on 22/09: the token was minted, the user was sent to
 * the bot, and `telegram_links.chat_id` stayed null — no `telegram_linked`, no
 * error, **not a word on the screen**. The suspected cause is that
 * `t.me/<bot>?start=<token>` only sends the payload by itself in a
 * conversation that never existed; anyone who has touched the bot before just
 * sees the chat open.
 *
 * What can be checked without a human tapping "Iniciar" is exactly what was
 * missing: that the screen **knows it is waiting**, that it offers the text to
 * paste by hand when the tap does not arrive, and that a wait which never ends
 * becomes a visible sentence instead of silence. The tap itself — the
 * `chat_id` reaching the webhook — needs the second Telegram account Sci
 * offered, and is marked below.
 */

const BASE = process.env.E2E_BASE_URL
const COOKIE = process.env.E2E_SESSION_COOKIE
const MISSING =
  'needs a published environment and a session cookie for a test account: ' +
  'E2E_BASE_URL + E2E_SESSION_COOKIE'

test.describe('Ricardo · turning Telegram on (E3)', () => {
  test.skip(!BASE || !COOKIE, MISSING)

  test.beforeEach(async ({ context }) => {
    const { hostname, protocol } = new URL(BASE ?? 'http://127.0.0.1')
    await context.addCookies([
      {
        // Auth.js writes the `__Secure-` name on https; both spellings are
        // pinned in `lib/auth/config.ts` precisely so they cannot drift.
        name: protocol === 'https:' ? `__Secure-${SESSION_COOKIE}` : SESSION_COOKIE,
        value: COOKIE ?? '',
        domain: hostname,
        path: '/',
        httpOnly: true,
        secure: protocol === 'https:',
        sameSite: 'Lax',
      },
    ])
  })

  test('the CNPJ is asked for where it is used, without leaving the account area', async ({
    page,
  }) => {
    await page.goto('/conta/alertas')
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()

    // E3: setting alerts up cannot require leaving the account, going to the
    // Radar to run a search and coming back — which was the only way a CNPJ
    // ever reached an account.
    const noCnpj = page.getByText('a gente precisa do CNPJ da sua empresa', { exact: false })
    if (await noCnpj.isVisible()) {
      await expect(page.getByLabel(/CNPJ/i)).toBeVisible()
    }
    expect(new URL(page.url()).pathname.startsWith('/conta')).toBe(true)
  })

  test('the screen knows it is waiting for the tap, and shows the text to paste', async ({
    page,
  }) => {
    await page.goto('/conta/alertas')

    const connect = page.getByRole('button', { name: 'Conectar o Telegram' })
    test.skip(
      !(await connect.isVisible()),
      'this test account is already linked to Telegram: disconnect it before running',
    )
    await connect.click()

    // Pending is a state with a name, not the absence of "linked".
    await expect(page.getByText('Falta tocar em Iniciar no Telegram')).toBeVisible()
    await expect(page.getByRole('link', { name: 'Abrir o Telegram' })).toBeVisible()
    await expect(page.getByText('Telegram conectado')).toHaveCount(0)

    // The way out for someone who already had a chat with the bot: the message
    // to paste.
    await expect(page.getByText('O Telegram abriu e nada aconteceu?')).toBeVisible()
    await expect(page.getByText('/start ', { exact: false })).toBeVisible()
  })

  test('a wait that never ends becomes a visible sentence, not silence', async ({ page }) => {
    await page.goto('/conta/alertas')

    const connect = page.getByRole('button', { name: 'Conectar o Telegram' })
    test.skip(
      !(await connect.isVisible()),
      'this test account is already linked to Telegram: disconnect it before running',
    )
    await connect.click()
    await expect(page.getByText('Falta tocar em Iniciar no Telegram')).toBeVisible()

    // He checks without having tapped anything. The product goes on saying
    // where it has got to — the silence was the defect, not the delay.
    await page.getByRole('button', { name: 'Já toquei em Iniciar, verificar' }).click()
    await expect(page.getByText('Ainda não chegou nada do Telegram', { exact: false })).toBeVisible()
    await expect(page.getByText('Telegram conectado')).toHaveCount(0)
  })

  /**
   * The real tap. It needs a person (or the second Telegram account Sci
   * offered) opening the chat and tapping Iniciar, and the webhook pointed at
   * the environment under test. There is no way to automate that from here,
   * and a test that faked it would be worse than none.
   */
  test('the /start arrives and the screen starts saying it is linked', async ({ page }) => {
    test.skip(
      !process.env.E2E_TELEGRAM_MANUAL,
      'needs a human tap on Iniciar in Telegram: run with E2E_TELEGRAM_MANUAL=1 and tap when ' +
        'the test stops on the waiting state',
    )

    await page.goto('/conta/alertas')
    await page.getByRole('button', { name: 'Conectar o Telegram' }).click()
    await expect(page.getByText('Falta tocar em Iniciar no Telegram')).toBeVisible()

    // Tap now. The screen checks by itself; the `expect` waits on the state.
    await expect(page.getByText('Telegram conectado')).toBeVisible({ timeout: 180_000 })
    await expect(page.getByText('Seus avisos vão chegar em', { exact: false })).toBeVisible()
  })
})
