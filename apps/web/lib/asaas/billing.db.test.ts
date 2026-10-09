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
 * **With one exception, and this paragraph used to deny it.** `founder_seat` is
 * `int unique check (between 1 and 48)`, so `RUN_ID` cannot scope it and
 * {@link makeUser} asks for nine of the 48 by literal number. A crashed run's
 * leftover seat is released by {@link freeDebrisSeat}; two *live* runs still
 * contend, and card **F17** carries the database-of-its-own that fixes it. The
 * claim that "every row is scoped by `RUN_ID`" was true of everything this file
 * writes except the one value that matters most, and it cost 20 of 35 tests on
 * 2026-10-09.
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

/**
 * The replies `startCheckout` reads in order, for a first subscribe.
 *
 * **`dueDate` defaults to today in the product's clock, not to a constant.**
 * `startCheckout` asks Asaas for `today_brt` and Asaas echoes back the date it
 * was given, so a stub answering a fixed `'2026-10-17'` hands the code a value
 * production cannot produce at that moment. That is the shape review found one
 * layer up, and it survived the first fix: the two tests written to catch the
 * `ends_on` defect failed against the constant rather than against the code.
 *
 * A test that wants a specific calendar date passes one.
 */
async function firstSubscribeReplies(invoiceUrl: string | null, dueDate?: string) {
  dueDate ??= await brtToday()
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

/**
 * How long a `.test.invalid` row must have sat there before another run may
 * take its seat. Mirrors `CROSS_RUN_SWEEP_HOURS` in `worker/tests/conftest.py`,
 * and for the same reason: a crashed run's `RUN_ID` is unknowable, so age is
 * the only signal that tells its debris from a live run's fixtures.
 *
 * Two hours is safe here only because **nothing in this file backdates a
 * user**. If a case ever ages one — to prove an expiry, say — this number must
 * move above the oldest age it fabricates, exactly as the worker's note says.
 */
const SEAT_DEBRIS_HOURS = 2

/**
 * Free a seat held by a **crashed run's** leftover row, so this run can claim it.
 *
 * `users.founder_seat` is the one value in this file that `RUN_ID` cannot
 * scope: `0001_initial.sql` declares it `int unique` with
 * `check (founder_seat between 1 and 48)`, so there are 48 of them in the whole
 * database and every run must take the same small integers. {@link makeUser}
 * asks for nine of them by literal number.
 *
 * On 2026-10-09 that cost 20 of this file's 35 tests. A single row — one user
 * on `@billing-<run>.test.invalid` holding seat 3, left behind when the
 * previous lane's suite was killed at the harness cap — made every case that
 * asks for seat 3 fail on `duplicate key value violates unique constraint
 * "users_founder_seat_key"` before it reached an assertion. `cleanup()` could
 * not clear it: it deletes by *this* run's e-mail domain, so a crashed run's
 * debris is permanently invisible to it and wedges the suite for every run
 * afterwards. The two cancellation-date failures the lane was actually chasing
 * were underneath, unreachable.
 *
 * Both guards are load-bearing and neither is optional:
 *
 *  - **the domain**, so this can never touch a real account. `.test.invalid` is
 *    a reserved TLD (RFC 2606) and matches nothing a person could register;
 *  - **the age**, so it can never touch a *live* concurrent run of this same
 *    file. Its rows are seconds old; only debris is older than
 *    {@link SEAT_DEBRIS_HOURS}.
 *
 * It is `update … set founder_seat = null` rather than a delete, which is
 * `u1.db.test.ts`'s `freeTheSeat` and the narrowest thing that works: the seat
 * is released, the stale row stays, and nothing that might be somebody's
 * fixture is removed.
 *
 * **What this does not fix**, and card **F17** says so rather than a comment:
 * two runs of this file *inside* the age window still contend for the same nine
 * seats, and the loser fails. 48 unique seats is a product constraint, not a
 * fixture choice, so the answer is a database of its own
 * (`TEST_DATABASE_URL_F2`, the escape hatch `test-url.ts` documents) and not a
 * cleverer prefix.
 */
async function freeDebrisSeat(seat: number) {
  await db().execute(sql`
    update users set founder_seat = null
     where founder_seat = ${seat}
       and email like '%.test.invalid'
       and created_at < now() - ${`${SEAT_DEBRIS_HOURS} hours`}::interval
  `)
}

async function makeUser(options: { seat?: number | null; cnpj?: string | null } = {}) {
  const found = await db().execute<{ id: string }>(sql`
    insert into companies (cnpj, legal_name)
    values (${CNPJ}, ${`Empresa ${RUN_ID}`})
    on conflict (cnpj) do nothing
    returning cnpj
  `)
  void found
  if (options.seat !== undefined && options.seat !== null) await freeDebrisSeat(options.seat)
  const user = await db().execute<{ id: string }>(sql`
    insert into users (email, name, cnpj, founder_seat)
    values (${`sub@${DOMAIN}`}, ${'Maria Teste'},
            ${options.cnpj === undefined ? CNPJ : options.cnpj},
            ${options.seat === undefined ? null : options.seat})
    returning id
  `)
  return Number(user.rows[0].id)
}

/**
 * One Asaas envelope. Dates default to today in the product's clock, for the
 * reason {@link firstSubscribeReplies} gives: the charge a first payment
 * settles is the one `startCheckout` asked for, which is today.
 */
const event = async (name: string, over: Record<string, unknown> = {}) => {
  const today = await brtToday()
  return readEvent({
    id: `evt_${RUN_ID}_${name}_${(over.suffix as string) ?? '1'}`,
    event: name,
    payment: {
      id: PAY,
      subscription: SUB,
      status: name === 'PAYMENT_CONFIRMED' ? 'CONFIRMED' : 'PENDING',
      value: PLAN_PRICES.promocional,
      dueDate: today,
      paymentDate: name === 'PAYMENT_CONFIRMED' ? today : null,
      ...over,
    },
  })!
}

/** The receiver's half: store the envelope, then apply it, in one transaction. */
async function deliver(name: string, over: Record<string, unknown> = {}) {
  const parsed = await event(name, over)
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

/** Today in the **product's** clock, read from the database rather than guessed. */
async function brtToday(): Promise<string> {
  const found = await db().execute<{ today: string }>(sql`
    select (now() at time zone 'America/Sao_Paulo')::date::text as today
  `)
  return found.rows[0].today
}

/**
 * Subscribe and pay, which is the state production actually produces.
 *
 * The subscription is created with a **same-day** due date — that is what
 * `startCheckout` asks Asaas for — and the payment settles it, so
 * `next_charge_on` is the day of the charge that was just paid until Asaas
 * generates month 2. Several cases below depend on exactly that, and the
 * fixture that supplied a due date a month out is why they were missing.
 */
async function subscribedAndPaid(seat: number): Promise<number> {
  const userId = await makeUser({ seat })
  const { client } = stubClient(await firstSubscribeReplies('https://sandbox.asaas.com/i/first'))
  await startCheckout(userId, { client })
  const applied = await deliver('PAYMENT_CONFIRMED')
  expect(applied.outcome, 'the fixture must actually grant').toBe('granted')
  return userId
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
    const { client } = stubClient(await firstSubscribeReplies('https://sandbox.asaas.com/i/one'))
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
    const { client } = stubClient(await firstSubscribeReplies(null))
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
    const first = stubClient(await firstSubscribeReplies('https://sandbox.asaas.com/i/one'))
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
    const { client } = stubClient(await firstSubscribeReplies(null))
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
          { id: `${PAY}_nov`, status: 'PENDING', value: 57, dueDate: '2026-11-17', invoiceUrl: 'https://sandbox.asaas.com/i/nov' },
          { id: PAY, status: 'PENDING', value: 57, dueDate: '2026-10-17', invoiceUrl: 'https://sandbox.asaas.com/i/out' },
        ],
      },
    ])
    const result = await startCheckout(founder, { client })
    expect(result.outcome).toBe('ready')
    if (result.outcome !== 'ready') return
    expect(result.checkoutUrl).toBe('https://sandbox.asaas.com/i/out')
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
    const { client } = stubClient(await firstSubscribeReplies('https://sandbox.asaas.com/i/one'))
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
    // The second event must not change the plan either — "granted once" is
    // about access, not only about the claim row.
    expect(await planOf(userId)).toBe('promocional')

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
    // The charge's own due date + `PROMO.months`, both read rather than typed:
    // the due date is today in BRT (the stub echoes what `startCheckout` asked
    // for, as Asaas does) and the month count is `docs/product.json`'s.
    const today = await brtToday()
    const expected = new Date(`${today}T00:00:00Z`)
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

  /**
   * **A partial refund is not the loss of a month.**
   *
   * `PAYMENT_PARTIALLY_REFUNDED` was in the revoking set and the revoke path
   * is unconditional, so a founder refunded the R$ 1,92 acquirer fee that
   * `docs/product.json` describes would have lost the whole plan. Review found
   * it, and found that the test which claimed to cover this sent
   * `PAYMENT_REFUNDED` — a *full* refund, with a second month already paid —
   * so the partial event was never exercised at all. The arithmetic that would
   * handle it properly is card **F13**; recording it is the safe half.
   */
  it('records a partial refund and leaves the plan alone', async () => {
    const userId = await subscribed()
    await deliver('PAYMENT_CONFIRMED')

    const applied = await deliver('PAYMENT_PARTIALLY_REFUNDED', {
      suffix: 'pr',
      status: 'PARTIALLY_REFUNDED',
    })
    expect(applied.outcome).toBe('recorded')
    expect(await planOf(userId)).toBe('promocional')
    const row = await readSubscription(userId)
    if (row.state !== 'found') throw new Error('subscription vanished')
    expect(row.subscription.status).toBe('active')
  })

  it('does not revoke on the news that a chargeback is being reversed', async () => {
    // `PAYMENT_AWAITING_CHARGEBACK_REVERSAL` means the money is coming back to
    // us. Taking access away on it is backwards; the dispute events still do.
    const userId = await subscribed()
    await deliver('PAYMENT_CONFIRMED')
    const applied = await deliver('PAYMENT_AWAITING_CHARGEBACK_REVERSAL', {
      suffix: 'rev',
      status: 'AWAITING_CHARGEBACK_REVERSAL',
    })
    expect(applied.outcome).toBe('recorded')
    expect(await planOf(userId)).toBe('promocional')
  })

  /**
   * **`next_charge_on` may never walk backwards.**
   *
   * The first version excluded only the settled statuses, so a refunded charge
   * — whose `entitled_at` the revoke path had just nulled — re-entered the set
   * and dragged the column onto its own past due date. Three readers go wrong
   * at once, and the worst is silent: the worker's reminder matches
   * `next_charge_on = today + 3` by exact equality, so a stale value means the
   * next charge arrives with **no warning** while the sweep logs zero due and
   * looks healthy. That reminder is a clause of the contract.
   */
  it('keeps next_charge_on out of the past after a refund', async () => {
    await subscribed()
    await deliver('PAYMENT_CONFIRMED')
    // A second month, scheduled and unpaid: this is what "next" means.
    await deliver('PAYMENT_CREATED', {
      suffix: 'm2',
      id: `${PAY}_m2`,
      status: 'PENDING',
      dueDate: '2027-06-17',
      paymentDate: null,
    })
    await deliver('PAYMENT_REFUNDED', { suffix: 'r1', status: 'REFUNDED' })

    const row = await db().execute<{ next_charge_on: string | null }>(sql`
      select next_charge_on::text as next_charge_on from subscriptions
       where asaas_subscription_id = ${SUB}
    `)
    // The scheduled future charge, not the refunded one's due date.
    expect(row.rows[0].next_charge_on).toBe('2027-06-17')
  })

  /**
   * **The checkout link follows the charge that is actually payable.**
   *
   * It used to be written once, by `startCheckout`, so the plan screen handed
   * an overdue subscriber the **month-1 invoice** — settled, or expired and
   * regenerated by Asaas. A subscriber who went overdue in month 3, which is
   * exactly the state terms §7's grace period is about, had a dead link and no
   * way to pay before suspension. Review found it, and found that
   * `plan-view.test.tsx` asserted the dead link as correct behaviour.
   */
  it('points the checkout link at the newest unpaid invoice', async () => {
    const userId = await subscribed()
    await deliver('PAYMENT_CONFIRMED')

    await deliver('PAYMENT_CREATED', {
      suffix: 'm2url',
      id: `${PAY}_m2`,
      status: 'PENDING',
      dueDate: '2027-07-17',
      paymentDate: null,
      invoiceUrl: 'https://sandbox.asaas.com/i/month-two',
    })

    const row = await readSubscription(userId)
    if (row.state !== 'found') throw new Error('subscription vanished')
    expect(row.subscription.checkoutUrl).toBe('https://sandbox.asaas.com/i/month-two')
  })

  it('does not point the link at a refunded charge', async () => {
    // A refunded invoice is not a receipt and not payable: it is nothing. The
    // first version of the guard was "not settled", which would have pointed
    // the pay-now button at it.
    await subscribed()
    await deliver('PAYMENT_CONFIRMED')
    await deliver('PAYMENT_REFUNDED', {
      suffix: 'rf',
      status: 'REFUNDED',
      invoiceUrl: 'https://sandbox.asaas.com/i/refunded',
    })
    const row = await db().execute<{ checkout_url: string | null }>(sql`
      select checkout_url from subscriptions where asaas_subscription_id = ${SUB}
    `)
    expect(row.rows[0].checkout_url).not.toBe('https://sandbox.asaas.com/i/refunded')
  })

  /**
   * **A webhook cannot repoint a subscriber's payment link at another host.**
   *
   * `checkout_url` is `redirect()`ed to by `goToCheckout` and rendered as the
   * pay-now `href`, so an attacker holding `ASAAS_WEBHOOK_TOKEN` could have
   * sent a `PAYMENT_CREATED` carrying their own URL and had the plan screen
   * send a subscriber there to type card or Pix details. `webhook.ts` said *"a
   * forged body cannot invent a subscriber"*, which was true and not the whole
   * bound.
   *
   * The unit assertions are in `client.test.ts`'s *invoice URLs*; this pins the
   * **result** — the column is not changed — which is the thing that matters
   * and the thing a validator could be bypassed without changing.
   */
  it('refuses a checkout link that is not an Asaas invoice', async () => {
    const userId = await subscribed()
    await deliver('PAYMENT_CREATED', {
      suffix: 'evil',
      id: `${PAY}_evil`,
      status: 'PENDING',
      dueDate: '2027-08-17',
      paymentDate: null,
      invoiceUrl: 'https://asaas.com.evil.test/i/pay-me',
    })
    const row = await readSubscription(userId)
    if (row.state !== 'found') throw new Error('subscription vanished')
    // Unchanged: still the invoice `startCheckout` read from Asaas itself.
    expect(row.subscription.checkoutUrl).toBe('https://sandbox.asaas.com/i/one')
  })

  it('does not replace the link with a settled invoice', async () => {
    // A paid charge's invoice is a receipt. The screen does not offer it for an
    // active subscription, and the next PAYMENT_CREATED replaces it anyway.
    const userId = await subscribed()
    await deliver('PAYMENT_CONFIRMED', { invoiceUrl: 'https://sandbox.asaas.com/i/receipt' })
    const row = await readSubscription(userId)
    if (row.state !== 'found') throw new Error('subscription vanished')
    expect(row.subscription.checkoutUrl).toBe('https://sandbox.asaas.com/i/one')
  })

  it('does not walk a settled payment status backwards', async () => {
    // Asaas does not guarantee ordering, and a PAYMENT_CREATED arriving after
    // PAYMENT_CONFIRMED carries a different event id, so nothing upstream
    // dedupes it. Overwriting unconditionally corrupted the ledger and the
    // screen's last-payment line.
    const userId = await subscribed()
    await deliver('PAYMENT_CONFIRMED')
    await deliver('PAYMENT_CREATED', { suffix: 'late', status: 'PENDING', paymentDate: null })

    const row = await db().execute<{ status: string }>(sql`
      select status from subscription_payments where asaas_payment_id = ${PAY}
    `)
    expect(row.rows[0].status).toBe('CONFIRMED')
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
    /**
     * **The day, not merely "a day".**
     *
     * `expect(ends_on).not.toBeNull()` is all this asserted, and *yesterday*
     * satisfies it — which is what `endSubscription` wrote. It carried
     * `coalesce(ends_on, next_charge_on - 1, today)`, the two-line version
     * review had already corrected in `cancelSubscription`, and this is the
     * month-1 fixture: the only payment is the one just settled, so
     * `next_charge_on` is **today** and `next_charge_on - 1` is yesterday.
     * `expire_subscriptions` then drops a paying founder to Básico the next
     * morning, and `readSubscription` filters the row out so the screen offers
     * to sell them the plan they are paying for.
     *
     * §4b's "the test exercised the unit, not the path", one step in from the
     * fixture defect this file already documents. Asserting the date is what
     * makes the two paths provably agree.
     */
    const today = await brtToday()
    expect(
      row.rows[0].ends_on! >= today,
      `ends_on ${row.rows[0].ends_on} must not be before today ${today}`,
    ).toBe(true)
    const expected = new Date(`${today}T00:00:00Z`)
    expected.setUTCMonth(expected.getUTCMonth() + 1)
    expected.setUTCDate(expected.getUTCDate() - 1)
    expect(row.rows[0].ends_on).toBe(expected.toISOString().slice(0, 10))
    expect(await planOf(userId)).toBe('promocional')
  })

  /**
   * **A grant must leave no `ends_on` behind, because F4's sweep reads that
   * column to decide who gets a reminder.**
   *
   * `charge_reminder`'s `DUE_SQL` requires `s.ends_on is null`. A subscription
   * that was ended and then restored by the next month's payment kept its old
   * date, so the account was charged every month and was **permanently
   * invisible** to the 3-day reminder — with the sweep logging `due = 0` and
   * looking perfectly healthy. A clause of terms §7 failing in silence.
   */
  it('clears the end date when a payment brings a subscription back', async () => {
    const userId = await subscribed()
    await deliver('PAYMENT_CONFIRMED')
    // End it, as a console cancel would.
    await db().execute(sql`
      update subscriptions set status = 'canceled', ends_on = (now() at time zone 'America/Sao_Paulo')::date - 40
       where asaas_subscription_id = ${SUB}
    `)
    // ...then put it back the way only a *new* subscription can, so this is the
    // restore case and not the cancelled-boleto case below.
    await db().execute(sql`
      update subscriptions set status = 'pending' where asaas_subscription_id = ${SUB}
    `)
    await deliver('PAYMENT_RECEIVED', { suffix: '2', id: `${PAY}_2` })
    const row = await db().execute<{ status: string; ends_on: string | null }>(sql`
      select status, ends_on::text as ends_on from subscriptions
       where asaas_subscription_id = ${SUB}
    `)
    expect(row.rows[0].status).toBe('active')
    expect(row.rows[0].ends_on).toBeNull()
    expect(await planOf(userId)).toBe('promocional')
  })

  /**
   * **A boleto that settles after a cancel buys a month; it does not undo the
   * cancel.**
   *
   * The flip to `active` had no predicate on `s.status`, so a `canceled` row
   * went straight back to `active`. Auto-renewal is off at Asaas,
   * `expire_subscriptions` requires `canceled` and so no longer matched, and
   * the account kept the paid plan **for ever** — never charged again, and
   * never reminded either. The month the money bought is honoured by moving
   * `ends_on`, which `expire_subscriptions` already knows how to reclaim.
   */
  it('honours a payment that settles after a cancel without reviving the subscription', async () => {
    const userId = await subscribed()
    await db().execute(sql`
      update subscriptions set status = 'canceled',
             ends_on = (now() at time zone 'America/Sao_Paulo')::date
       where asaas_subscription_id = ${SUB}
    `)
    const applied = await deliver('PAYMENT_CONFIRMED')
    expect(applied.outcome).toBe('granted')
    const row = await db().execute<{ status: string; ends_on: string | null }>(sql`
      select status, ends_on::text as ends_on from subscriptions
       where asaas_subscription_id = ${SUB}
    `)
    // Still cancelled: the metric and the column must say the same thing.
    expect(row.rows[0].status).toBe('canceled')
    // And the month it bought is covered, so `expire_subscriptions` waits.
    const today = await brtToday()
    expect(
      row.rows[0].ends_on! > today,
      `ends_on ${row.rows[0].ends_on} must be after today ${today}`,
    ).toBe(true)
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

  it('sets the last paid day to the day before the next charge Asaas scheduled', async () => {
    // Terms §8's Prime model, and `billing.cancel.untilWhen` is the approved
    // sentence that states it.
    const userId = await makeUser({ seat: 2 })
    const { client } = stubClient(await firstSubscribeReplies('https://sandbox.asaas.com/i/first', '2026-11-17'))
    await startCheckout(userId, { client })

    const result = await cancelSubscription(userId)
    expect(result.cancelled).toBe(true)
    expect(result.endsOn).toBe('2026-11-16')
  })

  /**
   * **The defect this test exists for, and the reason the one above could not
   * see it.**
   *
   * The fixture above supplies `nextDueDate: '2026-11-17'` for a subscription
   * created *today*, which Asaas will never return: `startCheckout` asks for a
   * same-day due date, so a real `next_charge_on` is **today**. This case
   * builds the state production actually produces — subscribe, pay, cancel —
   * and the old arithmetic (`next_charge_on - 1`) made `ends_on` **yesterday**,
   * so `expire_subscriptions` dropped a founder to Básico the next morning,
   * days into a month they had paid for.
   *
   * Review found it. The fixture handed the code the one value that made the
   * arithmetic look right, which is §4b's *"a test that required its own bug
   * to pass"*, one step removed.
   *
   * **And this test then found the same defect a layer deeper.** Written
   * against a stub whose `dueDate` still defaulted to the constant
   * `'2026-10-17'`, it failed on its own precondition — `next_charge_on` was
   * the constant, not today — which is why {@link firstSubscribeReplies} now
   * echoes the date `startCheckout` asked for, as Asaas does. A fixture that
   * answers a calendar constant will keep producing this class of bug for as
   * long as it is allowed to.
   */
  it('honours the month a payment bought, even before Asaas schedules the next charge', async () => {
    const userId = await subscribedAndPaid(2)

    const today = await brtToday()
    const before = await db().execute<{ next_charge_on: string }>(sql`
      select next_charge_on::text as next_charge_on from subscriptions
       where user_id = ${userId}::bigint
    `)
    // The precondition that makes this the real case: `next_charge_on` is the
    // charge that was just **paid**, because Asaas has not generated month 2.
    expect(before.rows[0].next_charge_on).toBe(today)

    const result = await cancelSubscription(userId)
    expect(result.cancelled).toBe(true)
    // One month from the charge's due date, minus a day — not yesterday.
    expect(result.endsOn).not.toBeNull()
    expect(result.endsOn! > today, `ends_on ${result.endsOn} must be after ${today}`).toBe(true)
    const expected = new Date(`${today}T00:00:00Z`)
    expected.setUTCMonth(expected.getUTCMonth() + 1)
    expected.setUTCDate(expected.getUTCDate() - 1)
    expect(result.endsOn).toBe(expected.toISOString().slice(0, 10))
  })

  it('never ends a subscription before today, whatever the dates say', async () => {
    // The floor. A cancel cannot retroactively end access that has not ended,
    // and a subscription that has never been paid has no period to honour.
    const userId = await makeUser({ seat: 11 })
    const { client } = stubClient(await firstSubscribeReplies(null))
    await startCheckout(userId, { client })

    const result = await cancelSubscription(userId)
    expect(result.endsOn).toBe(await brtToday())
  })

  /**
   * **A cancelled subscription whose paid period has not run out is not "no
   * subscription".**
   *
   * `readSubscription` filtered to the live statuses, so the screen saw
   * `{ state: 'none' }` — and `billing.status.cancelled`,
   * `billing.cancel.untilWhen` and the whole cancelled branch of
   * `plan-view.tsx` were **unreachable in production**: three approved strings
   * rendering nowhere. Worse, the post-cancel banner said *"sua conta está no
   * plano Básico"* while `users.plan` was still `promocional`, and the next
   * page load offered to sell them a subscription again with nothing saying
   * they kept the paid plan until the end of the month.
   *
   * The component test passed a `canceled` subscription straight in; nothing
   * asked whether the page could produce that prop. Review found it, and named
   * it as §4b's documented pattern word for word.
   */
  it('keeps showing a cancelled subscription until its paid period runs out', async () => {
    const userId = await subscribedAndPaid(12)
    const cancelled = await cancelSubscription(userId)
    expect(cancelled.cancelled).toBe(true)

    const found = await readSubscription(userId)
    expect(found.state).toBe('found')
    if (found.state !== 'found') return
    expect(found.subscription.status).toBe('canceled')
    expect(found.subscription.endsOn).toBe(cancelled.endsOn)
  })

  it('stops showing it once that period has passed', async () => {
    // By then `expire_subscriptions` has dropped the plan, and a Básico reader
    // must not be told they still have a subscription.
    const userId = await subscribedAndPaid(13)
    await cancelSubscription(userId)
    await db().execute(sql`
      update subscriptions
         set ends_on = (now() at time zone 'America/Sao_Paulo')::date - 1
       where user_id = ${userId}::bigint
    `)
    expect(await readSubscription(userId)).toEqual({ state: 'none' })
  })

  it('prefers a live subscription over a cancelled one', async () => {
    // Somebody who cancelled and subscribed again has both rows, and the live
    // one is the current fact.
    const userId = await subscribedAndPaid(14)
    await cancelSubscription(userId)
    const again = stubClient([
      { data: [{ id: CUS }] },
      { data: [] },
      { id: `${SUB}_b`, status: 'ACTIVE', nextDueDate: '2027-03-17' },
      { data: [{ id: `${PAY}_b`, status: 'PENDING', value: 57, dueDate: '2027-03-17', invoiceUrl: 'https://sandbox.asaas.com/i/b' }] },
    ])
    await startCheckout(userId, { client: again.client })

    const found = await readSubscription(userId)
    expect(found.state).toBe('found')
    if (found.state !== 'found') return
    expect(found.subscription.status).toBe('pending')
    expect(found.subscription.asaasSubscriptionId).toBe(`${SUB}_b`)
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
    const first = stubClient(await firstSubscribeReplies('https://sandbox.asaas.com/i/first'))
    await startCheckout(userId, { client: first.client })
    await cancelSubscription(userId)

    const second = stubClient([
      { data: [{ id: CUS }] },
      { data: [] }, //                                  the old subscription is gone at Asaas
      { id: `${SUB}_b`, status: 'ACTIVE', nextDueDate: '2027-01-17' },
      { data: [{ id: `${PAY}_b`, status: 'PENDING', value: 57, dueDate: '2027-01-17', invoiceUrl: 'https://sandbox.asaas.com/i/b' }] },
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
