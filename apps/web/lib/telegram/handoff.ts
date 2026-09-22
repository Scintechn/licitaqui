import { botUsername, deepLink, type Env, TOKEN_TTL_SECONDS } from './config'
import { verifyToken } from './token'

/**
 * The hand-off: what happens between "Conectar o Telegram" and the bot
 * answering (task E3, spec §9).
 *
 * ## Why this module exists
 *
 * E1 pressed the button and redirected straight to `t.me`. That is one tap, and
 * it is also a cliff: from the moment the browser leaves, `/conta/alertas` has
 * no idea whether anything happened. On 22/09 a `/start` was turned away at the
 * webhook — production's `TELEGRAM_WEBHOOK_SECRET` did not match the
 * `secret_token` given to `setWebhook`, so every delivery answered 401 — and
 * the screen went on showing "Conectar o Telegram" as though the person had
 * never pressed it. The failure was invisible **on the page** whatever its
 * cause, and that is the part this module fixes: a link that was issued is
 * remembered, so the screen can say *waiting*, say *it did not arrive*, and
 * offer the token to send by hand.
 *
 * ## What is deliberately NOT claimed here
 *
 * The card suspected that `t.me/<bot>?start=<token>` auto-sends its payload
 * only for a first-ever conversation, so that anyone with chat history silently
 * fails. **That was not what happened on 22/09** and nothing in this repo
 * demonstrates it, so no code here special-cases a returning chat. The manual
 * fallback covers that case if it is ever real, and covers every other reason a
 * `/start` does not arrive, without asserting a cause we have not seen.
 *
 * ## Where the state lives, and why no migration
 *
 * Two facts, two places, neither of them a new column:
 *
 *  * **"a token is outstanding"** is `telegram_links.start_token is not null
 *    and chat_id is null`, which `readLinkStatus` now returns as `pending`.
 *    Account-wide, and true on every device.
 *  * **"*this browser* is mid-attempt"** is a short-lived cookie holding the
 *    plaintext token. The database keeps only `sha256(token)` (see `token.ts`),
 *    so the token that has to be shown for the manual fallback exists nowhere
 *    else — and it must not be re-minted at render time, because minting
 *    supersedes and a `GET` that invalidates the link the person is holding is
 *    worse than no fallback at all.
 *
 * The cookie needs no expiry of its own beyond its `Max-Age`: the token carries
 * its own (four bytes of it, signed), and `verifyToken` hands that back. One
 * clock, not two that can disagree.
 *
 * ## LGPD (§12)
 *
 * The token is a bearer credential — it is enough to attach a Telegram chat to
 * an account — so the cookie is `httpOnly` and nothing here logs it. No chat id
 * ever reaches this module.
 */

/** The plaintext `/start` token for the attempt this browser is in the middle of. */
export const HANDOFF_COOKIE = 'licitaqui_tg_link'

/**
 * The cookie dies with the token. There is no value in a cookie that outlives
 * the credential in it: the screen would offer a `/start` that cannot work.
 */
export const HANDOFF_MAX_AGE = TOKEN_TTL_SECONDS

/** "Este link vale por 15 minutos" — the number comes from the TTL, never typed. */
export const HANDOFF_MINUTES = Math.round(TOKEN_TTL_SECONDS / 60)

/**
 * Scoped to the account area. The Radar and the public pages have no business
 * receiving it, and a narrower path is one fewer place it can leak from.
 */
export const HANDOFF_PATH = '/conta'

export type LinkPhase =
  /** A chat is attached. Nothing to wait for. */
  | { phase: 'linked' }
  /**
   * A link was issued from this browser and is still good. The screen shows the
   * deep link, the `/start <token>` to send by hand, and a way to re-check.
   */
  | { phase: 'waiting'; token: string; url: string; command: string; expiresAt: Date }
  /**
   * Something was started and nothing came back — the token in this browser has
   * expired, or the account has an outstanding token this browser knows nothing
   * about (linked from a phone, came back on a laptop). Both want the same
   * thing on screen: say so, and offer another link.
   */
  | { phase: 'failed' }
  /** Never attempted, or the last attempt was cleaned up. */
  | { phase: 'idle' }

/**
 * What `/conta/alertas` should be showing, from the three facts it can know.
 *
 * Pure, and the reason the screen is testable: no cookie jar, no database and
 * no `next/headers` — the page reads those and hands the answers in.
 *
 * Order matters. `linked` wins over everything, including a cookie left behind
 * by the attempt that succeeded: the person is connected and being asked to
 * keep waiting is the bug this whole module exists to remove.
 */
export function linkPhase(input: {
  linked: boolean
  /** `telegram_links.start_token is not null and chat_id is null`. */
  pending: boolean
  /** The plaintext token from `HANDOFF_COOKIE`, or `null`. */
  handoffToken: string | null
  env?: Env
  now?: Date
}): LinkPhase {
  const { linked, pending, handoffToken, env, now } = input
  if (linked) return { phase: 'linked' }

  if (handoffToken) {
    const verdict = verifyToken(handoffToken, { env, now })
    if (verdict.ok) {
      return {
        phase: 'waiting',
        token: handoffToken,
        url: deepLink(handoffToken, env),
        command: startCommand(handoffToken),
        expiresAt: verdict.expiresAt,
      }
    }
    // Ours and stale, or not ours at all. Either way this browser cannot finish
    // the attempt it started, which is exactly what `failed` is for.
    return { phase: 'failed' }
  }

  return pending ? { phase: 'failed' } : { phase: 'idle' }
}

/**
 * What to type into the conversation when the deep link did not send it.
 *
 * Exactly the text Telegram itself would have sent, because `readUpdate` parses
 * one grammar and a helpful variation would not link anything.
 */
export function startCommand(token: string): string {
  return `/start ${token}`
}

/** `@LicitaQuiBot`, for copy that has to name the conversation to look in. */
export function botHandle(env: Env = process.env): string {
  return `@${botUsername(env)}`
}
