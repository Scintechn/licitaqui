import { constantTimeEquals } from '@/lib/admin/auth'
import { type Env, webhookSecret, WEBHOOK_SECRET_VAR } from './config'

/**
 * Authenticating and reading a Telegram webhook update.
 *
 * Pure functions, no database and no I/O, so the route handler is short and
 * every rule below has a unit test that does not need a Neon branch.
 *
 * ## The header is the whole gate
 *
 * `POST /api/telegram/webhook` is a **public** endpoint that accepts arbitrary
 * JSON and writes to `telegram_links`. Nothing else stands in front of it —
 * `proxy.ts` matches only `/admin` and `/api/admin` — so the one defence is the
 * value Telegram echoes in `X-Telegram-Bot-Api-Secret-Token`, which is set once
 * with `setWebhook` and known only to Telegram and to us.
 *
 * Three properties, each deliberate:
 *
 *  * **constant time.** `constantTimeEquals` is the one `lib/admin/auth.ts`
 *    already uses — hand-written rather than `crypto.timingSafeEqual` because
 *    that throws on a length mismatch, which is itself an oracle.
 *  * **fail closed.** No secret configured, or one too short to be worth
 *    having, is `not_configured`, which serves 503 to everybody. There is no
 *    path in which a missing variable opens the endpoint.
 *  * **no IP allowlist.** Telegram publishes its ranges, but they change, and
 *    an allowlist that silently rots turns into an outage nobody attributes to
 *    it. The shared secret is the guarantee; the address is not checked.
 *
 * ## Reading the update
 *
 * Telegram sends far more than this product answers — edited messages, channel
 * posts, reactions, callbacks. Anything that is not a private text message is
 * `ignore`, and the route still answers 200: a 4xx makes Telegram redeliver
 * the same update for a day, and there is nothing to retry.
 *
 * §12: nothing here logs. The parsed value carries a chat id, which is
 * personal data and belongs only in the job payload and in `telegram_links`.
 */

export type WebhookDenial = 'not_configured' | 'bad_secret'

export type WebhookAuth = { ok: true } | { ok: false; reason: WebhookDenial }

export const SECRET_HEADER = 'x-telegram-bot-api-secret-token'

export function authorizeWebhook(headers: Headers, env: Env = process.env): WebhookAuth {
  const expected = webhookSecret(env)
  if (!expected) return { ok: false, reason: 'not_configured' }
  const presented = headers.get(SECRET_HEADER) ?? ''
  if (!constantTimeEquals(presented, expected)) return { ok: false, reason: 'bad_secret' }
  return { ok: true }
}

export function denyWebhook(reason: WebhookDenial): Response {
  if (reason === 'not_configured') {
    return new Response(
      `The Telegram webhook is not configured. Set ${WEBHOOK_SECRET_VAR}.\n`,
      { status: 503, headers: TEXT_HEADERS },
    )
  }
  // 401 and nothing else: an unauthenticated caller learns only that the
  // endpoint exists, which the bot's own webhook URL already tells Telegram.
  return new Response('unauthorized\n', { status: 401, headers: TEXT_HEADERS })
}

const TEXT_HEADERS: Record<string, string> = {
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'private, no-store',
  'x-robots-tag': 'noindex, nofollow',
}

/** The commands the bot answers. `templates README` §4: advertise no others. */
export const COMMANDS = {
  start: 'start',
  help: 'ajuda',
  stop: 'pausar',
} as const

export type Command = (typeof COMMANDS)[keyof typeof COMMANDS]

export type Update =
  | { kind: 'start'; updateId: number; chatId: number; token: string | null }
  | { kind: 'help' | 'stop'; updateId: number; chatId: number }
  | { kind: 'ignore' }

/**
 * `/pausar` and `/ajuda` in Portuguese, plus the English spellings Telegram's
 * own clients suggest and people type out of habit. `/start` is Telegram's,
 * not ours: it is the command the deep link sends and it has no translation.
 */
const ALIASES: Record<string, Command> = {
  start: COMMANDS.start,
  ajuda: COMMANDS.help,
  help: COMMANDS.help,
  pausar: COMMANDS.stop,
  parar: COMMANDS.stop,
  stop: COMMANDS.stop,
}

/** Telegram's own cap on a `start` parameter. Anything longer is not ours. */
const MAX_ARGUMENT = 64

export function readUpdate(body: unknown): Update {
  if (!isRecord(body)) return { kind: 'ignore' }
  const updateId = body.update_id
  const message = body.message
  if (typeof updateId !== 'number' || !isRecord(message)) return { kind: 'ignore' }

  const chat = message.chat
  if (!isRecord(chat) || typeof chat.id !== 'number') return { kind: 'ignore' }
  // Only a one-to-one conversation. A group the bot was added to has no
  // account behind it, and a digest is one company's business.
  if (chat.type !== undefined && chat.type !== 'private') return { kind: 'ignore' }

  const text = typeof message.text === 'string' ? message.text.trim() : ''
  if (!text.startsWith('/')) return { kind: 'ignore' }

  const [head, ...rest] = text.split(/\s+/)
  // `/start@LicitaQuiBot` is what Telegram sends when the bot is addressed by
  // name, which happens the moment anyone adds it to a group.
  const name = head.slice(1).split('@')[0].toLowerCase()
  const command = ALIASES[name]
  if (!command) return { kind: 'ignore' }

  if (command === COMMANDS.start) {
    const argument = rest[0] ?? ''
    const token = argument && argument.length <= MAX_ARGUMENT ? argument : null
    return { kind: 'start', updateId, chatId: chat.id, token }
  }
  return { kind: command === COMMANDS.help ? 'help' : 'stop', updateId, chatId: chat.id }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
