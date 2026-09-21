import { describe, expect, it } from 'vitest'
import {
  isPreview,
  magicLinkFrom,
  noWayIn,
  providerAvailability,
  redirectProxyUrl,
  resendKey,
  SESSION_COOKIE,
  SESSION_COOKIE_SECURE,
  type Env,
} from './config'

/**
 * What each deployment is allowed to offer.
 *
 * The cases below are the four ways this gets shipped wrong, and every one of
 * them ends in a button that sends someone to Google and brings them back an
 * error page in English:
 *
 *  - secrets missing → do not draw the button;
 *  - a Vercel **preview**, whose hostname can never be a registered redirect
 *    URI → do not draw the button, and say why;
 *  - a preview *with* `AUTH_REDIRECT_PROXY_URL` → draw it, because Google now
 *    calls back a fixed deployment that forwards here;
 *  - magic link before G2 has verified a sending domain → do not draw the
 *    field, because Resend would silently deliver to nobody but the account
 *    owner.
 */

const GOOGLE: Env = {
  AUTH_SECRET: 'x'.repeat(32),
  AUTH_GOOGLE_ID: 'client-id.apps.googleusercontent.com',
  AUTH_GOOGLE_SECRET: 'client-secret',
}

describe('providerAvailability', () => {
  it('offers Google when it is configured and the host is stable', () => {
    const available = providerAvailability(GOOGLE)
    expect(available.google).toBe(true)
    expect(available.googleUnavailable).toBeNull()
    expect(noWayIn(available)).toBe(false)
  })

  it('offers nothing at all when the secrets are missing', () => {
    const available = providerAvailability({})
    expect(available.google).toBe(false)
    expect(available.magicLink).toBe(false)
    expect(available.googleUnavailable).toBe('not_configured')
    expect(noWayIn(available)).toBe(true)
  })

  it('needs every piece, not just some of them', () => {
    expect(providerAvailability({ ...GOOGLE, AUTH_SECRET: '' }).google).toBe(false)
    expect(providerAvailability({ ...GOOGLE, AUTH_GOOGLE_ID: '' }).google).toBe(false)
    expect(providerAvailability({ ...GOOGLE, AUTH_GOOGLE_SECRET: '  ' }).google).toBe(false)
  })

  it('does not offer Google on a preview: the hostname cannot be registered', () => {
    const available = providerAvailability({ ...GOOGLE, VERCEL_ENV: 'preview' })
    expect(available.google).toBe(false)
    expect(available.googleUnavailable).toBe('preview')
  })

  it('offers it again once a preview has a redirect proxy to borrow', () => {
    const available = providerAvailability({
      ...GOOGLE,
      VERCEL_ENV: 'preview',
      AUTH_REDIRECT_PROXY_URL: 'https://licitaqui.vercel.app/api/auth',
    })
    expect(available.google).toBe(true)
    expect(available.googleUnavailable).toBeNull()
  })

  it('keeps production and local development unaffected by the preview rule', () => {
    expect(providerAvailability({ ...GOOGLE, VERCEL_ENV: 'production' }).google).toBe(true)
    expect(providerAvailability({ ...GOOGLE, VERCEL_ENV: 'development' }).google).toBe(true)
  })
})

describe('the magic link, behind its flag until G2', () => {
  const RESEND: Env = {
    ...GOOGLE,
    AUTH_MAGIC_LINK: '1',
    AUTH_RESEND_KEY: 're_test',
    AUTH_EMAIL_FROM: 'contato@example.com',
  }

  it('is off with no flag, even when Resend is configured', () => {
    expect(providerAvailability({ ...RESEND, AUTH_MAGIC_LINK: undefined }).magicLink).toBe(false)
  })

  it('is off with the flag but no key and no sender', () => {
    expect(providerAvailability({ ...RESEND, AUTH_RESEND_KEY: '' }).magicLink).toBe(false)
    expect(providerAvailability({ ...RESEND, AUTH_EMAIL_FROM: '' }).magicLink).toBe(false)
  })

  it('needs the flag to be exactly "1" — "true" and "0" are off', () => {
    expect(providerAvailability({ ...RESEND, AUTH_MAGIC_LINK: 'true' }).magicLink).toBe(false)
    expect(providerAvailability({ ...RESEND, AUTH_MAGIC_LINK: '0' }).magicLink).toBe(false)
  })

  it('is on with all three, and then accepts the repo-wide Resend key name too', () => {
    expect(providerAvailability(RESEND).magicLink).toBe(true)
    const viaRepoName = { ...RESEND, AUTH_RESEND_KEY: undefined, RESEND_API_KEY: 're_test' }
    expect(providerAvailability(viaRepoName).magicLink).toBe(true)
    expect(resendKey({ RESEND_API_KEY: 're_test' })).toBe('re_test')
    expect(magicLinkFrom(RESEND)).toBe('contato@example.com')
  })
})

describe('the environment helpers', () => {
  it('reads the preview flag and the proxy', () => {
    expect(isPreview({ VERCEL_ENV: 'preview' })).toBe(true)
    expect(isPreview({ VERCEL_ENV: 'production' })).toBe(false)
    expect(isPreview({})).toBe(false)
    expect(redirectProxyUrl({})).toBeUndefined()
    expect(redirectProxyUrl({ AUTH_REDIRECT_PROXY_URL: ' https://x/api/auth ' })).toBe(
      'https://x/api/auth',
    )
  })

  it('pins the session cookie names Auth.js writes and `session.ts` reads', () => {
    // If either of these changes, every API route stops recognising a signed-in
    // user while the pages still do — the one drift that would be silent.
    expect(SESSION_COOKIE).toBe('authjs.session-token')
    expect(SESSION_COOKIE_SECURE).toBe('__Secure-authjs.session-token')
  })
})
