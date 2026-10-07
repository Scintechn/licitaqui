/**
 * Where the journeys' server lives, and what it is configured with — in one
 * place, because two files now need to agree about it.
 *
 * `playwright.config.ts` starts the server with `E2E_SERVER_ENV` and points the
 * suite at `E2E_BASE_URL`; `radar-api.ts` needs the same base URL to put a
 * cookie in the browser's jar, and the same `AUTH_SECRET` to stamp the cookie
 * the real route would have stamped (D60). Two copies of a port number is D29's
 * shape, and a port is the cheapest possible way to learn that lesson again.
 *
 * **Plain values and no `@/` imports**, because `playwright.config.ts` is loaded
 * by Playwright's own TypeScript loader before any test runs.
 */

export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100)

export const E2E_BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${E2E_PORT}`

/**
 * **Placeholders, not secrets.** They exist so `/conta/criar` renders the state
 * a configured deployment renders (both ways in, per U2) instead of the "login
 * não configurado" degradation. No sign-in is ever completed against them.
 *
 * `AUTH_SECRET` is also the key material `lib/radar/scope.ts` derives its digest
 * from. Nothing in the suite depends on the fixture's digest *matching* the
 * server's — the server treats `lq_scope` as opaque bytes and only ever hashes
 * whatever is in it — which is why these journeys still work against a real
 * deployment, where `E2E_BASE_URL` is set and this block is never applied.
 */
export const E2E_SERVER_ENV = {
  NEXT_TELEMETRY_DISABLED: '1',
  AUTH_SECRET: 'e2e-placeholder-not-a-secret',
  AUTH_GOOGLE_ID: 'e2e-placeholder.apps.googleusercontent.com',
  AUTH_GOOGLE_SECRET: 'e2e-placeholder-not-a-secret',
  AUTH_MAGIC_LINK: '1',
  RESEND_API_KEY: 're_e2e_placeholder',
  AUTH_EMAIL_FROM: 'noreply@example.invalid',
} as const
