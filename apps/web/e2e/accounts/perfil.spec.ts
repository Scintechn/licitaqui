import { expect, test } from '@playwright/test'
import { SESSION_COOKIE } from '@/lib/auth/config'

/**
 * **The profile gate before the checkout** — task **F31**.
 *
 * ## What this file is for, and what `profile-view.test.tsx` cannot do
 *
 * §4c: `vitest.config.mts` has no jsdom, so the unit test pins the
 * **mechanism** — three inputs, in the form, with the names the action reads —
 * and can never pin a **submit**. Everything interesting about this feature is
 * on the other side of one:
 *
 *  * that `saveProfile` is reachable from the form at all,
 *  * that a rejected field comes back **with its error rendered** — the seam
 *    where the schema's `name`/`mobile` meet the form's `nome`/`celular`, and
 *    the one place a green suite would hide a form that refuses an entry and
 *    then shows nothing,
 *  * and that the subscribe button, absent a moment ago, is there afterwards.
 *
 * ## Why it does not run by default
 *
 * Same reason as `ricardo-telegram.spec.ts`: a session cannot be created by a
 * test without Google (which forbids automation) or an inbox. It runs against
 * a real environment with a cookie for a test account and **skips with its
 * reason written out** when it has none. It never pretends to have passed.
 *
 * ```
 * E2E_BASE_URL=https://… \
 * E2E_SESSION_COOKIE=<the authjs.session-token value of a test account> \
 *   pnpm --filter @licitaqui/web exec playwright test --project=accounts
 * ```
 *
 * **It writes to the account it is given.** The name and mobile below land on
 * that user, so point it at a test account and not at Sci's.
 */

const BASE = process.env.E2E_BASE_URL
const COOKIE = process.env.E2E_SESSION_COOKIE
const MISSING =
  'needs a published environment and a session cookie for a test account: ' +
  'E2E_BASE_URL + E2E_SESSION_COOKIE'

test.describe('The profile gate before the checkout (F31)', () => {
  test.skip(!BASE || !COOKIE, MISSING)

  test.beforeEach(async ({ context }) => {
    const { hostname, protocol } = new URL(BASE ?? 'http://127.0.0.1')
    await context.addCookies([
      {
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

  test('asks for three fields and not for a CPF or a date of birth', async ({ page }) => {
    await page.goto('/conta/perfil')
    await expect(page.locator('input[name="nome"]')).toBeVisible()
    await expect(page.locator('input[name="celular"]')).toBeVisible()
    await expect(page.locator('input[name="cnpj"]')).toBeVisible()
    // The two the privacy policy does not name. `TO_VALIDATE` I.
    await expect(page.locator('input[name="cpf"]')).toHaveCount(0)
    await expect(page.locator('input[name="nascimento"]')).toHaveCount(0)
  })

  /*
   * The field-name seam, end to end. `saveProfile` emits `?erro=celular`; the
   * page's allow-list accepts `nome|celular|cnpj`. If the action ever emits
   * the schema's own keys instead, this is the test that notices — the unit
   * tests on both sides would stay green.
   */
  test('a rejected mobile comes back with its error on the field', async ({ page }) => {
    await page.goto('/conta/perfil')
    await page.fill('input[name="nome"]', 'Maria Silva')
    await page.fill('input[name="celular"]', '12345')
    await page.fill('input[name="cnpj"]', '36955612000185')
    await page.getByRole('button', { name: /salvar/i }).click()

    await expect(page).toHaveURL(/\/conta\/perfil\?erro=celular/)
    const celular = page.locator('input[name="celular"]')
    await expect(celular).toHaveAttribute('aria-invalid', 'true')
    // The sentence itself, not merely the red border: a form that goes red and
    // says nothing is the silence F8 is about, one field down.
    await expect(page.locator('#perfil-celular-error')).toBeVisible()
  })

  test('a complete profile reaches the plan screen with a checkout on it', async ({ page }) => {
    await page.goto('/conta/perfil')
    await page.fill('input[name="nome"]', 'Maria Silva')
    await page.fill('input[name="celular"]', '+55 11 99999-9999')
    await page.fill('input[name="cnpj"]', '36955612000185')
    await page.getByRole('button', { name: /salvar/i }).click()

    await expect(page).toHaveURL(/\/conta\/plano\?estado=cadastro-salvo/)
    // The gate opening is the whole point: `canBill` was false and is true.
    await expect(page.getByRole('button', { name: /pagamento/i })).toBeVisible()
  })

  /*
   * The other direction, and it is the one F8 is about: an account that cannot
   * be billed must be told why and given somewhere to go. Only meaningful on a
   * test account with no name — it asserts the link, which is rendered
   * whenever the explanation is.
   */
  test('the plan screen links here when it cannot offer a checkout', async ({ page }) => {
    await page.goto('/conta/plano')
    const gate = page.getByRole('link', { name: /cadastro/i })
    if ((await gate.count()) > 0) {
      await gate.first().click()
      await expect(page).toHaveURL(/\/conta\/perfil/)
    } else {
      // Already billable, so there is nothing to explain. Said out loud rather
      // than passing silently on an assertion that never ran.
      test.info().annotations.push({
        type: 'note',
        description: 'account is already billable; the no-checkout branch was not exercised',
      })
    }
  })
})
