import { describe, expect, it } from 'vitest'
import { WEBHOOK_TOKEN_VAR } from './config'
import {
  authorizeWebhook,
  denyWebhook,
  effectOf,
  MAX_EVENT_ID_LENGTH,
  readEvent,
  TOKEN_HEADER,
} from './webhook'

/**
 * Authenticating and reading an Asaas delivery.
 *
 * Pure functions, so every rule has a test that needs no database and no
 * network. The shape mirrors `lib/telegram/webhook.test.ts`; what is asserted
 * differently is asserted because **Asaas's failure mode is more expensive**:
 * fifteen consecutive non-200s pause the delivery queue and undelivered events
 * are deleted after fourteen days, so an over-strict check here loses payments
 * on accounts that have already been charged.
 */

const TOKEN = 'a-token-asaas-would-have-accepted-0001'
const env = { [WEBHOOK_TOKEN_VAR]: TOKEN }

const headersWith = (token: string | null) =>
  new Headers(token === null ? {} : { [TOKEN_HEADER]: token })

describe('authorizeWebhook', () => {
  it('accepts the configured token', () => {
    expect(authorizeWebhook(headersWith(TOKEN), env)).toEqual({ ok: true })
  })

  it('refuses a wrong token, and does not say which part was wrong', () => {
    const verdict = authorizeWebhook(headersWith(`${TOKEN}x`), env)
    expect(verdict).toEqual({ ok: false, reason: 'bad_token' })
    expect(denyWebhook('bad_token').status).toBe(401)
  })

  it('refuses a missing header', () => {
    expect(authorizeWebhook(headersWith(null), env)).toEqual({ ok: false, reason: 'bad_token' })
  })

  it('fails closed when nothing is configured, with a 503 naming the variable', async () => {
    expect(authorizeWebhook(headersWith(TOKEN), {})).toEqual({
      ok: false,
      reason: 'not_configured',
    })
    const response = denyWebhook('not_configured')
    expect(response.status).toBe(503)
    // The operator needs to know which variable; an unauthenticated caller
    // learns only that the endpoint exists, which the URL we registered with
    // Asaas already told them. Same trade as `lib/telegram/webhook.ts`.
    expect(await response.text()).toContain(WEBHOOK_TOKEN_VAR)
  })

  /**
   * **A short token authenticates.** The 2026-09-25 draft refused anything
   * under 32 characters because 32 is Asaas's documented floor, so a shorter
   * value "cannot be one Asaas accepted". The risk runs the wrong way: if the
   * console ever accepts a shorter one, every delivery gets a 503 and fifteen
   * of those pause the queue. An unset token still fails closed.
   */
  it('does not impose a length floor of its own', () => {
    expect(authorizeWebhook(new Headers({ [TOKEN_HEADER]: 'short' }), {
      [WEBHOOK_TOKEN_VAR]: 'short',
    })).toEqual({ ok: true })
  })

  it('treats a whitespace-only token as unset', () => {
    expect(authorizeWebhook(headersWith(' '), { [WEBHOOK_TOKEN_VAR]: '   ' })).toEqual({
      ok: false,
      reason: 'not_configured',
    })
  })
})

describe('readEvent', () => {
  const payment = (over: Record<string, unknown> = {}) => ({
    id: 'evt_1',
    event: 'payment_confirmed',
    payment: { id: 'pay_1', subscription: 'sub_1', value: 57, ...over },
  })

  it('reads the envelope and uppercases the event name', () => {
    const event = readEvent(payment())
    expect(event?.id).toBe('evt_1')
    expect(event?.event).toBe('PAYMENT_CONFIRMED')
    expect(event?.paymentId).toBe('pay_1')
    expect(event?.subscriptionId).toBe('sub_1')
  })

  it('keeps the body verbatim, extra attributes and all', () => {
    // Asaas's own docs warn in bold that new attributes appear without a
    // version bump and that throwing while parsing one can interrupt the
    // delivery queue.
    const body = { ...payment(), somethingNew: { deeply: ['nested'] } }
    expect(readEvent(body)?.body).toEqual(body)
  })

  it('reads a subscription event, where the id is on the subscription', () => {
    const event = readEvent({
      id: 'evt_2',
      event: 'SUBSCRIPTION_DELETED',
      subscription: { id: 'sub_9' },
    })
    expect(event?.subscriptionId).toBe('sub_9')
    expect(event?.paymentId).toBeNull()
  })

  it('refuses a body with no id or no event', () => {
    expect(readEvent({ event: 'PAYMENT_CONFIRMED' })).toBeNull()
    expect(readEvent({ id: 'evt_1' })).toBeNull()
    expect(readEvent(null)).toBeNull()
    expect(readEvent([{ id: 'evt_1', event: 'X' }])).toBeNull()
  })

  it('refuses an id long enough to be an attack on a primary key', () => {
    const long = 'e'.repeat(MAX_EVENT_ID_LENGTH + 1)
    expect(readEvent({ id: long, event: 'PAYMENT_CONFIRMED' })).toBeNull()
  })

  it('accepts an event with neither a payment nor a subscription', () => {
    // Not an error: the route answers 200 and `applyEvent` records it as
    // ignored. Refusing it here would be the same outcome by a worse route.
    expect(readEvent({ id: 'evt_3', event: 'PAYMENT_CONFIRMED' })?.subscriptionId).toBeNull()
  })
})

describe('effectOf', () => {
  it('grants on the three statuses that mean the money is ours', () => {
    expect(effectOf('PAYMENT_CONFIRMED')).toBe('grant')
    expect(effectOf('PAYMENT_RECEIVED')).toBe('grant')
    expect(effectOf('PAYMENT_RECEIVED_IN_CASH')).toBe('grant')
  })

  /**
   * **Chargebacks revoke, which the parked draft got wrong.** It listed
   * `CHARGEBACK_REQUESTED` and `CHARGEBACK_DISPUTE` among the revoking
   * *statuses* and then listed neither among the *events* it handled — so a
   * charged-back account kept its paid plan and two constants were dead. A
   * status vocabulary and an event vocabulary are two lists, and only one of
   * them arrives in the webhook.
   */
  it('revokes on a full refund, a chargeback and a deleted charge', () => {
    for (const event of [
      'PAYMENT_REFUNDED',
      'PAYMENT_CHARGEBACK_REQUESTED',
      'PAYMENT_CHARGEBACK_DISPUTE',
      'PAYMENT_RECEIVED_IN_CASH_UNDONE',
      'PAYMENT_DELETED',
    ]) {
      expect(effectOf(event), event).toBe('revoke')
    }
  })

  /**
   * **And two that must not revoke, both of which did.**
   *
   * `PAYMENT_PARTIALLY_REFUNDED` was in the revoking set and the revoke path
   * is unconditional, so a founder refunded the R$ 1,92 acquirer fee
   * `docs/product.json` describes would have lost the whole month.
   * `PAYMENT_AWAITING_CHARGEBACK_REVERSAL` is the news that the money is
   * coming **back to us**, and taking access away on it is backwards. Review
   * found both; the arithmetic that handles a partial refund properly, and the
   * re-grant after a completed reversal, are card **F13**.
   */
  it('records a partial refund and a chargeback reversal rather than revoking', () => {
    expect(effectOf('PAYMENT_PARTIALLY_REFUNDED')).toBe('record')
    expect(effectOf('PAYMENT_AWAITING_CHARGEBACK_REVERSAL')).toBe('record')
  })

  it('records an overdue charge without touching access', () => {
    // Terms §7's grace period starting, not a loss of access.
    expect(effectOf('PAYMENT_OVERDUE')).toBe('record')
    expect(effectOf('PAYMENT_CREATED')).toBe('record')
  })

  it('ends the subscription when Asaas says it is over', () => {
    expect(effectOf('SUBSCRIPTION_DELETED')).toBe('end')
    expect(effectOf('SUBSCRIPTION_INACTIVATED')).toBe('end')
  })

  it('ignores everything else rather than failing on it', () => {
    // An unknown event must not be a failed job: fifteen of those pause the
    // queue for fourteen days, after which Asaas deletes the events.
    expect(effectOf('PAYMENT_SOMETHING_ASAAS_ADDED_LAST_WEEK')).toBe('ignore')
    expect(effectOf('')).toBe('ignore')
  })

  it('never classifies a grant and a revocation as the same event', () => {
    // A sanity check on the three sets rather than on one name: an event in
    // two of them would make the effect depend on the order of the `if`s.
    const names = [
      'PAYMENT_CONFIRMED',
      'PAYMENT_RECEIVED',
      'PAYMENT_RECEIVED_IN_CASH',
      'PAYMENT_REFUNDED',
      'PAYMENT_RECEIVED_IN_CASH_UNDONE',
      'PAYMENT_OVERDUE',
      'SUBSCRIPTION_DELETED',
    ]
    const effects = names.map(effectOf)
    expect(new Set(effects).size).toBeGreaterThan(1)
    expect(effects.filter((e) => e === 'ignore')).toEqual([])
  })
})
