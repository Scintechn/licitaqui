import { expect, test } from '@playwright/test'

/**
 * The audit gap this closes: before 2026-09-25, `next.config.ts` set only
 * `Cache-Control` and `Referrer-Policy`, and only on `/radar*`. No
 * `middleware.ts`/`proxy.ts` matched anything but `/admin`, and there was no
 * `vercel.json` header block — so a clickjacking iframe around
 * `/fundadores` (name, e-mail, WhatsApp, CNPJ) had nothing in its way.
 *
 * This runs against the real `next build && next start` server the
 * `journeys` project already starts (see `playwright.config.ts`'s own
 * comment on why: `next dev` answers differently), so a header present here
 * is a header a real response carries — not a fact about `next.config.ts`'s
 * source that a refactor could silently stop being true of the server.
 *
 * What this deliberately does not do: wait on a real network round trip to
 * `googletagmanager.com`. This suite is hermetic on purpose (see the top of
 * `playwright.config.ts` on why PNCP is mocked); asserting on an external
 * host's reachability would import exactly the flakiness that file argues
 * against, just for Google instead of PNCP. What is asserted instead is what
 * the *browser* does with the policy it was served — a CSP violation is
 * reported at parse time, before any external request resolves, so it is
 * both the thing that actually matters (would this policy block the tag?)
 * and independent of whether the sandbox running this suite has internet
 * access at all.
 */

test('the landing page ships the baseline security headers on a real response', async ({
  page,
}) => {
  const response = await page.goto('/', { waitUntil: 'domcontentloaded' })
  expect(response).not.toBeNull()
  const headers = response!.headers()

  expect(headers['x-frame-options']).toBe('DENY')
  expect(headers['x-content-type-options']).toBe('nosniff')
  expect(headers['strict-transport-security']).toContain('max-age=63072000')
  expect(headers['strict-transport-security']).toContain('includeSubDomains')
  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin')
  expect(headers['permissions-policy']).toContain('camera=()')
  expect(headers['permissions-policy']).toContain('geolocation=()')

  const csp = headers['content-security-policy']
  expect(csp).toContain("object-src 'none'")
  expect(csp).toContain("base-uri 'self'")
  expect(csp).toContain("frame-ancestors 'none'")
  expect(csp).toContain("form-action 'self'")
  // Deliberately unset (see next.config.ts's comment on why): asserting their
  // absence is what stops a future edit from quietly locking down script-src
  // — and silently breaking GTM — without anyone updating this test first.
  expect(csp).not.toMatch(/script-src|style-src/)
})

test('the founders signup page cannot be framed — the clickjacking gap the audit named', async ({
  page,
}) => {
  const response = await page.goto('/fundadores', { waitUntil: 'domcontentloaded' })
  const headers = response!.headers()
  expect(headers['x-frame-options']).toBe('DENY')
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'")
})

test('the Radar keeps its own stricter Referrer-Policy alongside the new global headers', async ({
  page,
}) => {
  // No DATABASE_URL in this project (playwright.config.ts): the Radar itself
  // may render an error state without a real database, but the response and
  // its headers exist regardless of what the page body says.
  const response = await page.goto('/radar', { waitUntil: 'domcontentloaded' })
  const headers = response!.headers()

  // The site-wide default is `strict-origin-when-cross-origin`; `/radar*`'s
  // own, stricter override (the CNPJ-in-URL comment in next.config.ts) must
  // still win rather than being replaced by the new global entry.
  expect(headers['referrer-policy']).toBe('same-origin')
  expect(headers['cache-control']).toContain('private')
  expect(headers['cache-control']).toContain('no-store')
  // The new headers still apply here too — a route-specific override for one
  // header must not have dropped the others.
  expect(headers['x-frame-options']).toBe('DENY')
  expect(headers['x-content-type-options']).toBe('nosniff')
})

test('nothing on the landing page trips the new Content-Security-Policy', async ({ page }) => {
  const cspViolations: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error' && /content security policy|refused to/i.test(message.text())) {
      cspViolations.push(message.text())
    }
  })

  await page.goto('/', { waitUntil: 'domcontentloaded' })
  // CSP violations for parse-time tags (the inline GTM bootstrap, its
  // `<script src>` sibling) are reported synchronously as the document is
  // parsed — this is a buffer for the console event to arrive, not a wait on
  // any network response.
  await page.waitForTimeout(500)

  expect(cspViolations).toEqual([])
})
