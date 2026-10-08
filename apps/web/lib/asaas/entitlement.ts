import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'
import { recordEvent } from '@/lib/events'
import { PROMO } from '@/lib/product'
import { type AsaasEvent, effectOf } from './webhook'

/**
 * What one Asaas webhook event does to the database — task **F2**.
 *
 * ## It trusts the body, and that is a decision with a reason
 *
 * The 2026-09-25 draft re-read every payment from Asaas before acting, which
 * is stronger. It is also an HTTP call inside a window Asaas gives us ten
 * seconds of, counts fifteen consecutive failures against, and then **pauses
 * the queue for fourteen days** — after which the events are deleted. An Asaas
 * outage would therefore cost us the record of payments that had already
 * happened, which is the one failure mode worse than a forged event.
 *
 * So this reads the body, and the forgery it has to survive is bounded by
 * where it writes: **nothing is granted for a subscription id this database
 * did not already store**, and the only thing that stores one is
 * `startCheckout`, after creating it at Asaas under our own API key. A caller
 * holding the webhook token can therefore replay, reorder or fabricate events
 * about *our* subscribers and cannot invent a subscriber. Re-reading from
 * Asaas on a schedule instead of in the request is card **F10**.
 *
 * ## One transaction, and the ordering that matters
 *
 * Everything below happens inside the caller's transaction. The draft ran the
 * grant as three autocommit statements in the order *activate → set plan →
 * claim*, so a failure between the claim and the rest burnt the claim
 * permanently: the retry read `already_entitled` and `promo_ends_on` stayed
 * null for ever. Here the claim is the **first** write of the grant and the
 * whole thing commits or none of it does, so a retry either finds the work
 * done or finds nothing done.
 *
 * ## Four layers of idempotency, each doing something the others cannot
 *
 * 1. `webhook_events.id` — the Asaas event id. The receiver inserts `on
 *    conflict do nothing`, so a redelivery is recognised before this runs.
 * 2. `webhook_events.processed_at` — read and written here, inside the
 *    transaction, so two concurrent deliveries of the same id cannot both act.
 * 3. `subscription_payments.asaas_payment_id` — one row per *payment*. One
 *    payment produces several events with different ids (Asaas documents
 *    CREATED → CONFIRMED → RECEIVED, with a card's RECEIVED ~32 days after
 *    CONFIRMED), so dedupe by event id cannot answer "has this payment already
 *    granted access?".
 * 4. `subscription_payments.entitled_at` — claimed by an `update … where
 *    entitled_at is null`, which takes a row lock and re-checks the predicate,
 *    so the second writer updates nothing.
 *
 * ## `next_charge_on` is Asaas's number, never a derivation
 *
 * It is recomputed after every payment write as *the earliest due date among
 * this subscription's charges that are not settled*. Asaas sends a
 * `PAYMENT_CREATED` with its own `dueDate` when it generates the next charge,
 * so that value is always something Asaas told us rather than
 * `last due date + 1 month`, which is what a monthly cycle looks like until a
 * due date lands on a holiday. The sentence it feeds —
 * `billing.status.nextCharge`, *"Próxima cobrança em {data}"* — and F4's
 * reminder both read this column, so a guess here would be a guess on screen
 * and a reminder on the wrong day.
 *
 * ## §12
 *
 * The body is already in `webhook_events.body` and is not copied anywhere
 * else. `events.props` gets a plan name and a status, never a URL, a name, a
 * document or an amount tied to a person.
 */

/** Asaas payment statuses that mean the money is ours. */
const SETTLED: readonly string[] = ['CONFIRMED', 'RECEIVED', 'RECEIVED_IN_CASH']

/**
 * `('CONFIRMED','RECEIVED',…)` for the one query that needs it as SQL.
 *
 * Built from {@link SETTLED} rather than typed a second time: the list was
 * duplicated in an earlier draft of this file and a duplicated vocabulary is
 * how `next_charge_on` ends up disagreeing with the grant that set it. Each
 * value is asserted to be an Asaas-shaped identifier, so `sql.raw` here cannot
 * interpolate anything else.
 */
function settledLiteral() {
  for (const status of SETTLED) {
    if (!/^[A-Z_]+$/.test(status)) throw new Error(`asaas: unsafe status literal ${status}`)
  }
  return sql.raw(`(${SETTLED.map((s) => `'${s}'`).join(',')})`)
}

export type Applied =
  /** Access granted by this payment, for the first time. */
  | { outcome: 'granted'; userId: number; plan: string | null }
  /** This payment had already granted access. Nothing changed. */
  | { outcome: 'already_entitled' }
  /** Access withdrawn: refund, chargeback or a deleted charge. */
  | { outcome: 'revoked'; userId: number }
  /** The subscription itself is over at Asaas. */
  | { outcome: 'ended'; userId: number }
  /** The payment was recorded; no change to access. */
  | { outcome: 'recorded' }
  /** This event id was already processed. */
  | { outcome: 'duplicate' }
  /** An event about a subscription we never created. Recorded, not acted on. */
  | { outcome: 'unknown_subscription' }
  /** An event we have no rule for, or one carrying no payment. */
  | { outcome: 'ignored'; reason: string }

type OwnerRow = { user_id: string | number; plan: string | null; status: string | null }

/**
 * Apply one event. Call inside a transaction; `database` is that transaction.
 *
 * Returns what happened, so the receiver can log a stable word and a test can
 * assert on behaviour rather than on the absence of an exception.
 */
export async function applyEvent(
  event: AsaasEvent,
  database: Executor = db(),
): Promise<Applied> {
  const already = await database.execute<{ processed_at: string | null }>(sql`
    select processed_at::text as processed_at
      from webhook_events
     where id = ${event.id}::text
       for update
  `)
  if (already.rows[0]?.processed_at) return { outcome: 'duplicate' }

  const effect = effectOf(event.event)
  if (effect === 'ignore') {
    await markProcessed(event.id, database)
    return { outcome: 'ignored', reason: 'unhandled_event' }
  }
  if (!event.subscriptionId) {
    await markProcessed(event.id, database)
    return { outcome: 'ignored', reason: 'no_subscription' }
  }

  const owner = await database.execute<OwnerRow>(sql`
    select user_id, plan, status
      from subscriptions
     where asaas_subscription_id = ${event.subscriptionId}::text
       for update
  `)
  const row = owner.rows[0]
  if (!row) {
    // Not ours. Recorded so a replay does not keep arriving, and deliberately
    // not an error: a webhook registered against the wrong account, or a
    // subscription created by hand in the Asaas console, must not fail the job
    // fifteen times and pause the queue.
    await markProcessed(event.id, database)
    return { outcome: 'unknown_subscription' }
  }
  const userId = Number(row.user_id)

  if (effect === 'end') {
    await endSubscription(event.subscriptionId, database)
    await recordEvent({ name: 'cancelled', userId, props: { source: 'asaas', event: event.event } },
      database)
    await markProcessed(event.id, database)
    return { outcome: 'ended', userId }
  }

  const payment = readPayment(event)
  if (!payment) {
    await markProcessed(event.id, database)
    return { outcome: 'ignored', reason: 'no_payment' }
  }

  await upsertPayment(
    { ...payment, asaasSubscriptionId: event.subscriptionId, userId },
    database,
  )

  if (effect === 'revoke') {
    const released = await database.execute<{ asaas_payment_id: string }>(sql`
      update subscription_payments
         set entitled_at = null,
             updated_at  = now()
       where asaas_payment_id = ${payment.asaasPaymentId}::text
         and entitled_at is not null
      returning asaas_payment_id
    `)
    // Access stops only when no *other* settled payment still entitles this
    // subscription. A partial refund of one month must not cancel a subscriber
    // who has since paid the next one.
    const stillEntitled = await database.execute<{ entitled: boolean }>(sql`
      select exists (
        select 1 from subscription_payments
         where asaas_subscription_id = ${event.subscriptionId}::text
           and entitled_at is not null
      ) as entitled
    `)
    if (!stillEntitled.rows[0]?.entitled) {
      await endSubscription(event.subscriptionId, database)
      await database.execute(sql`
        update users set plan = 'basico' where id = ${userId}::bigint and plan <> 'basico'
      `)
      await recordEvent(
        { name: 'cancelled', userId, props: { source: 'asaas', event: event.event } },
        database,
      )
    }
    await refreshNextCharge(event.subscriptionId, database)
    await markProcessed(event.id, database)
    return released.rows.length > 0
      ? { outcome: 'revoked', userId }
      : { outcome: 'recorded' }
  }

  if (effect === 'record') {
    // `PAYMENT_OVERDUE` is terms §7's grace period starting, not a loss of
    // access: the subscriber keeps the plan and the status says why. Terms §7
    // also names a **10-day suspension**, which nothing writes — card F4.
    if (event.event === 'PAYMENT_OVERDUE' && row.status === 'active') {
      await database.execute(sql`
        update subscriptions
           set status = 'overdue', updated_at = now()
         where asaas_subscription_id = ${event.subscriptionId}::text
      `)
    }
    await refreshNextCharge(event.subscriptionId, database)
    await markProcessed(event.id, database)
    return { outcome: 'recorded' }
  }

  // effect === 'grant'. Claim first: see "One transaction" above.
  const claimed = await database.execute<{ asaas_payment_id: string }>(sql`
    update subscription_payments
       set entitled_at = now(),
           updated_at  = now()
     where asaas_payment_id = ${payment.asaasPaymentId}::text
       and entitled_at is null
    returning asaas_payment_id
  `)
  if (claimed.rows.length === 0) {
    await markProcessed(event.id, database)
    return { outcome: 'already_entitled' }
  }

  await database.execute(sql`
    update subscriptions
       set status     = 'active',
           updated_at = now()
     where asaas_subscription_id = ${event.subscriptionId}::text
  `)

  /**
   * The promotional window starts at the **first** payment, and only once.
   *
   * `and promo_ends_on is null` is what makes it once: a second month's
   * payment must not push the price change a month further out, which would
   * make the promo last for ever. Computed in SQL from the payment date so the
   * month arithmetic is Postgres's, and read by F3 — which has to send the
   * 30-day notice **before** the value changes (terms §6.4).
   */
  if (row.plan === 'promocional') {
    await database.execute(sql`
      update subscriptions
         set promo_ends_on = (
               coalesce(
                 ${payment.paidOn}::date,
                 (now() at time zone 'America/Sao_Paulo')::date
               )
               + make_interval(months => ${promoMonths()})
             )::date,
             updated_at = now()
       where asaas_subscription_id = ${event.subscriptionId}::text
         and plan = 'promocional'
         and promo_ends_on is null
    `)
  }

  await database.execute(sql`
    update users
       set plan = ${row.plan}::text
     where id = ${userId}::bigint
       and plan <> ${row.plan}::text
  `)

  await refreshNextCharge(event.subscriptionId, database)
  await recordEvent(
    { name: 'subscription_active', userId, props: { plan: row.plan, event: event.event } },
    database,
  )
  await markProcessed(event.id, database)
  return { outcome: 'granted', userId, plan: row.plan }
}

/**
 * How many months the promotional price lasts.
 *
 * Read from `docs/product.json` through `lib/product.ts`, like every other
 * number in this tree — `product.test.ts` refuses a literal here.
 */
function promoMonths(): number {
  return PROMO.months
}

/**
 * `next_charge_on` = the earliest due date among this subscription's charges
 * that Asaas has not settled. See the module docstring for why it is never
 * computed from a cycle length.
 *
 * `coalesce` keeps the previous value when there is no unsettled charge yet:
 * the subscriber has paid and Asaas has not generated the next invoice, and
 * blanking the column would blank *"Próxima cobrança em {data}"* on a live
 * subscription.
 */
async function refreshNextCharge(subscriptionId: string, database: Executor): Promise<void> {
  await database.execute(sql`
    update subscriptions s
       set next_charge_on = coalesce(
             (select min(p.due_on)
                from subscription_payments p
               where p.asaas_subscription_id = s.asaas_subscription_id
                 and p.entitled_at is null
                 and upper(p.status) not in ${settledLiteral()}),
             s.next_charge_on
           ),
           updated_at = now()
     where s.asaas_subscription_id = ${subscriptionId}::text
  `)
}

/** Auto-renewal off, paid access to the end of the period already paid for. */
async function endSubscription(subscriptionId: string, database: Executor): Promise<void> {
  await database.execute(sql`
    update subscriptions
       set status     = 'canceled',
           ends_on    = coalesce(
                          ends_on,
                          next_charge_on - 1,
                          (now() at time zone 'America/Sao_Paulo')::date
                        ),
           updated_at = now()
     where asaas_subscription_id = ${subscriptionId}::text
  `)
}

async function markProcessed(eventId: string, database: Executor): Promise<void> {
  await database.execute(sql`
    update webhook_events set processed_at = now() where id = ${eventId}::text
  `)
}

type PaymentFacts = {
  asaasPaymentId: string
  status: string
  billingType: string | null
  value: number
  netValue: number | null
  dueOn: string | null
  paidOn: string | null
}

/**
 * The payment fields off the envelope, or `null` when the body does not carry
 * a usable one.
 *
 * `value` is required because `subscription_payments.value` is `not null` and
 * a charge with no amount is not a charge. Everything else may be absent:
 * Asaas's docs warn that payload attributes come and go without a version
 * bump, so a missing optional field must be a null column, never a throw —
 * a throw here would be a failed job, and fifteen of those pause the queue.
 */
function readPayment(event: AsaasEvent): PaymentFacts | null {
  const payment = event.body.payment
  if (typeof payment !== 'object' || payment === null || Array.isArray(payment)) return null
  const row = payment as Record<string, unknown>
  const id = typeof row.id === 'string' ? row.id.trim() : ''
  const value = asNumber(row.value)
  if (!id || value === null) return null
  const status = typeof row.status === 'string' ? row.status.trim().toUpperCase() : ''
  return {
    asaasPaymentId: id,
    // A status is required by the column. An event about a payment that does
    // not say what the payment is cannot be trusted to be one, so the event
    // name decides: a grant means settled, anything else is unknown.
    status:
      status || (SETTLED.includes(event.event.replace(/^PAYMENT_/, '')) ? 'CONFIRMED' : 'UNKNOWN'),
    billingType: typeof row.billingType === 'string' ? row.billingType : null,
    value,
    netValue: asNumber(row.netValue),
    dueOn: asDate(row.dueDate),
    paidOn: asDate(row.paymentDate) ?? asDate(row.clientPaymentDate) ?? asDate(row.confirmedDate),
  }
}

async function upsertPayment(
  input: PaymentFacts & { asaasSubscriptionId: string; userId: number },
  database: Executor,
): Promise<void> {
  await database.execute(sql`
    insert into subscription_payments (
      asaas_payment_id, asaas_subscription_id, user_id,
      status, billing_type, value, net_value, due_on, paid_on, updated_at
    )
    values (
      ${input.asaasPaymentId}::text,
      ${input.asaasSubscriptionId}::text,
      ${input.userId}::bigint,
      ${input.status}::text,
      ${input.billingType}::text,
      ${input.value.toFixed(2)}::numeric,
      ${input.netValue === null ? null : input.netValue.toFixed(2)}::numeric,
      ${input.dueOn}::date,
      ${input.paidOn}::date,
      now()
    )
    on conflict (asaas_payment_id) do update
       set status       = excluded.status,
           billing_type = coalesce(excluded.billing_type, subscription_payments.billing_type),
           value        = excluded.value,
           net_value    = coalesce(excluded.net_value, subscription_payments.net_value),
           due_on       = coalesce(excluded.due_on, subscription_payments.due_on),
           paid_on      = coalesce(excluded.paid_on, subscription_payments.paid_on),
           updated_at   = now()
  `)
}

function asDate(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
