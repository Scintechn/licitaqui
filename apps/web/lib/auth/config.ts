/**
 * What Auth.js may do in *this* environment (spec §5, §164, §9).
 *
 * Pure functions over an env bag, no Auth.js import, no database: the sign-in
 * screen, the route handlers and the tests all ask the same questions here and
 * get the same answer, and a misconfigured deployment is a *known* state rather
 * than a button that fails with `redirect_uri_mismatch` after the user has
 * already left for Google.
 *
 * ## Google, and why previews are the hard part
 *
 * Google OAuth matches redirect URIs **exactly** and forbids wildcards. Every
 * Vercel preview deployment gets a fresh hostname, so a preview can never have
 * its callback registered in advance. Two ways out, in this order:
 *
 *  1. **`AUTH_REDIRECT_PROXY_URL`** — Auth.js's documented answer. Google
 *     redirects to one fixed deployment (production), which forwards the
 *     callback to whichever preview started the flow. Both deployments must
 *     share `AUTH_SECRET`. Only the production callback is registered.
 *  2. **Nothing** — then Google sign-in is *not offered* on a preview. The
 *     preview still builds, still serves the Radar, still runs visitor mode;
 *     the sign-in screen says plainly that this address cannot sign in. A
 *     documented degradation, not a broken page.
 *
 * ## Magic link
 *
 * Decided (§164) but gated on G2: Resend cannot mail anyone but the account
 * owner until a sending domain is verified, so a public magic-link button would
 * silently drop every other address. `AUTH_MAGIC_LINK=1` plus a Resend key
 * turns it on, and until Sci sets both it does not exist in the UI.
 */

export type Env = Record<string, string | undefined>

/** Auth.js v5 names. `AUTH_SECRET` signs the session cookie and the JWE state. */
export const AUTH_SECRET_VAR = 'AUTH_SECRET'
export const GOOGLE_ID_VAR = 'AUTH_GOOGLE_ID'
export const GOOGLE_SECRET_VAR = 'AUTH_GOOGLE_SECRET'

/** Set on a preview to borrow production's registered callback (§164). */
export const REDIRECT_PROXY_VAR = 'AUTH_REDIRECT_PROXY_URL'

/** `1` once G2 has verified a sending domain. Anything else is off. */
export const MAGIC_LINK_VAR = 'AUTH_MAGIC_LINK'

/** Resend, per §9. Auth.js reads `AUTH_RESEND_KEY`; we accept the repo's name too. */
export const RESEND_KEY_VARS = ['AUTH_RESEND_KEY', 'RESEND_API_KEY'] as const

/** The address magic links are sent from. Must be on the verified domain (G2). */
export const MAGIC_LINK_FROM_VAR = 'AUTH_EMAIL_FROM'

/** Vercel sets this to `production`, `preview` or `development`. */
export const VERCEL_ENV_VAR = 'VERCEL_ENV'

/**
 * The session cookie, pinned rather than left to Auth.js's default.
 *
 * `lib/auth/session.ts` reads this cookie straight out of the request header so
 * that an API route can know who is asking without `next/headers` — which is
 * what lets the route handlers be called directly from the database tests, the
 * way every other route in this app already is. Pinning the name here means
 * that read can never drift from what Auth.js writes.
 */
export const SESSION_COOKIE = 'authjs.session-token'
export const SESSION_COOKIE_SECURE = `__Secure-${SESSION_COOKIE}`

/** §10: what a signed-in user gets before they pay for anything. */
export const DEFAULT_PLAN = 'basico'

function value(env: Env, name: string): string {
  return (env[name] ?? '').trim()
}

function first(env: Env, names: readonly string[]): string {
  for (const name of names) {
    const found = value(env, name)
    if (found) return found
  }
  return ''
}

/** True on a Vercel preview deployment, where the hostname is one-off. */
export function isPreview(env: Env = process.env): boolean {
  return value(env, VERCEL_ENV_VAR) === 'preview'
}

/** The fixed deployment Google is allowed to call back, or `undefined`. */
export function redirectProxyUrl(env: Env = process.env): string | undefined {
  const url = value(env, REDIRECT_PROXY_VAR)
  return url || undefined
}

export type ProviderAvailability = {
  /** Show the "Entrar com Google" button. */
  google: boolean
  /** Show the e-mail field. Off until G2 verifies the sending domain. */
  magicLink: boolean
  /**
   * Why Google is missing, when it is. `preview` is the documented
   * degradation; `not_configured` is a deployment missing its secrets.
   */
  googleUnavailable: 'preview' | 'not_configured' | null
}

/**
 * Which ways in this deployment can actually complete.
 *
 * Deliberately conservative: a provider is offered only when every piece it
 * needs is present. Offering one that cannot finish costs the user a round trip
 * to Google and returns them an error page in English.
 */
export function providerAvailability(env: Env = process.env): ProviderAvailability {
  const secret = value(env, AUTH_SECRET_VAR)
  const googleConfigured = Boolean(
    secret && value(env, GOOGLE_ID_VAR) && value(env, GOOGLE_SECRET_VAR),
  )
  const proxied = Boolean(redirectProxyUrl(env))
  // A preview hostname cannot be a registered redirect URI, so without the
  // proxy the flow is guaranteed to fail at Google. Do not offer it.
  const blockedByPreview = isPreview(env) && !proxied

  const magicLink = Boolean(
    secret &&
      value(env, MAGIC_LINK_VAR) === '1' &&
      first(env, RESEND_KEY_VARS) &&
      value(env, MAGIC_LINK_FROM_VAR),
  )

  return {
    google: googleConfigured && !blockedByPreview,
    magicLink,
    googleUnavailable: googleConfigured
      ? blockedByPreview
        ? 'preview'
        : null
      : 'not_configured',
  }
}

/** Nothing can sign anybody in. The screen says so instead of drawing buttons. */
export function noWayIn(availability: ProviderAvailability): boolean {
  return !availability.google && !availability.magicLink
}

export function resendKey(env: Env = process.env): string {
  return first(env, RESEND_KEY_VARS)
}

export function magicLinkFrom(env: Env = process.env): string {
  return value(env, MAGIC_LINK_FROM_VAR)
}
