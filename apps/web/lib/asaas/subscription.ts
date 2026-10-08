import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'

/**
 * Reading and writing the `subscriptions` row — task **F2**.
 *
 * This module makes no Asaas call: `lib/asaas/client.ts` is the only thing
 * that does. What it does is own the one row per account that says what is
 * being charged, and the vocabulary of its `status` column.
 *
 * ## The status vocabulary is ours, not Asaas's
 *
 * An Asaas subscription is `ACTIVE` from the moment it is created, before
 * anybody has paid. `lib/admin/gates.ts` counts a **paid** founder seat off
 * this column, so storing Asaas's own word there would make the Gate 0
 * dashboard count unpaid signups. `pending` is a subscription that exists and
 * has not been paid; `active` is one that has. `0015_billing_asaas.sql` holds
 * the column to the five values with a CHECK, so a sixth cannot appear
 * quietly and fall out of the partial unique index that stops double charges.
 *
 * ## Degrading when migration 0015 has not been applied
 *
 * `db/migrations/0015_billing_asaas.sql` is its own PR, per CLAUDE.md, so this
 * has to work on a database where `subscriptions.checkout_url` and
 * `subscription_payments` do not exist. It does it the way `lib/rate-limit.ts`
 * and `lib/admin/gates.ts` already do: **catch, log a code, answer with
 * less** — never by matching SQLSTATE `42P01`, which this repo deliberately
 * does nowhere, because a missing table and an unreachable database deserve
 * the same treatment.
 *
 * The degraded answer is `{ state: 'unavailable' }` and it is honest on
 * screen: `/conta/plano` shows the plan and says the checkout cannot be opened
 * right now (`billing.subscribe.error`, already-approved copy). What it must
 * never do is offer a subscribe button that then creates a real Asaas
 * subscription we cannot record.
 *
 * ## §12
 *
 * `checkoutUrl` is an Asaas `invoiceUrl`: it opens one named customer's
 * invoice, so it is personal data. It is returned to the account that owns the
 * row and to nothing else, and it is never logged — not in an error line, not
 * in an event prop.
 */

/** Our own subscription lifecycle. See the docstring and `0015`'s CHECK. */
export const SUBSCRIPTION_STATUS = {
  /** Created at Asaas, not yet paid. The checkout link is live. */
  pending: 'pending',
  /** A payment was confirmed or received. The plan is granted. */
  active: 'active',
  /** A charge passed its due date unpaid. Access continues; terms §7. */
  overdue: 'overdue',
  /** Terms §7's 10-day suspension. **Nothing writes this yet — card F4.** */
  suspended: 'suspended',
  /** Auto-renewal is off. `ends_on` is the last paid day. */
  canceled: 'canceled',
} as const

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUS)[keyof typeof SUBSCRIPTION_STATUS]

/** The statuses that mean "this account already has a subscription going". */
export const LIVE_STATUSES: readonly SubscriptionStatus[] = [
  SUBSCRIPTION_STATUS.pending,
  SUBSCRIPTION_STATUS.active,
  SUBSCRIPTION_STATUS.overdue,
  SUBSCRIPTION_STATUS.suspended,
]

/**
 * `array['pending','active',…]::text[]`, built by hand.
 *
 * **Not `= any(${LIVE_STATUSES})`.** Drizzle expands a bare JS array in an
 * `sql` template into `($1, $2, $3, $4)` — a row constructor, not an array —
 * so the comparison fails with *"cannot cast type record"*. This repository
 * has already paid for that lesson twice: `lib/radar/fixtures.ts:135-139`
 * records it in a comment and `lib/jobs/index.ts:271` builds the literal the
 * same way. The 2026-09-25 draft of this module wrote the bare array, and
 * because the only caller swallowed the throw and answered `unavailable`, the
 * whole checkout would have read as *"migration not applied"* for ever —
 * including the 30-second cooldown that stopped it retrying.
 *
 * The values are module constants, and the assertion makes injection
 * impossible rather than unlikely: `sql.raw` interpolates text.
 */
function liveStatusLiteral() {
  for (const status of LIVE_STATUSES) {
    if (!/^[a-z_]+$/.test(status)) throw new Error(`asaas: unsafe status literal ${status}`)
  }
  return sql.raw(`array[${LIVE_STATUSES.map((s) => `'${s}'`).join(',')}]::text[]`)
}

export type Payment = {
  status: string
  /** Exact decimal as a string, straight from `numeric(10,2)`. Never a float. */
  amount: string
  paidOn: string | null
  dueOn: string | null
}

export type Subscription = {
  asaasSubscriptionId: string
  status: SubscriptionStatus
  plan: string | null
  amount: string | null
  nextChargeOn: string | null
  promoEndsOn: string | null
  endsOn: string | null
  /** The Asaas invoice page. Null before the first charge exists. */
  checkoutUrl: string | null
  lastPayment: Payment | null
}

export type SubscriptionView =
  /** No live subscription, and the database answered. Offer the checkout. */
  | { state: 'none' }
  /** There is one. */
  | { state: 'found'; subscription: Subscription }
  /**
   * The database could not answer — migration 0015 is not applied, or Postgres
   * is unreachable. Not the same as `none`: offering a checkout here would
   * create a real Asaas subscription we could not record.
   */
  | { state: 'unavailable'; reason: string }

/** Until when {@link readSubscription} stops trying Postgres after a failure. */
const DB_DOWN_UNTIL = Symbol.for('licitaqui.billing.dbDownUntil')

/**
 * How long one failure buys of skipping the query. The same 30 seconds and the
 * same reasoning as `lib/rate-limit.ts`: one failure must not make every
 * request pay a failed round trip, and the next request after the window
 * retries, so the moment migration 0015 lands this self-heals with no deploy.
 */
const DB_RETRY_COOLDOWN_MS = 30_000

type Holder = { [DB_DOWN_UNTIL]?: number }
const holder = globalThis as unknown as Holder

type Row = {
  asaas_subscription_id: string
  status: string | null
  plan: string | null
  amount: string | null
  next_charge_on: string | null
  promo_ends_on: string | null
  ends_on: string | null
  checkout_url: string | null
  payment_status: string | null
  payment_amount: string | null
  payment_paid_on: string | null
  payment_due_on: string | null
}

/**
 * This account's live subscription, or why we cannot say.
 *
 * One statement, with the latest charge joined on, because the plan screen
 * wants both and two round trips to Neon for one card is one too many.
 */
export async function readSubscription(
  userId: number,
  database: Executor = db(),
  now: number = Date.now(),
): Promise<SubscriptionView> {
  const downUntil = holder[DB_DOWN_UNTIL]
  if (downUntil !== undefined && downUntil > now) {
    return { state: 'unavailable', reason: 'cooldown' }
  }
  let rows: Row[]
  try {
    const result = await database.execute<Row>(sql`
      select s.asaas_subscription_id,
             s.status,
             s.plan,
             s.amount::text            as amount,
             s.next_charge_on::text    as next_charge_on,
             s.promo_ends_on::text     as promo_ends_on,
             s.ends_on::text           as ends_on,
             s.checkout_url,
             p.status                  as payment_status,
             p.value::text             as payment_amount,
             p.paid_on::text           as payment_paid_on,
             p.due_on::text            as payment_due_on
        from subscriptions s
        left join lateral (
          select status, value, paid_on, due_on
            from subscription_payments
           where asaas_subscription_id = s.asaas_subscription_id
           order by coalesce(paid_on, due_on) desc nulls last
           limit 1
        ) p on true
       where s.user_id = ${userId}::bigint
         and s.status = any(${liveStatusLiteral()})
       limit 1
    `)
    rows = result.rows
  } catch (error) {
    // A code, never a message: a Postgres detail line can echo a value back
    // (§12). Missing table and unreachable database are the same case on
    // purpose — see the module docstring.
    const code = (error as { code?: string } | null)?.code ?? 'unknown'
    console.error(`billing: subscriptions unreadable (${code})`)
    holder[DB_DOWN_UNTIL] = now + DB_RETRY_COOLDOWN_MS
    return { state: 'unavailable', reason: code }
  }

  const row = rows[0]
  if (!row || !row.status) return { state: 'none' }
  return { state: 'found', subscription: toSubscription(row) }
}

function toSubscription(row: Row): Subscription {
  return {
    asaasSubscriptionId: row.asaas_subscription_id,
    status: row.status as SubscriptionStatus,
    plan: row.plan,
    amount: row.amount,
    nextChargeOn: row.next_charge_on,
    promoEndsOn: row.promo_ends_on,
    endsOn: row.ends_on,
    checkoutUrl: row.checkout_url,
    lastPayment:
      row.payment_status && row.payment_amount
        ? {
            status: row.payment_status,
            amount: row.payment_amount,
            paidOn: row.payment_paid_on,
            dueOn: row.payment_due_on,
          }
        : null,
  }
}

export type UpsertSubscription = {
  userId: number
  asaasCustomerId: string
  asaasSubscriptionId: string
  plan: string
  /** Reais as a decimal. `numeric(10,2)` takes the string form. */
  amount: number
  nextChargeOn: string | null
  checkoutUrl: string | null
}

/**
 * Record the subscription we just created, or refresh the one that was already
 * there.
 *
 * **`status` only ever moves forward.** The `case` refuses to walk an `active`,
 * `overdue` or `suspended` row back to `pending`: a webhook granting access
 * and a retried subscribe request can arrive in either order, and a second
 * subscribe must not un-pay a subscriber. `next_charge_on` and `checkout_url`
 * are `coalesce`d for the same reason — a later read that happens to find no
 * charge yet must not erase the link somebody is about to open.
 */
export async function upsertSubscription(
  input: UpsertSubscription,
  database: Executor = db(),
): Promise<void> {
  await database.execute(sql`
    insert into subscriptions (
      user_id, asaas_customer_id, asaas_subscription_id,
      plan, amount, status, next_charge_on, checkout_url, updated_at
    )
    values (
      ${input.userId}::bigint,
      ${input.asaasCustomerId}::text,
      ${input.asaasSubscriptionId}::text,
      ${input.plan}::text,
      ${input.amount.toFixed(2)}::numeric,
      ${SUBSCRIPTION_STATUS.pending}::text,
      ${input.nextChargeOn}::date,
      ${input.checkoutUrl}::text,
      now()
    )
    on conflict (asaas_subscription_id) do update
       set asaas_customer_id = excluded.asaas_customer_id,
           plan              = excluded.plan,
           amount            = excluded.amount,
           status            = case
                                 when subscriptions.status in ('active', 'overdue', 'suspended')
                                 then subscriptions.status
                                 else excluded.status
                               end,
           next_charge_on    = coalesce(excluded.next_charge_on, subscriptions.next_charge_on),
           checkout_url      = coalesce(excluded.checkout_url, subscriptions.checkout_url),
           updated_at        = now()
  `)
}

/**
 * Switch off auto-renewal: terms §8's Prime model.
 *
 * `ends_on` is the last day already paid for, which is the day before the next
 * charge would have been. A subscription that has never been paid has no
 * `next_charge_on` to count back from, so `ends_on` is today — there is no paid
 * period to honour.
 *
 * `0004_subscription_refunds.sql` added this column for exactly this, and said
 * *"the downgrade job reads this every day"*. `expire_subscriptions` in
 * `worker/licitaqui/billing.py` is that job; without it this column would be
 * the shape CLAUDE.md names five times — a column nothing reads.
 *
 * Returns whether a row was actually cancelled, so the caller can tell "done"
 * from "there was nothing to cancel" instead of reporting success either way.
 */
export async function cancelSubscription(
  userId: number,
  database: Executor = db(),
): Promise<{ cancelled: boolean; asaasSubscriptionId: string | null; endsOn: string | null }> {
  const result = await database.execute<{ asaas_subscription_id: string; ends_on: string | null }>(
    sql`
      update subscriptions
         set status     = ${SUBSCRIPTION_STATUS.canceled}::text,
             -- The product's clock, not the database's: "o último dia do
             -- período que já pagou" is a day in Brasília (CLAUDE.md, Clocks).
             ends_on    = coalesce(
                            next_charge_on - 1,
                            (now() at time zone 'America/Sao_Paulo')::date
                          ),
             updated_at = now()
       where user_id = ${userId}::bigint
         and status = any(${liveStatusLiteral()})
      returning asaas_subscription_id, ends_on::text as ends_on
    `,
  )
  const row = result.rows[0]
  return {
    cancelled: Boolean(row),
    asaasSubscriptionId: row?.asaas_subscription_id ?? null,
    endsOn: row?.ends_on ?? null,
  }
}

/** Tests only: forget the cooldown so one case cannot leak into the next. */
export function resetSubscriptionCooldown(): void {
  delete holder[DB_DOWN_UNTIL]
}
