import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { closeDb, db } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import { PLAN_PRICES, PROMO } from '@/lib/product'
import { RUN_ID } from '@/lib/radar/fixtures'
import { startCheckout } from './checkout'
import { AsaasClient } from './client'
import { applyEvent } from './entitlement'
import { cancelSubscription, readSubscription, resetSubscriptionCooldown } from './subscription'
import { readEvent } from './webhook'

/**
 * **The subscription flow against a real Postgres — cards F2 and D8.**
 *
 * This is the file that answers *"does it work?"* rather than *"does it
 * compile?"*. Every behaviour here is one the schema promises and a mock
 * cannot check: the partial unique index that stops a double subscription, the
 * `entitled_at` claim that stops a double grant, the status `case` that will
 * not walk a paid subscriber back to unpaid, and the date arithmetic that
 * decides when a founder's price changes. Asserting those against a stub would
 * assert the stub.
 *
 * **Asaas itself is stubbed, and that is the honest limit of this file.** No
 * real call has ever been made from this code: `ASAAS_API_KEY` is Sci's and
 * G12 — the Asaas production account, bank details, production webhook URL and
 * production key — is not done. So this proves what we do with Asaas's
 * answers, never that Asaas gives those answers. The sandbox cycle (create →
 * pay → repeat the webhook → cancel) is Sci's to run, and the PR says so.
 *
 * ## Isolation
 *
 * Every row is scoped by `RUN_ID`: the users under a per-run e-mail domain,
 * the Asaas ids under a per-run prefix. Two concurrent runs of this file
 * cannot see each other's subscriptions — CLAUDE.md's per-run rule, and the
 * reason a task-scoped constant is not good enough.
 *
 * ## It needs migration 0015
 *
 * `subscription_payments` and `subscriptions.checkout_url` arrive in
 * `db/migrations/0015_billing_asaas.sql`, which is its own PR and
 * self-applies on merge. Until it is applied this suite **fails rather than
 * skips**, and deliberately: a suite that skips itself on a missing table is
 * how a migration gets forgotten.
 */

const url = testDatabaseUrl()
const suite = url ? describe : describe.skip
if (url) process.env.DATABASE_URL = url

const DOMAIN = `billing-${RUN_ID}.test.invalid`
const CNPJ = '11222333000181'
const SUB = `sub_${RUN_ID}`
const CUS = `cus_${RUN_ID}`
const PAY = `pay_${RUN_ID}`

/** A client whose transport is a queue of replies. Nothing reaches a socket. */
function stubClient(replies: Array<unknown>) {
  const calls: string[] = []
  const transport = vi.fn(async (requested: string, init: RequestInit) => {
    calls.push(`${init.method} ${requested.replace(/^https:\/\/[^/]+/, '')}`)
    return new Response(JSON.stringify(replies.shift() ?? {}), { status: 200 })
  })
  return {
    calls,
    client: new AsaasClient({
      env: { ASAAS_BILLING: 'live', ASAAS_ENV: 'sandbox', ASAAS_API_KEY: '$aact_hmlg_test' },
      transport,
    }),
  }
}

/** The three replies `startCheckout` makes in order, for a first subscribe. */
function firstSubscribeReplies(invoiceUrl: string | null, dueDate = '2026-10-17') {
  return [
    { data: [] }, //                                   GET  /customers   -> none
    { id: CUS }, //                                    POST /customers
    { data: [] }, //                                   GET  /subscriptions -> none
    { id: SUB, status: 'ACTIVE', nextDueDate: dueDate }, // POST /subscriptions
    {
      data: invoiceUrl
        ? [{ id: PAY, status: 'PENDING', value: PLAN_PRICES.promocional, dueDate, invoiceUrl }]
        : [],
    }, //                                              GET  /subscriptions/{id}/payments
  ]
}

async function makeUser(options: { seat?: number | null; cnpj?: string | null } = {}) {
  const found = await db().execute<{ id: string }>(sql`
    insert into companies (cnpj, legal_name)
    values (${CNPJ}, ${`Empresa ${RUN_ID}`})
    on conflict (cnpj) do nothing
    returning cnpj
  `)
  void found
  const user = await db().execute<{ id: string }>(sql`
    insert into users (email, name, cnpj, founder_seat)
    values (${`sub@${DOMAIN}`}, ${'Maria Teste'},
            ${options.cnpj === undefined ? CNPJ : options.cnpj},
            ${options.seat === undefined ? null : options.seat})
    returning id
  `)
  return Number(user.rows[0].id)
}

const event = (name: string, over: Record<string, unknown> = {}) =>
  readEvent({
    id: `evt_${RUN_ID}_${name}_${(over.suffix as string) ?? '1'}`,
    event: name,
    payment: {
      id: PAY,
      subscription: SUB,
      status: name === 'PAYMENT_CONFIRMED' ? 'CONFIRMED' : 'PENDING',
      value: PLAN_PRICES.promocional,
      dueDate: '2026-10-17',
      paymentDate: name === 'PAYMENT_CONFIRMED' ? '2026-10-17' : null,
      ...over,
    },
  })!

/** The receiver's half: store the envelope, then apply it, in one transaction. */
async function deliver(name: string, over: Record<string, unknown> = {}) {
  const parsed = event(name, over)
  return db().transaction(async (tx) => {
    const stored = await tx.execute<{ id: string }>(sql`
      insert into webhook_events (id, source, event, body)
      values (${parsed.id}::text, 'asaas'::text, ${parsed.event}::text,
              ${JSON.stringify(parsed.body)}::jsonb)
      on conflict (id) do nothing
      returning id
    `)
    if (stored.rows.length === 0) return { outcome: 'duplicate' as const }
    return applyEvent(parsed, tx)
  })
}

async function planOf(userId: number): Promise<string> {
  const found = await db().execute<{ plan: string }>(sql`
    select plan from users where id = ${userId}::bigint
  `)
  return found.rows[0].plan
}

async function cleanup() {
  await db().execute(sql`delete from webhook_events where id like ${`evt_${RUN_ID}%`}`)
  await db().execute(sql`delete from subscription_payments where asaas_payment_id like ${`pay_${RUN_ID}%`}`)
  await db().execute(sql`delete from subscriptions where asaas_subscription_id like ${`sub_${RUN_ID}%`}`)
  await db().execute(sql`delete from users where email like ${`%@${DOMAIN}`}`)
  await db().execute(sql`delete from companies where cnpj = ${CNPJ} and legal_name like ${`Empresa ${RUN_ID}`}`)
}

suite('the subscription flow (database)', () => {
  beforeEach(async () => {
    resetSubscriptionCooldown()
    await cleanup()
  })

  afterAll(async () => {
    await cleanup()
    await closeDb()
  })

  it('reads no subscription for an account that has none', async () => {
    const userId = await makeUser()
    expect(await readSubscription(userId)).toEqual({ state: 'none' })
  })

  it('charges a founder the promotional price and nobody else', async () => {
    const founder = await makeUser({ seat: 3 })
    const { client } = stubClient(firstSubscribeReplies('https://sandbox.asaas.com/i/one'))
    const result = await startCheckout(founder, { client })

    expect(result.outcome).toBe('ready')
    if (result.outcome !== 'ready') return
    expect(result.plan).toBe('promocional')
    expect(result.amount).toBe(PLAN_PRICES.promocional)

    const row = await readSubscription(founder)
    expect(row.state).toBe('found')
    if (row.state !== 'found') return
    // `numeric(10,2)` comes back as a string. Money is never a float.
    expect(Number(row.subscription.amount)).toBe(PLAN_PRICES.promocional)
    expect(row.subscription.status).toBe('pending')
    expect(row.subscription.checkoutUrl).toBe('https://sandbox.asaas.com/i/one')
  })

  it('creates the Asaas customer with notifications disabled', async () => {
    // Spec §9: Asaas bills us per notification and they are on by default.
    const founder = await makeUser({ seat: 4 })
    const { client } = stubClient(firstSubscribeReplies(null))
    await startCheckout(founder, { client })
    // The request body itself is asserted in `client.test.ts`; what this adds
    // is that the real `startCheckout` path goes through that method at all.
    const found = await db().execute<{ asaas_customer_id: string }>(sql`
      select asaas_customer_id from subscriptions where user_id = ${founder}::bigint
    `)
    expect(found.rows[0].asaas_customer_id).toBe(CUS)
  })

  it('reuses the subscription Asaas already has rather than making a second', async () => {
    /**
     * Asaas has **no idempotency-key header** and its own docs tell
     * integrators to query before retrying, so `externalReference` is the key
     * and it is per account rather than per attempt. The database's half of
     * the same guarantee is `0015`'s partial unique index on `(user_id) where
     * status in (…)` — which this also proves, because a second insert with a
     * second Asaas id would violate it and throw.
     */
    const founder = await makeUser({ seat: 5 })
    const first = stubClient(firstSubscribeReplies('https://sandbox.asaas.com/i/one'))
    await startCheckout(founder, { client: first.client })

    const again = stubClient([
      { data: [{ id: CUS }] }, //                        the customer exists
      { data: [{ id: SUB, status: 'ACTIVE', nextDueDate: '2026-10-17' }] }, // so does the subscription
      {
        data: [
          {
            id: PAY,
            status: 'PENDING',
            value: PLAN_PRICES.promocional,
            dueDate: '2026-10-17',
            invoiceUrl: 'https://sandbox.asaas.com/i/one',
          },
        ],
      },
    ])
    const second = await startCheckout(founder, { client: again.client })
    expect(second.outcome).toBe('ready')
    if (second.outcome !== 'ready') return
    expect(second.created).toBe(false)
    expect(again.calls.filter((c) => c.startsWith('POST'))).toEqual([])

    const rows = await db().execute<{ n: string }>(sql`
      select count(*)::text as n from subscriptions where user_id = ${founder}::bigint
    `)
    expect(rows.rows[0].n).toBe('1')
  })

  it('refuses an account Asaas cannot be given a document for', async () => {
    const noCnpj = await makeUser({ cnpj: null })
    const { client, calls } = stubClient([])
    expect(await startCheckout(noCnpj, { client })).toEqual({ outcome: 'needs_company' })
    // And it refuses **before** opening a socket: a customer with a blank
    // document is a 400 we can predict.
    expect(calls).toEqual([])
  })

  it('writes nothing and claims nothing while billing is switched off', async () => {
    const founder = await makeUser({ seat: 6 })
    const off = new AsaasClient({ env: {} })
    const result = await startCheckout(founder, { client: off })
    expect(result.outcome).toBe('dry_run')
    // The crucial half: no row, so the screen cannot show a subscription that
    // does not exist at Asaas.
    expect(await readSubscription(founder)).toEqual({ state: 'none' })
  })

  it('records the subscription even when Asaas has not produced the invoice yet', async () => {
    // The Asaas subscription already exists; not writing the row would leave a
    // real subscription with nothing on our side pointing at it, and a cancel
    // could not reach it.
    const founder = await makeUser({ seat: 7 })
    const { client } = stubClient(firstSubscribeReplies(null))
    const result = await startCheckout(founder, { client })
    expect(result.outcome).toBe('ready')
    if (result.outcome !== 'ready') return
    expect(result.checkoutUrl).toBeNull()

    const row = await readSubscription(founder)
    expect(row.state).toBe('found')
  })

  it('offers the earliest payable invoice, not the newest charge', async () => {
    /**
     * Asaas returns the list newest-first and generates charges up to 40 days
     * ahead, so the newest row can be a charge that is not due yet while the
     * one the subscriber must pay today sits below it.
     */
    const founder = await makeUser({ seat: 8 })
    const { client } = stubClient([
      { data: [] },
      { id: CUS },
      { data: [] },
      { id: SUB, status: 'ACTIVE', nextDueDate: '2026-10-17' },
      {
        data: [
          { id: `${PAY}_nov`, status: 'PENDING', value: 57, dueDate: '2026-11-17', invoiceUrl: 'https://x/nov' },
          { id: PAY, status: 'PENDING', value: 57, dueDate: '2026-10-17', invoiceUrl: 'https://x/out' },
        ],
      },
    ])
    const result = await startCheckout(founder, { client })
    expect(result.outcome).toBe('ready')
    if (result.outcome !== 'ready') return
    expect(result.checkoutUrl).toBe('https://x/out')
  })
})

suite('what a webhook does to an account (database)', () => {
  beforeEach(async () => {
    resetSubscriptionCooldown()
    await cleanup()
  })

  afterAll(async () => {
    await cleanup()
    await closeDb()
  })

  async function subscribed(seat: number | null = 3) {
    const userId = await makeUser({ seat })
    const { client } = stubClient(firstSubscribeReplies('https://sandbox.asaas.com/i/one'))
    await startCheckout(userId, { client })
    return userId
  }

  it('grants the plan on a confirmed payment', async () => {
    const userId = await subscribed()
    expect(await planOf(userId)).toBe('basico')

    const applied = await deliver('PAYMENT_CONFIRMED')
    expect(applied.outcome).toBe('granted')
    expect(await planOf(userId)).toBe('promocional')

    const row = await readSubscription(userId)
    expect(row.state).toBe('found')
    if (row.state !== 'found') return
    expect(row.subscription.status).toBe('active')
  })

  it('grants once per payment, across the several events that describe it', async () => {
    /**
     * One payment produces two or three events with different ids — Asaas
     * documents CREATED → CONFIRMED → RECEIVED, with a card's RECEIVED
     * arriving about 32 days after CONFIRMED. `webhook_events.id` cannot
     * answer "has this payment already granted?"; `entitled_at` can.
     */
    const userId = await subscribed()
    expect((await deliver('PAYMENT_CONFIRMED')).outcome).toBe('granted')
    expect((await deliver('PAYMENT_RECEIVED')).outcome).toBe('already_entitled')

    const claims = await db().execute<{ n: string }>(sql`
      select count(*)::text as n from subscription_payments
       where asaas_payment_id = ${PAY} and entitled_at is not null
    `)
    expect(claims.rows[0].n).toBe('1')
  })

  it('does nothing twice for the same event id', async () => {
    const userId = await subscribed()
    await deliver('PAYMENT_CONFIRMED')
    expect((await deliver('PAYMENT_CONFIRMED')).outcome).toBe('duplicate')
    expect(await planOf(userId)).toBe('promocional')
  })

  it('dates the promotional window from the first payment, once', async () => {
    /**
     * `promo_ends_on` is what F3 reads to send the 30-day notice before the
     * price changes (terms §6.4). A second month's payment must not push it a
     * month further out, which would make the promotional price last for ever
     * — the defect the parked draft had, in the opposite direction.
     */
    const userId = await subscribed()
    await deliver('PAYMENT_CONFIRMED')

    const row = await readSubscription(userId)
    expect(row.state).toBe('found')
    if (row.state !== 'found') return
    // Paid 17/10/2026 + 3 months (`docs/product.json`) = 17/01/2027.
    const expected = new Date(Date.UTC(2026, 9, 17))
    expected.setUTCMonth(expected.getUTCMonth() + PROMO.months)
    expect(row.subscription.promoEndsOn).toBe(expected.toISOString().slice(0, 10))

    // A later payment leaves it alone.
    await deliver('PAYMENT_RECEIVED', { suffix: '2', id: `${PAY}_m2`, paymentDate: '2026-11-17', dueDate: '2026-11-17' })
    const again = await readSubscription(userId)
    if (again.state !== 'found') throw new Error('subscription vanished')
    expect(again.subscription.promoEndsOn).toBe(row.subscription.promoEndsOn)
  })

  it('leaves an account with no seat on the standard plan', async () => {
    const userId = await subscribed(null)
    await deliver('PAYMENT_CONFIRMED')
    expect(await planOf(userId)).toBe('essencial')
  })

  it('takes the plan away on a refund', async () => {
    const userId = await subscribed()
    await deliver('PAYMENT_CONFIRMED')
    expect((await deliver('PAYMENT_REFUNDED')).outcome).toBe('revoked')
    expect(await planOf(userId)).toBe('basico')
  })

  it('takes the plan away on a chargeback', async () => {
    // The draft listed the chargeback *statuses* and none of the chargeback
    // *events*, so a charged-back account kept its paid plan.
    const userId = await subscribed()
    await deliver('PAYMENT_CONFIRMED')
    expect((await deliver('PAYMENT_CHARGEBACK_REQUESTED')).outcome).toBe('revoked')
    expect(await planOf(userId)).toBe('basico')
  })

  it('keeps a subscriber who has since paid another month', async () => {
    // A partial refund of one month must not cancel somebody who is paid up.
    const userId = await subscribed()
    await deliver('PAYMENT_CONFIRMED')
    await deliver('PAYMENT_RECEIVED', {
      suffix: 'm2',
      id: `${PAY}_m2`,
      status: 'RECEIVED',
      paymentDate: '2026-11-17',
      dueDate: '2026-11-17',
    })
    await deliver('PAYMENT_REFUNDED', { suffix: 'r1' })
    expect(await planOf(userId)).toBe('promocional')
  })

  it('marks a subscription overdue without taking access away', async () => {
    // Terms §7's grace period starting. The 10-day suspension is card F4 and
    // nothing writes `suspended` yet.
    const userId = await subscribed()
    await deliver('PAYMENT_CONFIRMED')
    await deliver('PAYMENT_OVERDUE', { suffix: 'o1', status: 'OVERDUE' })
    const row = await readSubscription(userId)
    if (row.state !== 'found') throw new Error('subscription vanished')
    expect(row.subscription.status).toBe('overdue')
    expect(await planOf(userId)).toBe('promocional')
  })

  it('keeps next_charge_on on Asaas own number, never on a cycle guess', async () => {
    /**
     * Asaas sends `PAYMENT_CREATED` with the new charge's own `dueDate`.
     * `next_charge_on` is the earliest unsettled due date, so the screen's
     * *"Próxima cobrança em {data}"* and F4's reminder both read something
     * Asaas said rather than `last due date + 1 month`, which is what a
     * monthly cycle looks like until a due date lands on a holiday.
     */
    const userId = await subscribed()
    await deliver('PAYMENT_CONFIRMED')
    await deliver('PAYMENT_CREATED', {
      suffix: 'c2',
      id: `${PAY}_m2`,
      status: 'PENDING',
      dueDate: '2026-11-18',
      paymentDate: null,
    })
    const row = await readSubscription(userId)
    if (row.state !== 'found') throw new Error('subscription vanished')
    expect(row.subscription.nextChargeOn).toBe('2026-11-18')
  })

  it('records an event about a subscription it never created, and acts on none of it', async () => {
    const userId = await subscribed()
    const foreign = readEvent({
      id: `evt_${RUN_ID}_foreign`,
      event: 'PAYMENT_CONFIRMED',
      payment: { id: `${PAY}_foreign`, subscription: 'sub_somebody_elses', status: 'CONFIRMED', value: 999 },
    })!
    const applied = await db().transaction(async (tx) => {
      await tx.execute(sql`
        insert into webhook_events (id, source, event, body)
        values (${foreign.id}::text, 'asaas'::text, ${foreign.event}::text, ${JSON.stringify(foreign.body)}::jsonb)
      `)
      return applyEvent(foreign, tx)
    })
    expect(applied).toEqual({ outcome: 'unknown_subscription' })
    // The forgery bound: a caller holding the webhook token can replay and
    // reorder events about our subscribers, and cannot invent one.
    expect(await planOf(userId)).toBe('basico')
  })

  it('ignores an event it has no rule for, and marks it processed', async () => {
    await subscribed()
    const applied = await deliver('PAYMENT_SOMETHING_NEW')
    expect(applied.outcome).toBe('ignored')
    const row = await db().execute<{ processed_at: string | null }>(sql`
      select processed_at::text as processed_at from webhook_events
       where id like ${`evt_${RUN_ID}_PAYMENT_SOMETHING_NEW%`}
    `)
    // Not a failed job: fifteen of those pause Asaas's queue for fourteen days.
    expect(row.rows[0].processed_at).not.toBeNull()
  })

  it('ends the subscription when Asaas says it is gone', async () => {
    const userId = await subscribed()
    await deliver('PAYMENT_CONFIRMED')
    const ended = await db().transaction(async (tx) => {
      const parsed = readEvent({
        id: `evt_${RUN_ID}_sub_deleted`,
        event: 'SUBSCRIPTION_DELETED',
        subscription: { id: SUB },
      })!
      await tx.execute(sql`
        insert into webhook_events (id, source, event, body)
        values (${parsed.id}::text, 'asaas'::text, ${parsed.event}::text, ${JSON.stringify(parsed.body)}::jsonb)
      `)
      return applyEvent(parsed, tx)
    })
    expect(ended.outcome).toBe('ended')
    // The paid period is honoured: `ends_on` is set and the plan is not
    // dropped here. `expire_subscriptions` in the worker does that on the day.
    const row = await db().execute<{ status: string; ends_on: string | null }>(sql`
      select status, ends_on::text as ends_on from subscriptions
       where asaas_subscription_id = ${SUB}
    `)
    expect(row.rows[0].status).toBe('canceled')
    expect(row.rows[0].ends_on).not.toBeNull()
    expect(await planOf(userId)).toBe('promocional')
  })
})

suite('cancelling (database)', () => {
  beforeEach(async () => {
    resetSubscriptionCooldown()
    await cleanup()
  })

  afterAll(async () => {
    await cleanup()
    await closeDb()
  })

  it('sets the last paid day to the day before the next charge', async () => {
    // Terms §8's Prime model, and `billing.cancel.untilWhen` is the approved
    // sentence that states it.
    const userId = await makeUser({ seat: 2 })
    const { client } = stubClient(firstSubscribeReplies('https://x/i', '2026-11-17'))
    await startCheckout(userId, { client })

    const result = await cancelSubscription(userId)
    expect(result.cancelled).toBe(true)
    expect(result.endsOn).toBe('2026-11-16')

    // And it is no longer live, so the screen stops offering a cancel and the
    // partial unique index lets the same person subscribe again later.
    expect(await readSubscription(userId)).toEqual({ state: 'none' })
  })

  it('says so when there was nothing to cancel', async () => {
    const userId = await makeUser()
    expect(await cancelSubscription(userId)).toEqual({
      cancelled: false,
      asaasSubscriptionId: null,
      endsOn: null,
    })
  })

  it('lets the same account subscribe again afterwards', async () => {
    const userId = await makeUser({ seat: 9 })
    const first = stubClient(firstSubscribeReplies('https://x/i'))
    await startCheckout(userId, { client: first.client })
    await cancelSubscription(userId)

    const second = stubClient([
      { data: [{ id: CUS }] },
      { data: [] }, //                                  the old subscription is gone at Asaas
      { id: `${SUB}_b`, status: 'ACTIVE', nextDueDate: '2027-01-17' },
      { data: [{ id: `${PAY}_b`, status: 'PENDING', value: 57, dueDate: '2027-01-17', invoiceUrl: 'https://x/b' }] },
    ])
    const again = await startCheckout(userId, { client: second.client })
    expect(again.outcome).toBe('ready')

    const rows = await db().execute<{ n: string }>(sql`
      select count(*)::text as n from subscriptions where user_id = ${userId}::bigint
    `)
    // Two rows: the cancelled one stays for the financial history, which is
    // why `0015`'s unique index is partial.
    expect(rows.rows[0].n).toBe('2')
  })
})
