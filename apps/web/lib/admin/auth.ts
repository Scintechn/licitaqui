/**
 * Who may open `/admin`, until task U1 brings Auth.js.
 *
 * ## The gate
 *
 * There are no accounts yet, so `/admin` is behind HTTP Basic over TLS:
 *
 *  - the **username** is an e-mail address and must appear in `ADMIN_EMAILS`;
 *  - the **password** is one shared secret, `ADMIN_PASSWORD`, compared in
 *    constant time.
 *
 * The allowlist alone would be no gate at all — an e-mail address is public —
 * so both are required. When U1 lands, `authorizeAdmin()` is the single seam:
 * it starts reading the session instead of the header, and the allowlist stays
 * as the authorisation half.
 *
 * ## Fail closed
 *
 * Every way of *not* being configured denies access. No allowlist, an empty
 * allowlist, no password, a password too short to be worth having: all of them
 * are `not_configured`, which serves 403 to everybody. There is no code path in
 * which a missing variable opens the page — that is what the tests in
 * `auth.test.ts` pin down, one case per way of getting it wrong.
 *
 * ## What is never logged
 *
 * Nothing in this module prints the e-mail, the password, the header or the
 * allowlist (§12). A denial is reported by its `reason` alone.
 */

/** Comma-, semicolon-, whitespace- or newline-separated e-mail addresses. */
export const ADMIN_EMAILS_VAR = 'ADMIN_EMAILS'

/** The shared password those addresses sign in with. At least 12 characters. */
export const ADMIN_PASSWORD_VAR = 'ADMIN_PASSWORD'

/**
 * Short enough to type on a phone, long enough that guessing it is not a plan.
 * A shorter value is treated as a misconfiguration, not as a weak password.
 */
export const MIN_PASSWORD_LENGTH = 12

/** The realm the browser shows in its prompt. */
export const ADMIN_REALM = 'LicitaQui admin'

export type AdminDenial =
  /** `ADMIN_EMAILS` or `ADMIN_PASSWORD` is missing, empty or unusable. */
  | 'not_configured'
  /** No `Authorization: Basic` header, or one that does not parse. */
  | 'missing_credentials'
  /** Parsed, but the e-mail is not on the list or the password is wrong. */
  | 'bad_credentials'

export type AdminAuth = { ok: true; email: string } | { ok: false; reason: AdminDenial }

export type Env = Record<string, string | undefined>

/**
 * The configured addresses, lowercased and de-duplicated. An entry without an
 * `@` is dropped: it can never match, and keeping it would make a typo look
 * like a configured allowlist.
 */
export function parseAllowlist(raw: string | undefined): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  for (const part of raw.split(/[\s,;]+/)) {
    const email = part.trim().toLowerCase()
    if (email.includes('@') && email.length <= 254) seen.add(email)
  }
  return [...seen]
}

export type AdminConfig =
  | { configured: true; allowlist: string[]; password: string }
  | { configured: false }

export function adminConfig(env: Env = process.env): AdminConfig {
  const allowlist = parseAllowlist(env[ADMIN_EMAILS_VAR])
  const password = env[ADMIN_PASSWORD_VAR] ?? ''
  if (allowlist.length === 0) return { configured: false }
  if (password.length < MIN_PASSWORD_LENGTH) return { configured: false }
  return { configured: true, allowlist, password }
}

/** Whether this address is on the list. Case-insensitive; never a substring match. */
export function isAllowedAdmin(email: string, allowlist: readonly string[]): boolean {
  return allowlist.includes(email.trim().toLowerCase())
}

type BasicCredentials = { user: string; password: string }

/**
 * Reads `Authorization: Basic base64(user:password)`.
 *
 * Only the **first** colon splits, because a password may contain colons
 * (RFC 7617); a username may not.
 */
export function parseBasicHeader(header: string | null): BasicCredentials | null {
  if (!header) return null
  const [scheme, ...rest] = header.trim().split(/\s+/)
  if (!scheme || scheme.toLowerCase() !== 'basic' || rest.length !== 1) return null

  let decoded: string
  try {
    decoded = new TextDecoder().decode(
      Uint8Array.from(atob(rest[0]), (character) => character.charCodeAt(0)),
    )
  } catch {
    return null
  }

  const colon = decoded.indexOf(':')
  if (colon <= 0) return null
  return { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) }
}

/**
 * Constant-time string comparison.
 *
 * Hand-written rather than `crypto.timingSafeEqual` because this module runs in
 * `proxy.ts` as well as in a route handler, and the two do not guarantee the
 * same runtime. The length is compared first and then every character is
 * examined regardless: the loop runs over the longer of the two, so it cannot
 * return early on the first difference.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length)
  let difference = a.length ^ b.length
  for (let i = 0; i < length; i += 1) {
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return difference === 0
}

/**
 * The single decision. Everything that serves anything under `/admin` — the
 * page, the CSV route, the proxy — asks this and nothing else.
 */
export function authorizeAdmin(headers: Headers, env: Env = process.env): AdminAuth {
  const config = adminConfig(env)
  if (!config.configured) return { ok: false, reason: 'not_configured' }

  const credentials = parseBasicHeader(headers.get('authorization'))
  if (!credentials) return { ok: false, reason: 'missing_credentials' }

  // Both halves are evaluated before either is tested, so an unknown e-mail
  // costs the same as a wrong password and the response cannot say which was
  // wrong — to the caller or to a stopwatch.
  const emailOk = isAllowedAdmin(credentials.user, config.allowlist)
  const passwordOk = constantTimeEquals(credentials.password, config.password)
  if (!(emailOk && passwordOk)) return { ok: false, reason: 'bad_credentials' }

  return { ok: true, email: credentials.user.trim().toLowerCase() }
}

/**
 * Headers every `/admin` response carries: never cached anywhere (spec §3.3,
 * "user data: dynamic, no CDN cache") and never indexed.
 */
export const ADMIN_HEADERS: Record<string, string> = {
  'cache-control': 'private, no-store, max-age=0, must-revalidate',
  'x-robots-tag': 'noindex, nofollow, noarchive',
  referrer: 'no-referrer',
}

/** The HTTP answer to a denial. Text, so it never leaks markup or data. */
export function denyResponse(reason: AdminDenial): Response {
  if (reason === 'not_configured') {
    // 403, not 401: no credentials could possibly work, so a browser prompt
    // would only loop. Naming the variables reveals nothing and is the fastest
    // route from "I get a 403" to "I forgot to set it".
    return new Response(
      `/admin is not configured. Set ${ADMIN_EMAILS_VAR} (allowed e-mail addresses) and ` +
        `${ADMIN_PASSWORD_VAR} (at least ${MIN_PASSWORD_LENGTH} characters).\n`,
      { status: 403, headers: { ...ADMIN_HEADERS, 'content-type': 'text/plain; charset=utf-8' } },
    )
  }

  return new Response('Acesso restrito.\n', {
    status: 401,
    headers: {
      ...ADMIN_HEADERS,
      'content-type': 'text/plain; charset=utf-8',
      'www-authenticate': `Basic realm="${ADMIN_REALM}", charset="UTF-8"`,
    },
  })
}
