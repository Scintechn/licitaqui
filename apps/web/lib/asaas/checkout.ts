import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'
import { messages } from '@/lib/messages'
import { AsaasClient, AsaasError, DRY_RUN, externalReference, type Maybe } from './client'
import { priceFor } from './price'
import { readSubscription, upsertSubscription } from './subscription'

/**
 * Starting a subscription: customer → subscription → checkout link — **F2**.
 *
 * Spec §8 puts this inside `POST /api/subscribe` and says it *"returns the
 * checkout link"*, so it is three sequential Asaas calls in one request. Each
 * one is read-before-write, because **Asaas has no idempotency-key header** and
 * their own docs tell integrators to query before retrying: the key is
 * `externalReference = licitaqui-user-<id>`, which is per account rather than
 * per attempt, so a double tap or a retried request converges on the same
 * customer and the same subscription instead of making a second one.
 *
 * ## The checkout link is on the first charge, not on the subscription
 *
 * Asaas puts no hosted-checkout URL on a subscription. The documented recipe is
 * `POST /v3/subscriptions`, then `GET /v3/subscriptions/{id}/payments`, and read
 * `invoiceUrl` off the first charge. Asaas generates that charge immediately
 * for a `nextDueDate` of today, but *immediately* is their word and not a
 * guarantee, so a missing link is a state this returns (`created`, with
 * `checkoutUrl: null`) rather than an error — the plan screen then shows the
 * subscription as pending and the next page load picks the link up.
 *
 * ## Why the row is written even when the link is missing
 *
 * Because the Asaas subscription already exists. Not writing it would leave a
 * real subscription at Asaas with nothing on our side pointing at it, and the
 * next subscribe attempt would find it by `externalReference` and reuse it —
 * which works, but only by luck, and a cancel could not reach it in the
 * meantime.
 *
 * ## What it refuses
 *
 * Asaas requires `cpfCnpj` and `name` on a customer. An account with neither a
 * CNPJ nor a company name cannot be billed, and this says so as
 * `{ outcome: 'needs_company' }` rather than sending Asaas a blank. **The
 * sentence that explains that to the reader does not exist** — nothing in the
 * catalogue says "we need your CNPJ before you can subscribe", and copy is
 * Sci's (legal brief §5). The plan screen therefore shows the company link and
 * no subscribe button, and the missing sentence is carded (**F8**) and has a
 * `docs/CLAIMS.md` row.
 *
 * ## §12
 *
 * The CNPJ and the name are bound parameters and go to Asaas, which is the
 * point. Neither reaches a log line, and nor does the checkout URL.
 */

export type CheckoutOutcome =
  /** A subscription exists (new or reused) and here is what to show. */
  | {
      outcome: 'ready'
      plan: string
      amount: number
      asaasSubscriptionId: string
      checkoutUrl: string | null
      created: boolean
    }
  /** Already paid. Nothing was created. */
  | { outcome: 'already_active' }
  /** Asaas needs a document and a name we do not have. */
  | { outcome: 'needs_company' }
  /** `ASAAS_BILLING` is not `live`. No call was made and no row was written. */
  | { outcome: 'dry_run'; plan: string; amount: number }
  /** Nothing was created. `reason` is a code, never a message. */
  | { outcome: 'failed'; reason: string; retryable: boolean }

type SubscriberRow = {
  email: string
  name: string | null
  whatsapp: string | null
  cnpj: string | null
  founder_seat: number | null
  legal_name: string | null
  trade_name: string | null
  /** Today in the product's clock, so the first charge is dated in BRT. */
  today_brt: string
}

/**
 * Create or reuse this account's subscription and return its checkout link.
 *
 * `client` is injected so a test can drive the whole path with a fake
 * transport; nothing in the product passes one.
 */
export async function startCheckout(
  userId: number,
  options: { database?: Executor; client?: AsaasClient } = {},
): Promise<CheckoutOutcome> {
  const database = options.database ?? db()
  const client = options.client ?? new AsaasClient()

  const existing = await readSubscription(userId, database)
  if (existing.state === 'unavailable') {
    return { outcome: 'failed', reason: `database:${existing.reason}`, retryable: true }
  }
  if (existing.state === 'found' && existing.subscription.status === 'active') {
    return { outcome: 'already_active' }
  }

  const row = await subscriber(userId, database)
  if (!row) return { outcome: 'failed', reason: 'no_user', retryable: false }

  const price = priceFor(row.founder_seat === null ? null : Number(row.founder_seat))

  if (!client.live) {
    // Nothing happened, and the caller must not pretend otherwise. Checked
    // before the configuration fault below so a developer with no key set at
    // all gets the honest "billing is off" rather than "misconfigured".
    return { outcome: 'dry_run', plan: price.plan, amount: price.reais }
  }

  // Asked of the client, never of `process.env` — see `AsaasClient.fault`.
  const fault = client.fault
  if (fault) return { outcome: 'failed', reason: fault, retryable: false }

  const document = (row.cnpj ?? '').replace(/\D/g, '')
  const name = (row.name ?? row.legal_name ?? row.trade_name ?? '').trim()
  if (!document || !name) return { outcome: 'needs_company' }

  const reference = externalReference(userId)

  try {
    const customerId = await ensureCustomer(client, reference, {
      name,
      cpfCnpj: document,
      externalReference: reference,
      email: row.email,
      ...(row.whatsapp ? { mobilePhone: row.whatsapp } : {}),
    })
    if (customerId === DRY_RUN) return { outcome: 'dry_run', plan: price.plan, amount: price.reais }

    const found = await client.findSubscription(reference)
    if (found === DRY_RUN) return { outcome: 'dry_run', plan: price.plan, amount: price.reais }

    let created = false
    let subscription = found
    if (!subscription) {
      const made = await client.createSubscription({
        customer: customerId,
        value: price.reais,
        // Today in BRT: the founder is subscribing now and the first charge is
        // now. Asaas generates the invoice for a same-day due date straight
        // away, which is what produces the link the button needs.
        nextDueDate: row.today_brt,
        externalReference: reference,
        description: descriptionFor(price.plan),
      })
      if (made === DRY_RUN) return { outcome: 'dry_run', plan: price.plan, amount: price.reais }
      subscription = made
      created = true
    }

    const subscriptionId = subscription.id
    const checkoutUrl = await firstInvoiceUrl(client, subscriptionId)
    /**
     * **Asaas's own `nextDueDate`, not the date we asked for.**
     *
     * `today_brt` is only the fallback for an answer that carried none. The
     * first version of this read `found?.nextDueDate ?? row.today_brt`, which
     * silently dropped the created subscription's own date — identical in
     * production, where the due date we send *is* today, and wrong the moment
     * Asaas shifts one. `billing.db.test.ts` found it: a cancel then computed
     * `ends_on` as yesterday instead of the day before the real next charge.
     */
    const nextChargeOn = subscription.nextDueDate ?? row.today_brt

    await upsertSubscription(
      {
        userId,
        asaasCustomerId: customerId,
        asaasSubscriptionId: subscriptionId,
        plan: price.plan,
        amount: price.reais,
        nextChargeOn,
        checkoutUrl,
      },
      database,
    )

    return {
      outcome: 'ready',
      plan: price.plan,
      amount: price.reais,
      asaasSubscriptionId: subscriptionId,
      checkoutUrl,
      created,
    }
  } catch (error) {
    if (error instanceof AsaasError) {
      console.error(`billing: checkout failed (${error.reason}/${error.code ?? '-'})`)
      return { outcome: 'failed', reason: error.reason, retryable: error.retryable }
    }
    const code = (error as { code?: string } | null)?.code ?? 'unknown'
    console.error(`billing: checkout failed (db:${code})`)
    return { outcome: 'failed', reason: `database:${code}`, retryable: true }
  }
}

/**
 * The invoice page of this subscription's earliest charge, or `null`.
 *
 * **Earliest, not newest.** Asaas returns the list newest-first and generates
 * charges up to 40 days ahead, so the newest row can be a charge that is not
 * due yet while the one the subscriber has to pay today sits below it. The
 * link on screen must be the one that settles the subscription now.
 */
async function firstInvoiceUrl(
  client: AsaasClient,
  subscriptionId: string,
): Promise<string | null> {
  const payments = await client.subscriptionPayments(subscriptionId)
  if (payments === DRY_RUN) return null
  const payable = payments
    .filter((payment) => payment.invoiceUrl)
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))
  return payable[0]?.invoiceUrl ?? null
}

async function ensureCustomer(
  client: AsaasClient,
  reference: string,
  request: Parameters<AsaasClient['createCustomer']>[0],
): Promise<Maybe<string>> {
  const found = await client.findCustomer(reference)
  if (found === DRY_RUN) return DRY_RUN
  if (found) return found.id
  const made = await client.createCustomer(request)
  return made === DRY_RUN ? DRY_RUN : made.id
}

/**
 * What appears on the invoice the subscriber opens.
 *
 * **Nothing here is written.** The brand is fixed by CLAUDE.md and the plan
 * name is approved catalogue copy (`plans.promo.name` / `plans.essential.name`,
 * the same two strings `account-data.ts` already renders as `planName`), so
 * this composes rather than authors. A sentence of its own would be
 * user-facing copy rendered outside the product with nothing holding it to the
 * catalogue — legal brief §5 — and an invoice line is exactly where a reader
 * checks that they are buying what they were sold.
 */
export function descriptionFor(plan: string): string {
  const name = plan === 'promocional' ? messages.plans.promo.name : messages.plans.essential.name
  return `LicitaQui · ${name}`
}

async function subscriber(userId: number, database: Executor): Promise<SubscriberRow | null> {
  const result = await database.execute<SubscriberRow>(sql`
    select u.email::text                                       as email,
           u.name,
           u.whatsapp,
           u.cnpj::text                                        as cnpj,
           u.founder_seat,
           c.legal_name,
           c.trade_name,
           -- CLAUDE.md, Clocks: the database is UTC and every date a person
           -- reads is Brasília. An Asaas nextDueDate computed from a UTC
           -- midnight is tomorrow's charge for three hours every night.
           (now() at time zone 'America/Sao_Paulo')::date::text as today_brt
      from users u
      left join companies c on c.cnpj = u.cnpj
     where u.id = ${userId}::bigint
  `)
  return result.rows[0] ?? null
}
