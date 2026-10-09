import { expect, test } from '@playwright/test'
import { SESSION_COOKIE } from '@/lib/auth/config'
import { messages } from '@/lib/messages'

/**
 * **`/conta/plano` — the subscribe control and the cancel, in a browser**
 * (cards **F2** and **D8**).
 *
 * ## Why this file exists, specifically
 *
 * `plan-view.test.tsx` is `renderToStaticMarkup` string assertions, and
 * CLAUDE.md §4c names the two classes of defect that suite cannot see: an
 * effect undoing the first render, and layout. The cancel is neither — but it
 * *is* a navigation and a form submission, which the unit suite also cannot
 * see: it renders the component with `confirmingCancel: true` and never asks
 * whether anything can reach that state.
 *
 * **The first version of `plan-view.tsx` said "The Playwright journey pins the
 * result" and there was no such file.** A §4b review caught it. That is the
 * sharpest kind of defect this repository collects — not a bug, a false
 * sentence about evidence, in the place the rule says to look for it — so this
 * file is written to be the sentence's referent rather than the sentence to be
 * softened.
 *
 * ## Why it does not run by default
 *
 * `/conta/plano` needs a session **and** a database. A session cannot be
 * created by a test: Google forbids automation and the e-mail link needs an
 * inbox. So, exactly like `ricardo-telegram.spec.ts`, it runs against a real
 * environment with a session cookie for a test account and **skips with its
 * reason written out** when it does not have one. It never pretends to have
 * passed.
 *
 * ```
 * E2E_BASE_URL=https://… \
 * E2E_SESSION_COOKIE=<the authjs.session-token value of a test account> \
 *   pnpm --filter @licitaqui/web exec playwright test --project=accounts
 * ```
 *
 * ## What it checks, and what it deliberately does not
 *
 * It checks the **two shapes a reader can be in** and the path between them:
 * no subscription → the subscribe heading and control are reachable; a live
 * subscription → the cancel control leads to a confirmation that offers both a
 * way on and a way out.
 *
 * It does **not** press *Sim, cancelar* unless `E2E_CANCEL_FOR_REAL=1`. That
 * submit calls Asaas and destroys a subscription; a test that did it by
 * default would make a green CI run a billing operation. With the flag it
 * completes the journey and asserts the `?estado=cancelado` banner, which is
 * the one assertion that proves the whole loop — and it is the assertion Sci
 * will want on the sandbox before 17/10.
 */

const BASE = process.env.E2E_BASE_URL
const COOKIE = process.env.E2E_SESSION_COOKIE
const MISSING =
  'needs a published environment and a session cookie for a test account: ' +
  'E2E_BASE_URL + E2E_SESSION_COOKIE'

/** Pressing "Sim, cancelar" calls Asaas. Opt in, never by default. */
const CANCEL_FOR_REAL = process.env.E2E_CANCEL_FOR_REAL === '1'

const billing = messages.billing

test.describe('/conta/plano · subscribing and cancelling (F2, D8)', () => {
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

  test('the screen the terms of use name by address is reachable and signed in', async ({
    page,
  }) => {
    await page.goto('/conta/plano')
    // Not bounced to `/conta/criar`: the cookie is a real session.
    expect(new URL(page.url()).pathname).toBe('/conta/plano')
    await expect(page.getByRole('heading', { name: messages.radar.menu.billing })).toBeVisible()
  })

  test('with no subscription, the checkout is offered and says how you can pay', async ({
    page,
  }) => {
    await page.goto('/conta/plano')

    const cta = page.getByRole('button', { name: billing.subscribe.cta })
    const cancel = page.getByRole('link', { name: billing.cancel.cta })
    test.skip(
      await cancel.isVisible(),
      'this test account already has a subscription: use the cancel test instead',
    )

    // The account may have no CNPJ, which is the F8 silence — a real state,
    // and one this test must not fail on. It says which it saw.
    const company = page.getByRole('link', { name: messages.radar.menu.company })
    if (!(await cta.isVisible())) {
      await expect(company, 'no checkout and no company link is neither state').toBeVisible()
      return
    }

    await expect(page.getByText(billing.subscribe.title)).toBeVisible()
    await expect(page.getByText(billing.subscribe.methods)).toBeVisible()
  })

  test('with a subscription, cancelling reaches a confirmation with a way out', async ({
    page,
  }) => {
    await page.goto('/conta/plano')

    const cancel = page.getByRole('link', { name: billing.cancel.cta })
    test.skip(
      !(await cancel.isVisible()),
      'this test account has no live subscription: subscribe on the sandbox first',
    )

    // **The step the unit suite cannot see.** It renders the confirmation from
    // a prop; nothing there asks whether a reader can arrive at it.
    await cancel.click()
    await expect(page.getByText(billing.cancel.title)).toBeVisible()
    await expect(page.getByText(billing.cancel.body)).toBeVisible()
    await expect(page.getByRole('button', { name: billing.cancel.confirm })).toBeVisible()

    // "Não, continuar assinante" has to actually go back, not just exist.
    await page.getByRole('link', { name: billing.cancel.keep }).click()
    await expect(page.getByText(billing.cancel.title)).toBeHidden()
    await expect(page.getByRole('link', { name: billing.cancel.cta })).toBeVisible()
  })

  test('confirming cancels, and the screen says until when the plan runs', async ({ page }) => {
    test.skip(
      !CANCEL_FOR_REAL,
      'this submit calls Asaas and destroys a subscription: set E2E_CANCEL_FOR_REAL=1',
    )
    await page.goto('/conta/plano?cancelar=1')

    const confirm = page.getByRole('button', { name: billing.cancel.confirm })
    test.skip(!(await confirm.isVisible()), 'no live subscription to cancel')

    await confirm.click()
    await expect(page.getByText(billing.cancel.doneTitle)).toBeVisible()
    await expect(page.getByText(billing.status.cancelled)).toBeVisible()
    // Terms §8: the paid period is honoured, and the screen says the day.
    await expect(page.getByText('Você continua com o plano pago até', { exact: false }))
      .toBeVisible()
    // And it offers the way back in, because cancelling is not leaving.
    await expect(page.getByRole('button', { name: billing.subscribe.cta })).toBeVisible()
  })
})
