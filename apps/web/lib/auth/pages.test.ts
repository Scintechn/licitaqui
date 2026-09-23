import { describe, expect, it } from 'vitest'
import { AUTH_PAGES } from '@/lib/auth/pages'
import { magicLinkWasSent } from '@/lib/auth/verify-request'
import { ACCOUNT_CREATE_PATH } from '@/lib/routes'

/**
 * The redirect that broke every e-mail sign-in (2026-09-23).
 *
 * `pages.verifyRequest` carried `?enviado=1`, and `@auth/core` joins its own
 * parameters onto that value with a bare concatenation — no `?`/`&` decision at
 * all, unlike the `signIn` and `error` branches next to it. Production served:
 *
 *     302 → /conta/criar?enviado=1?provider=resend&type=email
 *
 * Two `?` in one URL, so `enviado` parsed as `1?provider=resend`, the "Link
 * enviado" panel never rendered, and somebody whose magic link had *already
 * been sent* saw an empty sign-in form. It looked broken and it had worked.
 */
describe('the Auth.js page redirects', () => {
  it('has no query string in any page value, because Auth.js appends to all of them', () => {
    const pages = AUTH_PAGES
    const entries = Object.entries(pages) as [string, string][]

    expect(entries.length).toBeGreaterThan(0)
    for (const [name, value] of entries) {
      expect(typeof value, `pages.${name} must be a path`).toBe('string')
      expect(value, `pages.${name} must not carry a query string`).not.toContain('?')
      expect(value, `pages.${name} must not carry a fragment`).not.toContain('#')
      expect(value.startsWith('/'), `pages.${name} must be a local path`).toBe(true)
    }
  })

  it('sends all three to the account screen', () => {
    expect(AUTH_PAGES.signIn).toBe(ACCOUNT_CREATE_PATH)
    expect(AUTH_PAGES.error).toBe(ACCOUNT_CREATE_PATH)
    expect(AUTH_PAGES.verifyRequest).toBe(ACCOUNT_CREATE_PATH)
  })

  it('reproduces the join Auth.js performs, and gets one `?`', () => {
    // `${pages.verifyRequest}${url.search}` — @auth/core/lib/pages/index.js.
    const search = '?provider=resend&type=email'
    const redirect = `${AUTH_PAGES.verifyRequest}${search}`

    expect(redirect).toBe('/conta/criar?provider=resend&type=email')
    expect(redirect.match(/\?/g)).toHaveLength(1)

    // And the page it lands on shows the confirmation rather than a bare form.
    const params = Object.fromEntries(new URLSearchParams(search))
    expect(magicLinkWasSent(params)).toBe(true)
  })
})

describe('whether the magic link was just sent', () => {
  it("accepts Auth.js's own signal", () => {
    expect(magicLinkWasSent({ provider: 'resend', type: 'email' })).toBe(true)
  })

  it('still accepts our own `enviado=1`, which internal links and the journey use', () => {
    expect(magicLinkWasSent({ enviado: '1' })).toBe(true)
  })

  it('is false on the plain sign-in screen', () => {
    expect(magicLinkWasSent({})).toBe(false)
    expect(magicLinkWasSent({ next: '/radar' })).toBe(false)
    expect(magicLinkWasSent({ erro: 'email' })).toBe(false)
  })

  it('does not paper over the malformed URL that caused the defect', () => {
    // What actually arrived while the bug was live. Tolerating it — a
    // `startsWith`, a `parseInt` — would have hidden the broken redirect
    // instead of showing it, so this stays strictly false.
    expect(magicLinkWasSent({ enviado: '1?provider=resend' })).toBe(false)
  })

  it('reads the first value when Next gives an array for a repeated parameter', () => {
    expect(magicLinkWasSent({ type: ['email', 'oauth'] })).toBe(true)
    expect(magicLinkWasSent({ enviado: ['0', '1'] })).toBe(false)
  })
})
