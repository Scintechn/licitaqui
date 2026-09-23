import { ACCOUNT_CREATE_PATH } from '@/lib/routes'

/**
 * The screens Auth.js redirects to, and the one rule they all obey.
 *
 * ## Every value here must be a bare path
 *
 * Auth.js appends its own query string to all three, and only two of them join
 * it correctly:
 *
 * * `signIn` → `${pages.signIn}${includes("?") ? "&" : "?"}callbackUrl=…`
 * * `error`  → `${pages.error}${includes("?") ? "&" : "?"}error=…`
 * * `verifyRequest` → `${pages.verifyRequest}${url.search}` — **no join at
 *   all** (`@auth/core/lib/pages/index.js`).
 *
 * `verifyRequest` carried `?enviado=1` until 2026-09-23, so every magic-link
 * sign-in redirected to
 *
 *     /conta/criar?enviado=1?provider=resend&type=email
 *
 * Two `?` in one URL. `enviado` parsed as `1?provider=resend`, the comparison
 * against `'1'` on the account page was permanently false, and the "Link
 * enviado" card — written, translated and correct — never rendered. Somebody
 * who had just been e-mailed a working link saw an empty sign-in form instead.
 * It looked broken and it had worked, which is the worst possible ordering.
 *
 * ## Why this is its own module
 *
 * So the rule can be *tested*. `lib/auth/index.ts` constructs NextAuth, which
 * cannot be imported in the unit suite, so the invariant would otherwise be a
 * comment. `pages.test.ts` imports this file and nothing else, and fails if a
 * `?` ever reappears in any of the three.
 *
 * The "we sent it" signal now comes from Auth.js's own `type=email` — see
 * `verify-request.ts`.
 */
export const AUTH_PAGES = {
  signIn: ACCOUNT_CREATE_PATH,
  error: ACCOUNT_CREATE_PATH,
  verifyRequest: ACCOUNT_CREATE_PATH,
} as const
