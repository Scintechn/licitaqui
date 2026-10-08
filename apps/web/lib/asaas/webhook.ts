import { constantTimeEquals } from '@/lib/admin/auth'
import { type Env, webhookToken, WEBHOOK_TOKEN_VAR } from './config'

/**
 * Authenticating and reading an Asaas webhook delivery — task **F2**.
 *
 * Pure functions, no database and no I/O, so the route handler is short and
 * every rule below has a unit test that needs no Neon branch. Same shape as
 * `lib/telegram/webhook.ts`, whose docstring explains the three properties of
 * the header check (constant time, fail closed, no IP allowlist); they apply
 * here unchanged and are not repeated. What is different about Asaas is worth
 * spelling out, because two of the differences are expensive.
 *
 * ## There is no signature. The token is the whole gate.
 *
 * Asaas does not sign webhook bodies — no HMAC, no timestamp, no signing
 * secret. The static value in `asaas-access-token` is all there is. So it is
 * compared in constant time and it fails closed when unset.
 *
 * A replayed body is therefore indistinguishable from a redelivery, which is
 * fine: `webhook_events.id` makes replaying one harmless, and
 * `lib/asaas/entitlement.ts` grants nothing for a subscription id it did not
 * create itself, so a forged body cannot invent a subscriber.
 *
 * ## `200`, exactly, and within ten seconds
 *
 * Telegram's rule is *"a non-2xx makes it redeliver for a day"*. Asaas is
 * stricter in both directions and the penalty is worse:
 *
 *  * It counts **only HTTP 200** as success. `201` and `204` are failures —
 *    their docs say so twice, contradicting their own overview page's looser
 *    "2xx", so this file's callers return 200 with a body rather than the 204
 *    that would otherwise be tasteful.
 *  * It waits **10 seconds**, then records a read timeout.
 *  * It does **not follow redirects**: 301/302/307/308 all count as failures.
 *  * After **15 consecutive failures the queue is paused** for that webhook,
 *    and undelivered events are deleted after **14 days**.
 *
 * So a paused queue is not "payments arrive late". It is payments we never
 * hear about, on accounts that have been charged, with the evidence gone. The
 * receiver's contract is: authenticate, persist, apply, answer 200.
 *
 * ## Parse permissively
 *
 * Asaas's docs warn, in their own bold, that new attributes appear in webhook
 * payloads without a version bump and that throwing while parsing one can
 * interrupt the delivery queue. So {@link readEvent} validates only the fields
 * the receiver needs, ignores everything else, and never rejects a body for
 * carrying more than it expected.
 *
 * §12: nothing here logs. A body carries the customer's name, CPF/CNPJ and
 * e-mail; it belongs in `webhook_events.body` and nowhere else.
 */

export type WebhookDenial = 'not_configured' | 'bad_token'

export type WebhookAuth = { ok: true } | { ok: false; reason: WebhookDenial }

/** Asaas's own header name, lower-cased as `Headers.get` wants it. */
export const TOKEN_HEADER = 'asaas-access-token'

export function authorizeWebhook(headers: Headers, env: Env = process.env): WebhookAuth {
  const expected = webhookToken(env)
  if (!expected) return { ok: false, reason: 'not_configured' }
  const presented = headers.get(TOKEN_HEADER) ?? ''
  if (!constantTimeEquals(presented, expected)) return { ok: false, reason: 'bad_token' }
  return { ok: true }
}

const TEXT_HEADERS: Record<string, string> = {
  'content-type': 'text/plain; charset=utf-8',
  'cache-control': 'private, no-store',
  'x-robots-tag': 'noindex, nofollow',
}

export function denyWebhook(reason: WebhookDenial): Response {
  if (reason === 'not_configured') {
    return new Response(`The Asaas webhook is not configured. Set ${WEBHOOK_TOKEN_VAR}.\n`, {
      status: 503,
      headers: TEXT_HEADERS,
    })
  }
  // 401 and nothing else: an unauthenticated caller learns only that the
  // endpoint exists, which the webhook URL we registered already tells Asaas.
  return new Response('unauthorized\n', { status: 401, headers: TEXT_HEADERS })
}

/**
 * Asaas ids are opaque strings and this puts a ceiling on the one used as a
 * primary key. 255 is generous — the documented shape is about 50 characters —
 * and it exists so a hostile 10 MB "id" cannot be handed to Postgres as a key.
 */
export const MAX_EVENT_ID_LENGTH = 255

export type AsaasEvent = {
  /** The envelope's `id`, e.g. `evt_05b708f9…`. Stable across redeliveries. */
  id: string
  /** e.g. `PAYMENT_CONFIRMED`. Uppercased so a comparison cannot drift. */
  event: string
  /** The payment this event is about, when the envelope carries one. */
  paymentId: string | null
  /** The subscription this event is about, when the envelope carries one. */
  subscriptionId: string | null
  /** The whole body, stored verbatim. Never narrowed; see the docstring. */
  body: Record<string, unknown>
}

/**
 * The fields the receiver needs, or `null`.
 *
 * `null` is not an error the caller reports to Asaas: an authenticated body we
 * cannot read is answered 200, because a retry cannot make it readable and 15
 * of them would pause the queue.
 */
export function readEvent(body: unknown): AsaasEvent | null {
  if (!isRecord(body)) return null
  const id = typeof body.id === 'string' ? body.id.trim() : ''
  const event = typeof body.event === 'string' ? body.event.trim().toUpperCase() : ''
  if (!id || id.length > MAX_EVENT_ID_LENGTH || !event) return null

  // A payment event carries `payment: {...}`; a subscription event carries
  // `subscription: {...}`. Both shapes are read here so the handler does not
  // have to know the envelope, and both are optional — an event about neither
  // is one we do not handle, which is a 200 with nothing done.
  const payment = isRecord(body.payment) ? body.payment : null
  const subscription = isRecord(body.subscription) ? body.subscription : null

  const paymentId = payment && typeof payment.id === 'string' ? payment.id : null
  const subscriptionId =
    // On a payment event, the subscription is a bare id string on the payment.
    payment && typeof payment.subscription === 'string'
      ? payment.subscription
      : subscription && typeof subscription.id === 'string'
        ? subscription.id
        : null

  return { id, event, paymentId, subscriptionId, body }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The events this receiver acts on, and what each one means for access.
 *
 * Everything else is persisted and answered 200 with nothing done — which is
 * most of Asaas's catalogue, and deliberately: an event we have no rule for
 * must not be a failed job, because fifteen of those pause the queue.
 *
 * **Chargebacks are in this table**, which the 2026-09-25 draft got wrong in a
 * way worth recording: it listed `CHARGEBACK_REQUESTED` and
 * `CHARGEBACK_DISPUTE` among the statuses that revoke access and then did not
 * list the *events* that carry them, so a charged-back account kept its paid
 * plan and two constants were dead. A status vocabulary and an event
 * vocabulary are two lists, and only one of them arrives in the webhook.
 */
export const GRANTS: ReadonlySet<string> = new Set([
  'PAYMENT_CONFIRMED',
  'PAYMENT_RECEIVED',
  'PAYMENT_RECEIVED_IN_CASH',
])

export const REVOKES: ReadonlySet<string> = new Set([
  'PAYMENT_REFUNDED',
  'PAYMENT_PARTIALLY_REFUNDED',
  'PAYMENT_CHARGEBACK_REQUESTED',
  'PAYMENT_CHARGEBACK_DISPUTE',
  'PAYMENT_AWAITING_CHARGEBACK_REVERSAL',
  'PAYMENT_RECEIVED_IN_CASH_UNDONE',
  'PAYMENT_DELETED',
])

/** Not a grant and not a revocation: a state to record on the row. */
export const RECORDS: ReadonlySet<string> = new Set([
  'PAYMENT_CREATED',
  'PAYMENT_UPDATED',
  'PAYMENT_OVERDUE',
  'PAYMENT_AWAITING_RISK_ANALYSIS',
  'PAYMENT_APPROVED_BY_RISK_ANALYSIS',
  'PAYMENT_REPROVED_BY_RISK_ANALYSIS',
])

/** Asaas says the subscription itself is over. */
export const ENDS: ReadonlySet<string> = new Set([
  'SUBSCRIPTION_DELETED',
  'SUBSCRIPTION_INACTIVATED',
])

export type EventEffect = 'grant' | 'revoke' | 'record' | 'end' | 'ignore'

export function effectOf(event: string): EventEffect {
  if (GRANTS.has(event)) return 'grant'
  if (REVOKES.has(event)) return 'revoke'
  if (RECORDS.has(event)) return 'record'
  if (ENDS.has(event)) return 'end'
  return 'ignore'
}
