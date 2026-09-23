import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { recordEventSafely } from '@/lib/events'
import {
  enqueueJob,
  JOB_KINDS,
  PRIORITY_USER_WAITING,
  sendTelegramPayload,
  type TelegramReply,
} from '@/lib/jobs'
import { wakeWorker } from '@/lib/jobs/wake'
import { rateLimitRequest } from '@/lib/rate-limit'
import { ensureAlert, linkChat, setAlertActive, userForChat } from '@/lib/telegram/link'
import { digestOf, LinkSecretMissing, verifyToken } from '@/lib/telegram/token'
import {
  authorizeWebhook,
  denyWebhook,
  readUpdate,
  type Update,
} from '@/lib/telegram/webhook'

/**
 * `POST /api/telegram/webhook` — spec §8, task E1.
 *
 * The bot's single webhook. It authenticates the delivery, does the
 * `telegram_links` write, and **enqueues** the reply: rendering E0's Portuguese
 * and calling the Bot API belong to the worker, where the templates, the
 * circuit breaker and the `TELEGRAM_DELIVERY` kill switch live. §3's rule —
 * a web request never calls an external service — and the practical version of
 * it, which is that a webhook has to answer fast or Telegram redelivers it.
 *
 * `wakeWorker()` then cuts the consumer's two-minute idle poll short, so the
 * greeting lands in about a second rather than up to two minutes. Without it,
 * "one tap from phone" would be one tap and then a wait long enough to assume
 * it had failed.
 *
 * ## Why almost everything answers 200
 *
 * A non-2xx makes Telegram redeliver the same update, backing off, for about a
 * day. That is the right behaviour for *our* transient failure — a database
 * blip, which is a 500 below — and the wrong behaviour for everything else: an
 * update we do not handle, a command we do not have, a token that expired. All
 * of those are `ok: true` with nothing queued, because there is nothing a
 * retry could change.
 *
 * ## Idempotency
 *
 * The reply job's key is the Telegram `update_id`
 * (`telegram_alerts.reply_job_key`), so a redelivery dedupes against the job
 * already queued instead of greeting somebody twice. The link write is
 * idempotent on its own: `linkChat` clears `start_token` in the same statement
 * that sets `chat_id`, and a second delivery of the same `/start` is then
 * answered as `already_linked`.
 *
 * ## LGPD (§12)
 *
 * A chat id is personal data and nothing here logs one. It does reach
 * `jobs.payload` for the two replies that have no account behind them — a bare
 * `/start`, and a `/start` whose token is spent — because there is nowhere else
 * to put it: the worker has to answer a chat it cannot name. Those rows carry
 * the chat id and a template id and nothing else, the same database already
 * holds the chat ids of everyone who did link, and the job is gone from
 * `status in ('queued','running')` as soon as it runs.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Generous: Telegram delivers from a small set of addresses and a real burst
 * is a burst of legitimate updates. This is a flood guard on an endpoint that
 * anyone can POST to, not a quota — the secret header is the gate.
 */
const RATE_LIMIT = { limit: 240, windowMs: 60_000 }

/** Telegram updates are small; anything large is not one. */
const MAX_BODY_BYTES = 64 * 1024

const HEADERS: Record<string, string> = {
  'cache-control': 'private, no-store',
  'x-robots-tag': 'noindex, nofollow',
}

/**
 * What this route decided to say. `lib/jobs` owns the type and, importantly,
 * owns turning it into the payload the worker reads: this object's `userId`
 * was being written to the queue verbatim, and the worker reads `user_id`, so
 * no reply enqueued here was ever deliverable. See `sendTelegramPayload`.
 */
type Reply = TelegramReply

export async function POST(request: Request): Promise<Response> {
  const decision = rateLimitRequest('telegram-webhook', request.headers, RATE_LIMIT)
  if (!decision.ok) {
    return NextResponse.json(
      { ok: false },
      { status: 429, headers: { ...HEADERS, 'retry-after': String(decision.retryAfter) } },
    )
  }

  const auth = authorizeWebhook(request.headers)
  if (!auth.ok) {
    // The reason is not in the response and not in a log line with an address
    // attached: an unauthenticated caller learns nothing either way.
    console.warn(`telegram webhook denied (${auth.reason})`)
    return denyWebhook(auth.reason)
  }

  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) return ok()

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    // Authenticated but unparseable. Nothing to retry.
    return ok()
  }

  const update = readUpdate(body)
  if (update.kind === 'ignore') return ok()

  try {
    const reply = await handle(update)
    if (!reply) return ok()

    const job = await enqueueJob({
      kind: JOB_KINDS.sendTelegram,
      key: replyJobKey(update.updateId),
      priority: PRIORITY_USER_WAITING,
      payload: sendTelegramPayload(reply),
    })
    // Only when the row is actually new: a deduped job is already queued, and
    // the insert that created it already woke the worker.
    if (!job.deduped) wakeWorker()
    return ok()
  } catch (error) {
    if (error instanceof LinkSecretMissing) {
      console.error('telegram webhook: no link secret configured')
      return new Response('not configured\n', { status: 503, headers: HEADERS })
    }
    const code = (error as { code?: string } | null)?.code ?? 'unknown'
    console.error(`POST /api/telegram/webhook failed (${code})`)
    // Ours, and transient. This is the one case where a redelivery helps.
    return NextResponse.json({ ok: false }, { status: 500, headers: HEADERS })
  }
}

/** Telegram only ever POSTs here. A GET is someone finding the URL. */
export function GET(): Response {
  return NextResponse.json({ ok: false }, { status: 405, headers: HEADERS })
}

async function handle(update: Exclude<Update, { kind: 'ignore' }>): Promise<Reply | null> {
  if (update.kind === 'start') return start(update.chatId, update.token)

  const userId = await userForChat(update.chatId)
  if (update.kind === 'help') {
    // `help.md` needs no account: it explains the product to whoever asked.
    return userId ? { template: 'help', userId } : { template: 'help', chatId: update.chatId }
  }

  // `/pausar`. A chat we do not know has nothing to pause, and saying so
  // truthfully is `start-no-token`: they never connected.
  if (!userId) return { template: 'start-no-token', chatId: update.chatId }
  await setAlertActive(userId, false)
  return { template: 'stop', userId }
}

async function start(chatId: number, token: string | null): Promise<Reply> {
  if (!token) return { template: 'start-no-token', chatId }

  const verdict = verifyToken(token)
  if (!verdict.ok) {
    // Expired, forged or malformed all read the same to the person holding it,
    // and `start-token-invalid` is E0's copy for exactly that: "generate
    // another". Distinguishing them in the reply would only tell an attacker
    // which half of their guess was right.
    const already = await userForChat(chatId)
    return already
      ? { template: 'start-already-linked', userId: already }
      : { template: 'start-token-invalid', chatId }
  }

  // One transaction: the detach, the link and the alert row are one change,
  // and half of it is an account that is connected and hears nothing.
  const outcome = await db().transaction(async (tx) => {
    const result = await linkChat({ digest: digestOf(token), chatId }, tx)
    if (result.status === 'linked') await ensureAlert(result.userId, tx)
    return result
  })

  if (outcome.status === 'invalid') {
    return { template: 'start-token-invalid', chatId }
  }
  if (outcome.status === 'already_linked') {
    return { template: 'start-already-linked', userId: outcome.userId }
  }

  // §14's gate metric. `props` carries no chat id: the row it points at does.
  await recordEventSafely({ name: 'telegram_linked', userId: outcome.userId })
  return { template: 'start-linked', userId: outcome.userId }
}

/** Mirrors `licitaqui.telegram_alerts.reply_job_key`. */
function replyJobKey(updateId: number): string {
  return `reply:${updateId}`
}

function ok(): Response {
  return NextResponse.json({ ok: true }, { status: 200, headers: HEADERS })
}
