import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { POST } from '@/app/api/founders/route'
import { GET } from '@/app/api/founders/seats/route'
import { closeDb, pool } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import { resetRateLimits } from '@/lib/rate-limit'
import { FOUNDER_SEATS } from './seats'
import { DUPLICATE_EVENT, EMAIL_JOB_KIND, SIGNUP_EVENT, WELCOME_JOB_KIND } from './signup'

/**
 * The F1 acceptance criterion, run against the real database:
 *
 * > Concurrency test: 60 parallel signups → seats 1..48 unique, 12 on waitlist.
 *
 * It drives the actual route handlers — Zod, rate limit, transaction, events,
 * queue — against `TEST_DATABASE_URL`, which is an isolated Neon database with
 * the migrations already applied. The connection string is resolved
 * programmatically and never printed. Every row these tests create is deleted
 * again, and they refuse to run against a database that holds rows they did not
 * create.
 *
 * Without `TEST_DATABASE_URL` the whole file skips, so `pnpm test` stays green
 * on a machine (or a CI job) with no database.
 */

const url = testDatabaseUrl()
const suite = url ? describe : describe.skip

/** `.invalid` can never be a real domain (RFC 2606), so no real person is mailed. */
const DOMAIN = 'f1.test.licitaqui.invalid'

/** A real, checksum-valid CNPJ (the Banco Central's). The column is not unique. */
const CNPJ = '00.394.429/0001-00'

function body(index: number, overrides: Record<string, unknown> = {}) {
  return {
    name: `Fundador Teste ${index}`,
    email: `f1-${index}@${DOMAIN}`,
    whatsapp: `(11) 9${String(index).padStart(8, '0')}`,
    cnpj: CNPJ,
    sells: 'material de escritório',
    contactConsent: true,
    acceptedTerms: true,
    ...overrides,
  }
}

/** A request that looks like it came from its own visitor, per the rate limiter. */
function request(payload: unknown, address = '198.51.100.1') {
  return new Request('https://licitaqui.test/api/founders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': address },
    body: JSON.stringify(payload),
  })
}

async function cleanup() {
  const ids = (
    await pool().query<{ id: string }>('select id from founders_list where email like $1', [
      `%@${DOMAIN}`,
    ])
  ).rows.map((row) => row.id)

  if (ids.length > 0) {
    await pool().query('delete from jobs where key = any($1::text[])', [
      ids.map((id) => `founders:${id}`),
    ])
    await pool().query(
      "delete from events where (props->>'founders_list_id')::bigint = any($1::bigint[])",
      [ids],
    )
    await pool().query('delete from founders_list where id = any($1::bigint[])', [ids])
  }
}

/**
 * The seat assertions below only mean something on an empty list: seat 1 has to
 * be free for the first signup to take it. Better to fail loudly here than to
 * quietly assert against someone else's rows.
 */
async function expectEmptyList() {
  const { rows } = await pool().query<{ count: string }>('select count(*) from founders_list')
  expect(
    Number(rows[0].count),
    'founders_list must be empty before a seat test — is TEST_DATABASE_URL pointing at a real database?',
  ).toBe(0)
}

async function seatsInDatabase(): Promise<number[]> {
  const { rows } = await pool().query<{ seat: number }>(
    'select seat from founders_list where seat is not null order by seat',
  )
  return rows.map((row) => Number(row.seat))
}

/**
 * The test database is remote: a round trip costs ~200 ms, so 60 transactions
 * queued behind one advisory lock take half a minute end to end. Every one of
 * them holds a pooled connection while it waits, so the pool has to be wide
 * enough for all 60 and the connect/query budgets long enough to outlast the
 * queue — otherwise the test measures the latency of this laptop rather than
 * whether two people can get the same seat. In production (Vercel gru1 next to
 * the Neon in sa-east-1) the same 60 signups are a fraction of a second, which
 * is why the defaults in `lib/db` stay at the §7.2 budget of 15 s / 30 s.
 */
function configurePool() {
  process.env.DATABASE_URL = url
  process.env.DATABASE_POOL_MAX = '60'
  process.env.DATABASE_CONNECT_TIMEOUT_MS = '120000'
  process.env.DATABASE_QUERY_TIMEOUT_MS = '120000'
}

suite('founders signup (database)', () => {
  beforeAll(configurePool)

  beforeEach(async () => {
    await resetRateLimits()
    await cleanup()
  })

  afterAll(async () => {
    await cleanup()
    await closeDb()
  })

  it('seats the first founder, records the consent and queues the welcome', async () => {
    await expectEmptyList()

    const response = await POST(request(body(1, { source: 'instagram_bio' })))
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({
      status: 'seated',
      seat: 1,
      seatsTaken: 1,
      seatsLeft: 47,
    })

    const { rows } = await pool().query(
      'select id, name, email, whatsapp, cnpj, sells, source, seat, contact_consent from founders_list where email = $1',
      [`f1-1@${DOMAIN}`],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: 'Fundador Teste 1',
      whatsapp: '+5511900000001',
      cnpj: '00394429000100',
      sells: 'material de escritório',
      source: 'instagram_bio',
      seat: 1,
      contact_consent: true,
    })

    const events = await pool().query<{ name: string; props: Record<string, unknown> }>(
      "select name, props from events where (props->>'founders_list_id')::bigint = $1",
      [rows[0].id],
    )
    expect(events.rows).toHaveLength(1)
    expect(events.rows[0].name).toBe(SIGNUP_EVENT)
    expect(events.rows[0].props).toMatchObject({
      seat: 1,
      contact_consent: true,
      terms_accepted: true,
      source: 'instagram_bio',
    })
    expect(events.rows[0].props.privacy_consent_at).toEqual(expect.any(String))
    // §12: no personal data in an analytics row.
    const serialised = JSON.stringify(events.rows[0].props)
    expect(serialised).not.toContain('@')
    expect(serialised).not.toContain('+55')
    expect(serialised).not.toContain('00394429000100')

    const jobs = await pool().query<{ kind: string; priority: number; payload: Record<string, unknown> }>(
      'select kind, priority, payload from jobs where key = $1 order by kind',
      [`founders:${rows[0].id}`],
    )
    // Both channels, the same key, the same statement (E6): `jobs_dedupe` is
    // unique on (kind, key), not on key alone, so both rows coexist.
    expect(jobs.rows).toHaveLength(2)
    expect(jobs.rows.map((row) => row.kind)).toEqual([EMAIL_JOB_KIND, WELCOME_JOB_KIND])
    for (const job of jobs.rows) {
      expect(job.payload).toMatchObject({
        template: 'founders-welcome',
        founders_list_id: Number(rows[0].id),
        numero_vaga: 1,
      })
    }
  })

  it('seats a founder who left the CNPJ blank', async () => {
    // The case PR #92 shipped and did not cover. `founders_list.cnpj` is
    // nullable and the Zod schema turns blank into `undefined` — but Drizzle
    // **drops an `undefined` embedded value from the template entirely**
    // rather than binding NULL, so the statement became `select $1, $2, $3, ,`
    // and Postgres answered `syntax error at or near ","`. Every signup that
    // left the field blank returned a 500, on a live founders page where the
    // field is labelled "(opcional)".
    //
    // Every fixture in this file passed `cnpj: CNPJ`, and there is no e2e for
    // `/fundadores` at all, so nothing in the suite went near it.
    await expectEmptyList()

    const response = await POST(request(body(1, { cnpj: undefined })))
    expect(response.status, await response.text()).toBe(201)

    const stored = await pool().query<{ cnpj: string | null; seat: number }>(
      'select cnpj, seat from founders_list where email = $1',
      [`f1-1@${DOMAIN}`],
    )
    // Absent, not an empty string in a char(14) column.
    expect(stored.rows[0]?.cnpj).toBeNull()
    expect(Number(stored.rows[0]?.seat)).toBe(1)
  })

  it('answers a repeat signup without taking a second seat or queueing a second message', async () => {
    await expectEmptyList()
    await POST(request(body(2)))

    const again = await POST(request(body(2, { name: 'Outro Nome' }), '198.51.100.2'))
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ status: 'already_registered', seat: 1, position: null })

    const founders = await pool().query('select seat from founders_list where email = $1', [
      `f1-2@${DOMAIN}`,
    ])
    expect(founders.rows).toHaveLength(1)
    expect(await seatsInDatabase()).toEqual([1])

    const jobs = await pool().query('select id from jobs where key = $1', [
      `founders:${(await pool().query('select id from founders_list where email = $1', [`f1-2@${DOMAIN}`])).rows[0].id}`,
    ])
    // One per channel (WhatsApp + e-mail), not two per channel: the repeat
    // submit above must not have queued a second welcome on either.
    expect(jobs.rows).toHaveLength(2)

    // Scoped to this suite's own founder, not `select name from events`.
    // `events` is shared: the Radar suites write `cnpj_searched` and U1's
    // writes `screening_requested` from another Vitest worker at the same
    // moment, and an assertion over the whole table fails on their rows rather
    // than on anything F1 did. Both events F1 writes carry `founders_list_id`
    // in `props` — the same key `cleanup()` above already deletes by.
    const events = await pool().query<{ name: string }>(
      `select e.name from events e
         join founders_list f on f.id = (e.props->>'founders_list_id')::bigint
        where f.email like $1
        order by e.id`,
      [`%@${DOMAIN}`],
    )
    expect(events.rows.map((row) => row.name)).toEqual([SIGNUP_EVENT, DUPLICATE_EVENT])
  })

  it('blocks a second signup that reuses a WhatsApp number under a new e-mail, in any spelling', async () => {
    // The abuse case the audit found: `founders_list.whatsapp` has no unique
    // constraint, so nothing stopped a stranger's number being signed up
    // again and again under throwaway e-mails — each accepted signup queues a
    // real WhatsApp send to that number. This asserts the application-level
    // guard added in `lib/founders/signup.ts`; a migration adding a real
    // constraint is its own, separate PR.
    await expectEmptyList()

    const first = await POST(request(body(4)))
    expect(first.status).toBe(201)
    const firstJson = (await first.json()) as { status: string; seat: number }
    expect(firstJson).toMatchObject({ status: 'seated', seat: 1 })

    // Same digits as body(4)'s WhatsApp number, spelled differently, under a
    // brand-new e-mail, from a different address (not what the per-IP rate
    // limiter is being tested here).
    const attempt = await POST(
      request(
        body(4, {
          email: `f1-4-throwaway@${DOMAIN}`,
          whatsapp: '+55 (11) 9 0000-0004',
        }),
        '198.51.100.4',
      ),
    )
    expect(attempt.status).toBe(200)
    expect(await attempt.json()).toEqual({
      status: 'already_registered',
      seat: firstJson.seat,
      position: null,
    })

    // No second row, no second seat taken, no second job queued.
    const rows = await pool().query<{ id: string; seat: number }>(
      'select id, seat from founders_list where whatsapp = $1',
      ['+5511900000004'],
    )
    expect(rows.rows).toHaveLength(1)
    expect(await seatsInDatabase()).toEqual([1])

    const jobs = await pool().query('select id from jobs where key = $1', [
      `founders:${rows.rows[0].id}`,
    ])
    expect(jobs.rows).toHaveLength(1)

    // Scoped by founders_list_id, per the comment on the repeat-e-mail test
    // above: `events` is shared with other suites running concurrently.
    const events = await pool().query<{ name: string; props: Record<string, unknown> }>(
      `select e.name, e.props from events e
        where (e.props->>'founders_list_id')::bigint = $1
        order by e.id`,
      [rows.rows[0].id],
    )
    expect(events.rows.map((row) => row.name)).toEqual([SIGNUP_EVENT, DUPLICATE_EVENT])
    expect(events.rows[1].props.matched_by).toBe('whatsapp')

    // No throwaway e-mail was seated either.
    const throwaway = await pool().query('select id from founders_list where email = $1', [
      `f1-4-throwaway@${DOMAIN}`,
    ])
    expect(throwaway.rows).toHaveLength(0)
  })

  it('puts founder 49 on the waitlist, in arrival order', async () => {
    await expectEmptyList()
    // Fill all 48 seats in one statement: this test is about seat 49, not about
    // 48 more round trips.
    await pool().query(
      `insert into founders_list (name, email, whatsapp, cnpj, seat, contact_consent)
       select 'Fundador ' || g, 'f1-seed-' || g || '@${DOMAIN}', '+5511999999999', '00394429000100', g, true
         from generate_series(1, $1) g`,
      [FOUNDER_SEATS],
    )

    const first = await POST(request(body(49), '198.51.100.49'))
    expect(first.status).toBe(201)
    expect(await first.json()).toEqual({ status: 'waitlisted', position: 1 })

    const second = await POST(request(body(50), '198.51.100.50'))
    expect(await second.json()).toEqual({ status: 'waitlisted', position: 2 })

    const waitlistJobs = await pool().query<{ kind: string; payload: Record<string, unknown> }>(
      `select kind, payload from jobs where key = 'founders:' ||
         (select id from founders_list where email = $1)
        order by kind`,
      [`f1-49@${DOMAIN}`],
    )
    expect(waitlistJobs.rows.map((row) => row.kind)).toEqual([EMAIL_JOB_KIND, WELCOME_JOB_KIND])
    for (const job of waitlistJobs.rows) {
      expect(job.payload).toMatchObject({
        template: 'founders-waitlist',
        numero_vaga: null,
        posicao_espera: 1,
      })
    }

    // A repeat submit from someone on the waitlist keeps their place.
    const repeat = await POST(request(body(49), '198.51.100.51'))
    expect(await repeat.json()).toEqual({
      status: 'already_registered',
      seat: null,
      position: 1,
    })
  })

  it('reports the live seat count for the offer page grid', async () => {
    await expectEmptyList()
    await POST(request(body(3)))

    const response = await GET(
      new Request('https://licitaqui.test/api/founders/seats', {
        headers: { 'x-forwarded-for': '198.51.100.3' },
      }),
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('s-maxage=60')
    expect(await response.json()).toEqual({ total: 48, taken: 1, left: 47, soldOut: false })
  })

  it('rejects an invalid body before it reaches the database', async () => {
    const response = await POST(
      request({ name: '', email: 'x', whatsapp: '1', cnpj: '1', contactConsent: false }),
    )
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      status: 'error',
      error: 'validation',
      fields: {
        name: 'nameRequired',
        email: 'emailInvalid',
        whatsapp: 'whatsappInvalid',
        cnpj: 'cnpjInvalid',
        contactConsent: 'foundersRequired',
        acceptedTerms: 'termsRequired',
      },
    })
    const { rows } = await pool().query('select count(*) from founders_list')
    expect(Number(rows[0].count)).toBe(0)
  })

  it('rate limits a burst from one address', async () => {
    const address = '198.51.100.200'
    const statuses: number[] = []
    for (let i = 0; i < 8; i += 1) {
      statuses.push((await POST(request(body(100 + i), address))).status)
    }
    expect(statuses.slice(0, 6)).toEqual([201, 201, 201, 201, 201, 201])
    expect(statuses.slice(6)).toEqual([429, 429])

    const last = await POST(request(body(200), address))
    expect(last.headers.get('retry-after')).toBeTruthy()
    // Somebody else is unaffected.
    expect((await POST(request(body(201), '198.51.100.201'))).status).toBe(201)
  }, 60_000)
})

suite('60 parallel signups (F1 acceptance criterion)', () => {
  beforeAll(configurePool)

  afterAll(async () => {
    await cleanup()
    await closeDb()
  })

  it(
    'hands out seats 1..48 exactly once and waitlists the other 12 — twice over',
    async () => {
      // Two rounds in one run: a race that only shows up on the second attempt
      // is still a race, and a single green run proves very little.
      for (const round of [1, 2]) {
        await resetRateLimits()
        await cleanup()
        await expectEmptyList()

        const started = Date.now()
        const responses = await Promise.all(
          Array.from({ length: 60 }, (_, index) =>
            // Each signup is its own person: its own e-mail and its own address,
            // so the per-IP rate limit is not what this test measures.
            POST(request(body(round * 1000 + index), `203.0.113.${index + 1}`)),
          ),
        )
        const payloads = await Promise.all(responses.map((response) => response.json()))
        const elapsed = Date.now() - started

        const statuses = [...new Set(responses.map((response) => response.status))]
        expect(statuses, `every signup must be created; saw ${JSON.stringify(payloads.filter((p) => p.status === 'error'))}`).toEqual([201])

        const seated = payloads.filter((payload) => payload.status === 'seated')
        const waitlisted = payloads.filter((payload) => payload.status === 'waitlisted')

        const seats = seated.map((payload) => payload.seat).sort((a, b) => a - b)
        const positions = waitlisted.map((payload) => payload.position).sort((a, b) => a - b)

        const expected = Array.from({ length: FOUNDER_SEATS }, (_, index) => index + 1)

        // What the API told 60 people...
        expect(seats).toEqual(expected)
        expect(new Set(seats).size).toBe(FOUNDER_SEATS)
        expect(positions).toEqual(Array.from({ length: 12 }, (_, index) => index + 1))

        // ...and what the database actually holds.
        expect(await seatsInDatabase()).toEqual(expected)
        const rows = await pool().query<{ seats: string; waiting: string; total: string }>(
          `select count(seat) as seats,
                  count(*) filter (where seat is null) as waiting,
                  count(*) as total
             from founders_list where email like $1`,
          [`%@${DOMAIN}`],
        )
        expect(rows.rows[0]).toEqual({ seats: '48', waiting: '12', total: '60' })

        // One welcome queued per person per channel, one event per person,
        // no duplicates.
        const jobs = await pool().query<{ count: string }>(
          `select count(*) from jobs
            where kind = $1 and key like 'founders:%'`,
          [WELCOME_JOB_KIND],
        )
        expect(jobs.rows[0].count).toBe('60')

        const emailJobs = await pool().query<{ count: string }>(
          `select count(*) from jobs
            where kind = $1 and key like 'founders:%'`,
          [EMAIL_JOB_KIND],
        )
        expect(emailJobs.rows[0].count).toBe('60')

        const events = await pool().query<{ count: string }>(
          'select count(*) from events where name = $1',
          [SIGNUP_EVENT],
        )
        expect(events.rows[0].count).toBe('60')

        console.log(
          `round ${round}: 60 parallel signups in ${elapsed} ms — ` +
            `seats ${seats[0]}..${seats[seats.length - 1]} (${new Set(seats).size} distinct), ` +
            `${positions.length} waitlisted`,
        )
      }
    },
    300_000,
  )
})
