import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'
import { recordEvent } from '@/lib/events'
import { PROMO } from '@/lib/product'
import { AsaasClient, AsaasError, DRY_RUN, externalReference } from './client'
import { safeInvoiceUrl } from './config'
import { lastPaidDay, liveStatusLiteral, SUBSCRIPTION_STATUS } from './subscription'
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
 * {@link syncNextChargeFromAsaas} is the one Asaas read in this file, and it
 * gives up neither half of that argument: it is not part of `applyEvent`, it
 * runs after the transaction has committed, and it cannot fail a delivery.
 * Its docstring carries the whole reason it has to exist.
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
 * ## Three layers of idempotency, and one belt
 *
 * Counted honestly, because review counted it and found four claimed:
 *
 * 1. `webhook_events.id` — the Asaas event id. The receiver inserts `on
 *    conflict do nothing`, so a redelivery is recognised before this runs, and
 *    the unique index is also what serialises two concurrent deliveries.
 * 2. `webhook_events.processed_at` — read `for update` here. **Unreachable
 *    from the receiver today**, because the route only calls this when its own
 *    insert created the row, so `processed_at` is always null. It is a belt for
 *    the second caller this function is going to get (**F10**'s sweep over
 *    rows left unprocessed), together with the throw below for a caller that
 *    forgets to persist. Not counted as a layer that is doing work.
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
 * **There is a window in which no charge of ours can answer**, and until F22
 * it was answered with the charge that had just been paid: Asaas advances the
 * subscription a cycle when it generates a charge, so between the first
 * payment and month 2's `PAYMENT_CREATED` the subscription's own `nextDueDate`
 * is the only number that is true. {@link syncNextChargeFromAsaas} reads it,
 * as a fallback and never as an override.
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
 * Asaas payment statuses that mean *"somebody still has to pay this"*.
 *
 * An **allow-list**, deliberately, and the opposite choice from
 * `subscription_payments.status` having no CHECK. There, a status we do not
 * recognise must still be storable, because it describes a payment that really
 * happened. Here, a status we do not recognise must **not** become "the next
 * charge": `next_charge_on` feeds a sentence a subscriber reads and a reminder
 * the contract owes them, and the safe failure is to leave the column alone
 * rather than to point it at a charge nobody owes.
 *
 * `OVERDUE` is in the list and the `due_on >= today` filter is what keeps a
 * past-due charge out — the subscriber owes it, but it is not *next*.
 *
 * `AUTHORIZED` (a pre-authorised card charge) is deliberately **absent**: the
 * money is committed and not captured, so it is neither settled nor waiting to
 * be paid, and the safe answer is to leave `next_charge_on` and the checkout
 * link on their previous values rather than to point either at it. That is the
 * allow-list failing safe, which is the whole reason it is one.
 */
export const AWAITING: readonly string[] = [
  'PENDING',
  'OVERDUE',
  'AWAITING_RISK_ANALYSIS',
  'APPROVED_BY_RISK_ANALYSIS',
]

/**
 * `('CONFIRMED','RECEIVED',…)` for the queries that need a list as SQL.
 *
 * Built from the constants rather than typed a second time: the settled list
 * was duplicated in an earlier draft and a duplicated vocabulary is how
 * `next_charge_on` ends up disagreeing with the grant that set it. Each value
 * is asserted to be an Asaas-shaped identifier, so `sql.raw` cannot
 * interpolate anything else.
 */
function statusList(statuses: readonly string[]) {
  for (const status of statuses) {
    if (!/^[A-Z_]+$/.test(status)) throw new Error(`asaas: unsafe status literal ${status}`)
  }
  return sql.raw(`(${statuses.map((s) => `'${s}'`).join(',')})`)
}

const settledLiteral = () => statusList(SETTLED)
const awaitingLiteral = () => statusList(AWAITING)

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
  /**
   * A payment settled for a subscription while **another** row of the same
   * account is live. The payment is recorded and the plan granted; which row
   * is `active` is left alone. See the grant path for why. Card F10.
   */
  | { outcome: 'stale_subscription'; userId: number }
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
  /**
   * **The envelope must already be stored.** Every caller persists it first —
   * `POST /api/asaas/webhook` does it in the same transaction — and without
   * that row `markProcessed` below updates zero rows silently, so a caller
   * that forgot would lose both idempotency layers with no symptom. Named by
   * review as latent today and a trap for F10's reconcile, which is the next
   * caller this function will get.
   */
  if (already.rows.length === 0) {
    throw new Error(`asaas: applyEvent called for an unpersisted event ${event.id}`)
  }
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

  await upsertPayment({ ...payment, asaasSubscriptionId: event.subscriptionId, userId }, database)
  await refreshCheckoutUrl(event.subscriptionId, payment, database)

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
    let ended = false
    if (!stillEntitled.rows[0]?.entitled) {
      await clearNextCharge(event.subscriptionId, database)
      await endSubscription(event.subscriptionId, database)
      await database.execute(sql`
        update users set plan = 'basico' where id = ${userId}::bigint and plan <> 'basico'
      `)
      await recordEvent(
        { name: 'cancelled', userId, props: { source: 'asaas', event: event.event } },
        database,
      )
      ended = true
    }
    await refreshNextCharge(event.subscriptionId, database)
    await markProcessed(event.id, database)
    /**
     * `revoked` when access actually moved, which is **either** of two things.
     *
     * The first version reported on `released` alone, so a refund of a payment
     * we never recorded as entitling — the grant event lost, the refund
     * arriving — took the plan away and logged `recorded`. A log line that
     * says less than what happened is the thing somebody reads at 2 a.m.
     */
    return released.rows.length > 0 || ended
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

  /**
   * **`status = 'active'` only while no *other* row of this account is live.**
   *
   * `0015`'s partial unique index on `(user_id) where status in (…)` forbids
   * two live rows, and this update could violate it: cancel mid-cycle with a
   * boleto outstanding (our row → `canceled`), subscribe again (second row →
   * `pending`), then the old boleto is paid. `entitled_at` is still null so
   * the claim succeeds, and the flip to `active` raises `23505` — which the
   * route turns into a **500**, which Asaas retries, which fails identically,
   * fifteen times, and then the delivery queue is paused and the events are
   * deleted at fourteen days. The one outcome this whole file is written to
   * avoid, reached by an index the same PR added. Found by review.
   *
   * So the predicate makes it impossible instead of catching it. The payment
   * is recorded and the claim stands — the money arrived and the ledger says
   * so — but neither this row's status nor `users.plan` is touched, because
   * the account's **live** subscription is what governs its plan, and deciding
   * otherwise from a unique violation would mean ending a subscription
   * somebody may still be paying.
   * The skipped case is logged, loudly, and `stale_subscription` comes back as
   * the outcome so the route's log line names it. Card **F10** reconciles it.
   *
   * ## A payment that settles after a cancel buys a month; it does not undo the
   * cancel
   *
   * The `case` is the second half of that same scenario, in its **one-row**
   * variant — cancel mid-cycle with a boleto outstanding, then the boleto is
   * paid, and no second subscription exists. Until 2026-10-09 the flip to
   * `active` had no predicate on `s.status`, so a `canceled` row went straight
   * back to `active`: auto-renewal is off at Asaas, `expire_subscriptions` no
   * longer matches the row (it requires `canceled`), and the account kept the
   * paid plan **for ever**, never charged again and — because of the
   * `ends_on is null` clause in F4's `DUE_SQL` — never reminded either.
   *
   * Granting the month the boleto bought is right. Claiming a live
   * subscription is not. So a cancelled row stays `canceled` and its
   * {@link lastPaidDay} moves out to cover the charge that just settled, which
   * is exactly the machinery that already exists: `users.plan` is granted
   * below, and `expire_subscriptions` reclaims it the morning after the month
   * runs out. Nothing new had to be built for it.
   *
   * ## `ends_on = null` on a genuine activation
   *
   * A row that is becoming `active` must have no `ends_on` left on it. A
   * subscription that was ended and then restored by the next month's payment
   * kept its old date, and F4's `charge_reminder` selects
   * `where s.ends_on is null` — so that account was charged every month and
   * was **permanently invisible** to the 3-day reminder, with the sweep
   * logging `due = 0` and looking healthy. A clause of the contract (terms §7)
   * failing silently, which is the shape this file keeps finding.
   */
  const activated = await database.execute<{ asaas_subscription_id: string; status: string }>(sql`
    update subscriptions s
       set status     = case when s.status = ${SUBSCRIPTION_STATUS.canceled}::text
                               then s.status else 'active' end,
           ends_on    = case when s.status = ${SUBSCRIPTION_STATUS.canceled}::text
                               then ${lastPaidDay('s')} else null end,
           updated_at = now()
     where s.asaas_subscription_id = ${event.subscriptionId}::text
       and not exists (
         select 1 from subscriptions other
          where other.user_id = s.user_id
            and other.asaas_subscription_id <> s.asaas_subscription_id
            and other.status = any(${liveStatusLiteral()})
       )
    returning s.asaas_subscription_id, s.status
  `)
  if (activated.rows.length === 0) {
    console.error(
      'billing: a payment settled for a subscription while another is live for the same account',
    )
  }
  /** True only where the row is now genuinely live, which the event must mean. */
  const isActive = activated.rows[0]?.status === 'active'
  if (activated.rows.length > 0 && !isActive) {
    console.info('billing: a payment settled for a cancelled subscription; the month it bought is honoured')
  }

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
                 -- **The charge's due date, not the day it was paid.** A
                 -- founder who pays the 17/10 boleto on 25/10 would otherwise
                 -- get promo_ends_on = 25/01, while the fourth charge falls
                 -- due 17/01 — so F3 would let one cycle through at the
                 -- promotional price. The due date is the billing cycle; the
                 -- payment date is when the money moved. Found by review.
                 ${payment.dueOn}::date,
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

  /**
   * The plan follows the row that is `active`, so a stale row grants nothing.
   *
   * The comment above said the plan would be "the same plan either way"; it is
   * an assumption and not always true — a seat revoked between a cancel and a
   * re-subscribe flips `promocional` to `essencial`, and writing the stale
   * row's plan would then downgrade a live subscriber. The live subscription
   * governs `users.plan`, which is what `stale_subscription` means.
   */
  if (activated.rows.length > 0) {
    await database.execute(sql`
      update users
         set plan = ${row.plan}::text
       where id = ${userId}::bigint
         and plan <> ${row.plan}::text
    `)
  }

  await refreshNextCharge(event.subscriptionId, database)
  // §14's gate metric, and `lib/admin/gates.ts` counts a paid founder seat off
  // `subscriptions.status`, so this must mean the same thing the column does:
  // fired only where the row actually became `active`. A cancelled row whose
  // last boleto settled is **not** that, however much money arrived — the
  // column says `canceled` and so must the metric.
  if (isActive) {
    await recordEvent(
      { name: 'subscription_active', userId, props: { plan: row.plan, event: event.event } },
      database,
    )
  }
  await markProcessed(event.id, database)
  return activated.rows.length > 0
    ? { outcome: 'granted', userId, plan: row.plan }
    : { outcome: 'stale_subscription', userId }
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
 *
 * **That previous value is the charge that was just paid, which is the whole
 * of F22.** The window this opens is not a corner: it is every subscriber
 * between their first payment and Asaas generating month 2, and inside it the
 * screen reads *"Próxima cobrança em 10/10/2026"* to somebody who paid on
 * 10/10. {@link syncNextChargeFromAsaas} closes it by asking Asaas for the
 * subscription's own `nextDueDate` — the only authority for a date no charge
 * of ours carries yet — and it is deliberately the *fallback* and not the
 * answer: see that function's docstring for why overwriting a known unsettled
 * charge with it would skip a month.
 */
async function refreshNextCharge(subscriptionId: string, database: Executor): Promise<void> {
  await database.execute(sql`
    update subscriptions s
       set next_charge_on = coalesce(
             (select min(p.due_on)
                from subscription_payments p
               where p.asaas_subscription_id = s.asaas_subscription_id
                 and p.entitled_at is null
                 -- **An allow-list, not "anything unsettled".** The first
                 -- version excluded only the settled statuses, so a REFUNDED
                 -- or DELETED charge — whose entitled_at the revoke path has
                 -- just nulled — walked back into the set and dragged
                 -- next_charge_on to a date in the **past**. Three readers
                 -- then went wrong at once: the screen printed "Proxima
                 -- cobranca" for a day that had gone, cancelSubscription
                 -- computed ends_on from it, and the worker reminder matches
                 -- next_charge_on = today + 3 by exact equality, so a stale
                 -- value meant the charge arrived with **no warning** and the
                 -- sweep logged zero due, looking healthy. Found by review. A
                 -- status we do not recognise is not a charge somebody owes.
                 and upper(p.status) in ${awaitingLiteral()}
                 -- And never in the past, for the same reason.
                 and p.due_on >= (now() at time zone 'America/Sao_Paulo')::date),
             s.next_charge_on
           ),
           updated_at = now()
     where s.asaas_subscription_id = ${subscriptionId}::text
  `)
}

/**
 * **A subscription that has just lost its last entitling payment has no next
 * charge — and `ends_on` is about to be computed from this column.**
 *
 * Found by review, as a regression F22 introduced rather than an old defect.
 * {@link lastPaidDay} takes `greatest(ends_on, next_charge_on - 1, max entitled
 * due date + 1 month - 1 day, today)`. The revoke path nulls `entitled_at`
 * first, which kills the third candidate; before F22 the second one was
 * *yesterday* (the column held the charge that had just been paid), so the
 * floor answered `today`. With `next_charge_on` finally pointing a month
 * ahead, that second candidate would hand a **refunded or charged-back**
 * subscriber `ends_on` a month out, and `plan-view.tsx` would read them
 * *"Você continua com o plano pago até 09/11/2026"* on a screen whose header
 * says Básico — a false contractual sentence, which is F20's category widened
 * from one day to one month. The two refund cases in `billing.db.test.ts`
 * asserted only that the plan had dropped, so the suite stayed green.
 *
 * The column is cleared **before** {@link endSubscription} reads it, and
 * `refreshNextCharge` runs a few lines later: a charge that really is
 * scheduled and unpaid comes straight back (`keeps next_charge_on out of the
 * past after a refund` proves it). What does not come back is a date standing
 * for a month nobody paid for.
 *
 * **The better fix is not here**, and it is not F22's to make: the second
 * candidate of `lastPaidDay` should require an entitled payment to exist at
 * all, which would also answer the case `cancelling (database)` currently
 * asserts as correct — a subscription created with a future `nextDueDate` and
 * **never paid** is cancelled into `ends_on = nextDueDate - 1`. That is F20,
 * whose card is open and whose acceptance criterion is exactly that sentence.
 * Changing the shared expression here would take F20's decision for it.
 */
async function clearNextCharge(subscriptionId: string, database: Executor): Promise<void> {
  await database.execute(sql`
    update subscriptions
       set next_charge_on = null,
           updated_at     = now()
     where asaas_subscription_id = ${subscriptionId}::text
  `)
}

/**
 * How long this one Asaas read may take — **F22**, and the number matters.
 *
 * {@link DEFAULT_TIMEOUT_MS} is 15 s, which is longer than the 10 s Asaas
 * allows the whole webhook response, so the default client could blow the
 * delivery window on its own and spend one of the fifteen strikes that pause
 * the queue. This is the ceiling that keeps the refresh inside the budget with
 * room for the grant that has already committed.
 */
export const NEXT_CHARGE_TIMEOUT_MS = 3_000

/** What {@link syncNextChargeFromAsaas} did. Every word is a fixed enum. */
export type NextChargeSync =
  /** A charge we already know about is next. Asaas was not called. */
  | { outcome: 'local' }
  /** `next_charge_on` moved to Asaas's `nextDueDate`. */
  | { outcome: 'updated' }
  /** Asaas's `nextDueDate` is what we already hold. */
  | { outcome: 'unchanged' }
  /** Nothing to do, and no reason to call Asaas. */
  | {
      outcome: 'skipped'
      reason: 'no_live_subscription' | 'not_live' | 'config'
        | 'not_at_asaas' | 'no_next_due_date' | 'in_the_past' | 'raced'
    }
  /** Asaas or the database refused. The column keeps the value it had. */
  | { outcome: 'failed'; reason: string }

type SyncRow = {
  user_id: string | number
  next_charge_on: string | null
  today_brt: string
  awaiting: string | null
}

/**
 * **Point `next_charge_on` at Asaas's `nextDueDate` when no charge of ours can
 * answer — task F22.**
 *
 * ## The defect, measured rather than reasoned about
 *
 * Measured in the sandbox on 2026-10-10: our row held
 * `next_charge_on = 2026-10-10`, the day the first payment was received, while
 * `GET /v3/subscriptions` for the same subscription returned
 * `nextDueDate: 2026-11-10`. The plan screen renders ours faithfully, so a
 * founder who had just paid was told they were about to be charged again — and
 * `worker/licitaqui/billing.py` binds the 3-day reminder's `data_cobranca`
 * from the same column, which terms §7 requires to state *"a data e o valor que
 * será cobrado"*. A column this wrong is a contractual notice that is wrong.
 *
 * The mechanism, measured the same day: a subscription POSTed with
 * `nextDueDate: 2026-10-11` came back holding `nextDueDate: 2026-11-11` —
 * **Asaas advances the subscription a whole cycle the moment it generates the
 * first charge**, and it is the *charge* that keeps the date we asked for
 * (`dueDate: 2026-10-11`). So between the first payment and the
 * `PAYMENT_CREATED` for month 2 there is no charge of ours whose due date is
 * in the future, {@link refreshNextCharge}'s `coalesce` keeps the one that was
 * just settled, and the only thing in the world that knows the real answer is
 * the Asaas subscription.
 *
 * ## It is the fallback, never the answer
 *
 * Asaas's `nextDueDate` is *"the next charge Asaas will generate"*, which is
 * **not** *"the next charge this subscriber owes"*. Once month 2 exists it has
 * already advanced to month 3, so writing it unconditionally would skip a
 * month: the screen would name December while November went unpaid, and the
 * reminder — which matches `next_charge_on = today + 3` by exact equality —
 * would never fire for the charge it was owed on. So this runs **only when
 * this subscription has no unsettled charge at all**, read in one statement
 * before anything is asked of Asaas. That pre-check is also what keeps the
 * HTTP call to roughly once a cycle instead of once an event.
 *
 * **The pre-check is {@link AWAITING} with no date filter, and the missing
 * filter is the point.** `refreshNextCharge` asks *"which charge is next"* and
 * excludes a past-due one because a charge that is late is owed but not next.
 * This asks the opposite question — *"may Asaas's forward date be written
 * here?"* — and a past-due charge is exactly when the answer is no. Review
 * found the first version sharing `refreshNextCharge`'s expression verbatim,
 * where a NULL means *leave the column alone* (safe) while here it means
 * *overwrite it from Asaas* (unsafe): one `OVERDUE` month-2 charge plus the
 * late `PAYMENT_RECEIVED` a card sends ~32 days after its `PAYMENT_CONFIRMED`
 * would have moved the column to month 3, and the one charge the subscriber
 * actually owed would have arrived with no notice at all.
 *
 * A status **outside** that allow-list still does not block, and that is
 * deliberate for the reason the list exists: a `REFUNDED` or `DELETED` charge
 * keeps `entitled_at is null` for ever, so blocking on *"anything unsettled"*
 * would freeze this column permanently for every subscription that has ever
 * been refunded. `AUTHORIZED` — money committed, not captured — is nobody's
 * debt either.
 *
 * ## Why the call is here and not in {@link applyEvent}
 *
 * `applyEvent` makes no Asaas call and must not start: it runs inside the
 * caller's transaction holding `for update` on this subscription's row, and
 * the module docstring's *"it trusts the body"* argument is that an Asaas
 * outage must never cost us the record of a payment that already happened.
 * Neither property is given up here. This runs **after** that transaction has
 * committed, takes no lock, cannot fail the grant, and **never throws**: an
 * Asaas refusal, a dry-run client or a database error all leave the column
 * exactly as it was, log one enum word and answer `failed`. The subscriber is
 * then no worse off than before this function existed — the stale value stands
 * until month 2's `PAYMENT_CREATED` arrives or F10's reconcile runs.
 *
 * What it costs the delivery is **one Asaas call bounded at
 * {@link NEXT_CHARGE_TIMEOUT_MS} plus two un-timed Neon round trips**, and
 * only on a grant whose subscription has no unsettled charge. That is well
 * inside Asaas's ten seconds in every case measured here and is **not** a
 * proof: a cold Neon compute is not bounded by anything this file controls.
 * The reason it is acceptable anyway is that the money is already recorded and
 * committed — a delivery lost here costs a *date*, which F10's reconcile is
 * the retry for, and not a payment.
 *
 * `findSubscription` and not `GET /v3/subscriptions/{id}`: the list-by-
 * `externalReference` endpoint is the one this codebase has actually exercised
 * against the sandbox, and a single-subscription GET would be API surface
 * inferred from the documentation rather than measured (CLAUDE.md §4d). The id
 * it returns is checked against ours, so the extra breadth costs nothing: a
 * subscription deleted in the Asaas console and replaced by hand answers
 * `not_at_asaas` instead of moving our date to a stranger's.
 *
 * §12: the subscription id is ours, not personal data; the **date is not
 * logged**, because it belongs to one named subscriber's billing.
 */
export async function syncNextChargeFromAsaas(
  subscriptionId: string,
  options: { client?: AsaasClient } = {},
): Promise<NextChargeSync> {
  /**
   * **The pool, and there is no parameter for anything else.** An `Executor`
   * option was written here and nothing ever passed one — and the only value
   * worth passing would have been a transaction, which is the single thing
   * this function must never be given: it would put the Asaas call back inside
   * the `for update` the whole design exists to stay out of. Named by review
   * as `radar.opportunity.screeningCost`'s shape — written, typed, never
   * passed — so it is gone rather than documented.
   */
  const database = db()
  try {
    const found = await database.execute<SyncRow>(sql`
      select s.user_id,
             s.next_charge_on::text as next_charge_on,
             (now() at time zone 'America/Sao_Paulo')::date::text as today_brt,
             (select min(p.due_on)::text
                from subscription_payments p
               where p.asaas_subscription_id = s.asaas_subscription_id
                 and p.entitled_at is null
                 and upper(p.status) in ${awaitingLiteral()})
               as awaiting
        from subscriptions s
       where s.asaas_subscription_id = ${subscriptionId}::text
         -- A cancelled row has no next charge, and ends_on is already
         -- written: moving this column would spend an Asaas call to change a
         -- date nothing reads.
         and s.status = any(${liveStatusLiteral()})
    `)
    const row = found.rows[0]
    if (!row) return { outcome: 'skipped', reason: 'no_live_subscription' }
    // A charge somebody still owes is the better authority, whether it is
    // ahead of today or late. See "It is the fallback, never the answer".
    if (row.awaiting !== null) return { outcome: 'local' }

    const client = options.client ?? new AsaasClient({ timeoutMs: NEXT_CHARGE_TIMEOUT_MS })
    if (!client.live) return { outcome: 'skipped', reason: 'not_live' }
    if (client.fault) return { outcome: 'skipped', reason: 'config' }

    const at = await client.findSubscription(externalReference(Number(row.user_id)))
    // Unreachable by construction — `request` answers `DRY_RUN` only when the
    // client is not live, which the guard above already returned on — and kept
    // because the type says it can happen. It is **not** its own reason: an
    // enum value nothing can emit is `locked_block_clicked`'s shape.
    if (at === DRY_RUN) return { outcome: 'skipped', reason: 'not_live' }
    if (at === null || at.id !== subscriptionId) {
      return { outcome: 'skipped', reason: 'not_at_asaas' }
    }
    const nextDueDate = at.nextDueDate
    if (nextDueDate === null) return { outcome: 'skipped', reason: 'no_next_due_date' }
    /*
     * `YYYY-MM-DD` against `YYYY-MM-DD`, both of them dates and not instants:
     * Asaas sends a plain calendar day, `today_brt` comes from the database in
     * the product's clock, and comparing either one against a JavaScript
     * `Date` on this process's clock is the mistake CLAUDE.md's "Clocks"
     * section is about. Lexicographic order is calendar order in this shape.
     *
     * `>= today` and not `> today`: a charge Asaas will generate for today is
     * a real next charge, and the subscriber reading the screen is the one who
     * has to know about it.
     */
    if (nextDueDate < row.today_brt) return { outcome: 'skipped', reason: 'in_the_past' }
    if (nextDueDate === row.next_charge_on) return { outcome: 'unchanged' }

    /**
     * **Compare and set, because the guard was read before an HTTP call.**
     *
     * Up to three seconds pass at Asaas between the pre-check and this write,
     * nothing is locked (deliberately — a lock across that call is what this
     * whole design avoids), and a `PAYMENT_CREATED` committing in the window
     * writes the *correct* month-2 date through `refreshNextCharge`. A bare
     * `update` would then overwrite it with Asaas's already-advanced one —
     * finding 3 of the review, the same harm as skipping a month, by a race
     * instead of by a missing filter. So the `where` re-states every
     * precondition: the row still holds the value we read, it is still live,
     * and it still has no unsettled charge. Zero rows is `raced`, not
     * `updated`.
     */
    const written = await database.execute<{ asaas_subscription_id: string }>(sql`
      update subscriptions s
         set next_charge_on = ${nextDueDate}::date,
             updated_at     = now()
       where s.asaas_subscription_id = ${subscriptionId}::text
         and s.status = any(${liveStatusLiteral()})
         and s.next_charge_on is not distinct from ${row.next_charge_on}::date
         and not exists (
           select 1 from subscription_payments p
            where p.asaas_subscription_id = s.asaas_subscription_id
              and p.entitled_at is null
              and upper(p.status) in ${awaitingLiteral()}
         )
      returning s.asaas_subscription_id
    `)
    if (written.rows.length === 0) return { outcome: 'skipped', reason: 'raced' }
    return { outcome: 'updated' }
  } catch (error) {
    // An `AsaasFailure` is a fixed vocabulary and a Postgres `code` is five
    // characters: both safe to log, unlike a message, which can echo a value
    // back (§12).
    const reason =
      error instanceof AsaasError ? error.reason
      : ((error as { code?: string } | null)?.code ?? 'unknown')
    console.error(`billing: next charge not refreshed (${reason})`)
    return { outcome: 'failed', reason }
  }
}

/**
 * Auto-renewal off, paid access to the end of the period already paid for.
 *
 * The date is {@link lastPaidDay}, which is `cancelSubscription`'s expression
 * and no longer a second copy of it. This function used to hold
 * `coalesce(ends_on, next_charge_on - 1, today)` — the two-line version review
 * had already corrected in `cancelSubscription` — and so set `ends_on` to
 * **yesterday** for any subscription ended in its first month, which is every
 * subscription a founder cancels or an operator inactivates in the Asaas
 * console before Asaas has generated month 2.
 */
async function endSubscription(subscriptionId: string, database: Executor): Promise<void> {
  await database.execute(sql`
    update subscriptions s
       set status     = 'canceled',
           ends_on    = ${lastPaidDay('s')},
           updated_at = now()
     where s.asaas_subscription_id = ${subscriptionId}::text
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
  /** The hosted invoice page for this charge. See {@link refreshCheckoutUrl}. */
  invoiceUrl: string | null
}

/**
 * **Point `subscriptions.checkout_url` at the charge that is actually payable.**
 *
 * It used to be written once, by `startCheckout`, and never again — so the
 * plan screen's *"Ir para o pagamento"* for a `pending` or `overdue`
 * subscription handed back the **month-1 invoice**, long settled or expired
 * and regenerated by Asaas. A subscriber who went overdue in month 3 — exactly
 * the state terms §7's grace period is about — had a dead link and no way to
 * pay before suspension. Found by review, which also noted that
 * `plan-view.test.tsx` asserted the dead link as correct behaviour.
 *
 * Every Asaas payment payload carries `invoiceUrl`, so the fix is to follow
 * it — for a charge somebody can actually pay. That is {@link AWAITING}, the
 * same allow-list `next_charge_on` uses and for the same reason: a settled
 * invoice is a receipt, and a **refunded or deleted** one is nothing at all.
 * The first version of this guard was "not settled", which would have pointed
 * the pay-now button at a refunded charge.
 *
 * The value is checked against Asaas's own domain before it is stored — see
 * {@link safeInvoiceUrl}. It arrives in a webhook body, and the column it
 * lands in is redirected to and rendered as a payment link, so "Asaas sent it"
 * is not on its own a reason to point a subscriber's browser at it.
 *
 * §12: never logged. It opens one named customer's invoice.
 */
async function refreshCheckoutUrl(
  subscriptionId: string,
  payment: PaymentFacts,
  database: Executor,
): Promise<void> {
  if (!AWAITING.includes(payment.status)) return
  const invoiceUrl = safeInvoiceUrl(payment.invoiceUrl)
  if (!invoiceUrl) {
    // Not logged with the value: §12, and a rejected URL is attacker-chosen
    // text. The status is a fixed vocabulary and safe to name.
    if (payment.invoiceUrl) console.error('billing: refusing a checkout URL that is not an Asaas invoice')
    return
  }
  await database.execute(sql`
    update subscriptions
       set checkout_url = ${invoiceUrl}::text,
           updated_at   = now()
     where asaas_subscription_id = ${subscriptionId}::text
  `)
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
    invoiceUrl: typeof row.invoiceUrl === 'string' && row.invoiceUrl ? row.invoiceUrl : null,
  }
}

async function upsertPayment(
  input: PaymentFacts & { asaasSubscriptionId: string; userId: number },
  database: Executor,
): Promise<void> {
  await database.execute(sql`
    insert into subscription_payments (
      -- user_id is written here and read by nothing. Card F15 removes it; the
      -- note in 0015_billing_asaas.sql says why it is still here.
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
       -- **Forward only.** Asaas does not guarantee webhook ordering, and a
       -- PAYMENT_CREATED arriving after PAYMENT_CONFIRMED carries a different
       -- event id, so layer 1 does not dedupe it. Overwriting unconditionally
       -- rewrote a settled charge back to PENDING: entitled_at survived so
       -- access was safe, but the screen's last-payment line and the
       -- value/net_value ledger both went wrong, and the row re-entered
       -- refreshNextCharge's set. Found by review.
       set status       = case
                            when upper(subscription_payments.status) in ${settledLiteral()}
                             and upper(excluded.status) not in ${settledLiteral()}
                            then subscription_payments.status
                            else excluded.status
                          end,
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
