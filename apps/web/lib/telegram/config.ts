/**
 * Telegram configuration, in one place (task E1, spec §9, §8).
 *
 * The house pattern for anything with an environment variable in it:
 * a `*_VAR` constant per name, and every function taking `env` so a test can
 * inject one instead of mutating `process.env`. Same shape as
 * `lib/auth/config.ts` and `lib/admin/auth.ts`.
 *
 * ## Fail closed
 *
 * `webhookSecret()` returns `''` when the variable is missing or too short, and
 * `POST /api/telegram/webhook` turns that into a 503 for everybody. There is no
 * code path in which an unset variable opens the endpoint — it is public, it
 * accepts arbitrary JSON, and it writes to `telegram_links`.
 *
 * ## What is never logged
 *
 * Nothing here prints the secret, the link key or a token (§12). The bot
 * username is public — it is in the deep link a person taps — and is the only
 * value any error message may name.
 */

export type Env = Record<string, string | undefined>

/** The bot the deep link opens. `@LicitaQuiBot` is ours alone (spec §9.2). */
export const BOT_USERNAME_VAR = 'TELEGRAM_BOT_USERNAME'
export const DEFAULT_BOT_USERNAME = 'LicitaQuiBot'

/**
 * The value Telegram echoes in `X-Telegram-Bot-Api-Secret-Token` on every
 * webhook delivery, set once with `setWebhook`.
 */
export const WEBHOOK_SECRET_VAR = 'TELEGRAM_WEBHOOK_SECRET'

/**
 * A secret is worth having only if guessing it is not a plan. Telegram allows
 * 1–256 characters of `A-Za-z0-9_-`; anything short enough to brute-force is
 * treated as a misconfiguration rather than as a weak secret.
 */
export const MIN_WEBHOOK_SECRET_LENGTH = 16

/**
 * The key the start token is signed with.
 *
 * `AUTH_SECRET` is the fallback rather than a second variable to provision,
 * because it is already set everywhere this code runs and a link token is the
 * same class of thing as a session cookie. It is **not** used directly:
 * `token.ts` derives a separate key from it with a fixed label, so a signature
 * made here can never be confused with one Auth.js made.
 */
export const LINK_SECRET_VARS = ['TELEGRAM_LINK_SECRET', 'AUTH_SECRET'] as const

/** How long a `/start` deep link stays usable. */
export const TOKEN_TTL_SECONDS = 15 * 60

function value(env: Env, name: string): string {
  return (env[name] ?? '').trim()
}

export function botUsername(env: Env = process.env): string {
  return value(env, BOT_USERNAME_VAR) || DEFAULT_BOT_USERNAME
}

/** The configured webhook secret, or `''` when it is missing or unusable. */
export function webhookSecret(env: Env = process.env): string {
  const secret = value(env, WEBHOOK_SECRET_VAR)
  return secret.length >= MIN_WEBHOOK_SECRET_LENGTH ? secret : ''
}

/** The key material `token.ts` derives from, or `''` when nothing is set. */
export function linkSecret(env: Env = process.env): string {
  for (const name of LINK_SECRET_VARS) {
    const found = value(env, name)
    if (found) return found
  }
  return ''
}

/**
 * `https://t.me/LicitaQuiBot?start=<token>` — the whole point of the feature.
 *
 * Tapping this on a phone opens the Telegram app straight into a conversation
 * with the bot, with the token already in the `/start` it sends. That is the
 * "one tap from phone" the card asks for: nothing is typed, and the token
 * never touches the clipboard.
 *
 * Telegram restricts the `start` parameter to `A-Za-z0-9_-`, 1–64 characters.
 * `token.ts` emits base64url, which is exactly that alphabet, and
 * `assertDeepLinkable` refuses anything else rather than producing a link that
 * silently drops characters.
 */
export function deepLink(token: string, env: Env = process.env): string {
  assertDeepLinkable(token)
  return `https://t.me/${botUsername(env)}?start=${token}`
}

export const START_PARAMETER_RE = /^[A-Za-z0-9_-]{1,64}$/

export function assertDeepLinkable(token: string): void {
  if (!START_PARAMETER_RE.test(token)) {
    // The token is not in the message: it is a credential, short-lived or not.
    throw new Error('a Telegram start parameter is 1-64 characters of [A-Za-z0-9_-]')
  }
}
