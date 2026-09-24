import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GET as getTender } from '@/app/api/tenders/[id]/route'
import { GET as readScreening, POST as postScreening } from '@/app/api/tenders/[id]/screening/route'
import { POST as postCnpj } from '@/app/api/radar/cnpj/route'
import { sql } from 'drizzle-orm'
import { closeDb, db, pool, type Transaction } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import type {
  CnpjResponse,
  ScreeningReadResponse,
  ScreeningResponse,
  TenderResponse,
} from '@/lib/radar/contract'
import { resetRateLimits } from '@/lib/rate-limit'
import { licitaquiAdapter } from './adapter'
import { SESSION_COOKIE } from './config'
import { linkFounderSeat, MAX_SEAT } from './founder-seat'
import { readSessionUser } from './session'
import { VISITOR_COOKIE } from '@/lib/radar/visitor'

/**
 * U1's acceptance criteria, against the real database and the real routes:
 *
 * > Quota tests (visitor, Básico) pass; **incognito + same CNPJ still limited**.
 *
 * ## What "still limited" means, exactly
 *
 * Spec §8, and §17's decision 5 with it:
 *
 * > the 3-day rule counts from `visitors.created_at` **and** from the first
 * > search of that CNPJ (decided: per device and per CNPJ), so resetting via
 * > incognito does not reset the CNPJ.
 *
 * It is the **window** that is carried, not the two screenings — the terms say
 * the same thing ("Uso por até 3 dias, contado por aparelho **e** por CNPJ; …;
 * 2 triagens por IA"). Both halves of that "e" matter, and until 2026-09-24
 * only one was implemented: `windowStartedAt` keyed on the CNPJ alone, so the
 * clock came with the company no matter whose browser asked. The pair of tests
 * below pins the rule §17 actually wrote — same device, new cookie jar: still
 * refused; different device, same company: its own three days.
 *
 * ## The routes, not the libraries
 *
 * Every assertion drives a route handler, so Zod, the rate limiter, the cookie,
 * the session lookup, the `plan_limits` read and the `usage` transaction all
 * take part. A test of `spend()` alone would have passed on the day this card
 * shipped `withFiles: false` to signed-in users.
 *
 * ## Isolation
 *
 * Own `RUN_ID`, generated per Vitest process and never a per-task constant
 * (CLAUDE.md): two concurrent runs of this file must not delete each other's
 * users, visitors or tenders. Every row written here is reachable from one of
 * four run-scoped keys and `cleanup()` deletes exactly those. No predicate in
 * this file looks at an age, so there is nothing for a cross-run sweep to get
 * wrong.
 *
 * Skips without a database, so `pnpm test` stays green in CI, which has no
 * secrets.
 */

const url = testDatabaseUrl('TEST_DATABASE_URL_U1') ?? testDatabaseUrl()
const suite = url ? describe : describe.skip

const RUN_ID = randomUUID().replace(/-/g, '').slice(0, 8)
const RUN_NUMBER = Number.parseInt(RUN_ID, 16)

/** 14 digits matching no real agency, so the tender ids are ours. */
const AGENCY_CNPJ = `96${String(RUN_NUMBER).padStart(12, '0')}`.slice(0, 14)

/** Companies must pass `normaliseCnpj`, so the check digits are computed. */
function withCheckDigits(base: string): string {
  const digit = (slice: string): number => {
    let weight = slice.length - 7
    let sum = 0
    for (const character of slice) {
      sum += Number(character) * weight
      weight -= 1
      if (weight < 2) weight = 9
    }
    const remainder = sum % 11
    return remainder < 2 ? 0 : 11 - remainder
  }
  const first = digit(base)
  return `${base}${first}${digit(`${base}${first}`)}`
}

/** The company the "incognito" pair both search. */
const SHARED_CNPJ = withCheckDigits(`64${String(RUN_NUMBER).padStart(10, '0')}`.slice(0, 12))
/** A second company, for the tests that must not inherit an aged window. */
const FRESH_CNPJ = withCheckDigits(`63${String(RUN_NUMBER).padStart(10, '0')}`.slice(0, 12))

const EMAIL = (what: string) => `u1-${RUN_ID}-${what}@example.test`

const TENDERS = [0, 1, 2, 3, 4, 5, 6].map(
  (n) => `${AGENCY_CNPJ}-1-${String(n + 1).padStart(6, '0')}/2026`,
)

// ──────────────────────────────── fixtures ────────────────────────────────

async function seed() {
  for (const cnpj of [SHARED_CNPJ, FRESH_CNPJ]) {
    await pool().query(
      `insert into companies (cnpj, legal_name, main_cnae, size, is_mei, state, city, registration_status)
       values ($1, $2, '4761003', 'ME', false, 'SP', 'São Paulo', 'ATIVA')
       on conflict (cnpj) do nothing`,
      [cnpj, `Empresa U1 ${RUN_ID}`],
    )
  }
  for (const id of TENDERS) {
    await pool().query(
      `insert into tenders (id, agency_cnpj, year, sequence, object, state, city,
                            proposals_close_at, status)
       values ($1, $2, 2026, $3, $4, 'SP', 'São Paulo', now() + interval '20 days', 'aberta')
       on conflict (id) do nothing`,
      [id, AGENCY_CNPJ, TENDERS.indexOf(id) + 1, `Objeto de teste U1 ${RUN_ID}`],
    )
  }
  // One tender with a file, to prove §8's "files only with an account".
  await pool().query(
    `insert into tender_files (tender_id, sequence, title, url)
     values ($1, 1, 'Edital', 'https://pncp.example/edital.pdf')
     on conflict do nothing`,
    [TENDERS[0]],
  )
}

/**
 * Deletes exactly this run's rows and nothing else.
 *
 * Every predicate names a run-scoped key — the e-mail prefix, the two company
 * CNPJs, this run's tender ids, this run's agency. There is deliberately no
 * statement here that deletes "everything that looks like test data": `events`,
 * `jobs` and `usage` are shared with four other suites that may be running in
 * another Vitest worker at this instant, and a broad `delete` is how one suite
 * silently fails another. (`events` is cleared first, because nothing cascades
 * to it — §6.3 gives it no foreign keys.)
 */
async function cleanup() {
  const client = pool()
  const cnpjs = [SHARED_CNPJ, FRESH_CNPJ]

  await client.query(
    `delete from events
      where user_id in (select id from users where email like $1)
         or visitor_id in (select id from visitors where cnpj = any($2::bpchar[]))
         or props->>'tender_id' = any($3::text[])`,
    [`u1-${RUN_ID}-%`, cnpjs, TENDERS],
  )
  await client.query('delete from usage where reference = any($1::text[])', [TENDERS])
  // `usage`, `accounts` and `sessions` cascade from `users` and `visitors`.
  await client.query('delete from users where email like $1', [`u1-${RUN_ID}-%`])
  await client.query('delete from visitors where cnpj = any($1::bpchar[])', [cnpjs])
  await client.query('delete from jobs where key like $1', [`%${AGENCY_CNPJ}%`])
  await client.query('delete from tenders where agency_cnpj = $1', [AGENCY_CNPJ])
  await client.query('delete from companies where cnpj = any($1::bpchar[])', [cnpjs])
}

// ───────────────────────────── request helpers ─────────────────────────────

/**
 * A device: the pair `visitors` fingerprints with (`ip_hash`,
 * `user_agent_hash`).
 *
 * It has to be nameable since 2026-09-24, because the free window is inherited
 * per **device** rather than per CNPJ — so a test about cookie-clearing has to
 * be able to say "same machine, new cookie jar" and "someone else entirely",
 * and the two must behave differently.
 */
type Device = { ip: string; userAgent: string }

/** The same machine across every call, for the incognito half of the test. */
function device(label: string): Device {
  return { ip: `198.51.100.${label.length + 7}`, userAgent: `LicitaQuiTest/${label}` }
}

/**
 * A request with whatever cookies this caller is carrying — or none at all.
 *
 * Without an explicit `as`, every call gets a **random** address, which is what
 * keeps the per-IP rate limiter from confusing two callers for one script. Pass
 * `as` when the test is about the device rather than about the caller.
 */
function request(
  cookies: Record<string, string> = {},
  body?: unknown,
  as?: Device,
): Request {
  const cookie = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
  return new Request('https://licitaqui.test/api', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': as?.ip ?? `203.0.113.${Math.floor(Math.random() * 250) + 1}`,
      ...(as ? { 'user-agent': as.userAgent } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function params(id: string) {
  return { params: Promise.resolve({ id }) }
}

/** The `lq_visitor` value a route just minted, read off its `Set-Cookie`. */
function visitorCookieFrom(response: Response): string {
  const header = response.headers.get('set-cookie') ?? ''
  const match = header.match(new RegExp(`${VISITOR_COOKIE}=([^;]+)`))
  if (!match) throw new Error('the route did not mint a visitor cookie')
  return match[1]
}

/** A visitor who has searched `cnpj`, as `POST /api/radar/cnpj` makes one. */
async function searchAs(cookies: Record<string, string>, cnpj: string, as?: Device) {
  const response = await postCnpj(request(cookies, { cnpj }, as))
  const body = (await response.json()) as CnpjResponse
  return { response, body }
}

// ──────────────────────── accounts, without Auth.js ────────────────────────

/**
 * A signed-in account, created the way Auth.js creates one.
 *
 * The adapter and the `sessions` row are the real ones — this is the same code
 * path `signIn('google')` runs — so what the routes below read is a genuine
 * session, not a stub. What is skipped is only the round trip to Google, which
 * cannot happen in a test and is the one thing that must be walked by hand.
 */
async function signedIn(what: string, plan = 'basico') {
  const adapter = licitaquiAdapter(db())
  const user = await adapter.createUser!({
    id: '',
    email: EMAIL(what),
    name: `Teste ${what}`,
    emailVerified: null,
  })
  if (plan !== 'basico') {
    await pool().query('update users set plan = $2 where id = $1::bigint', [user.id, plan])
  }
  const sessionToken = randomUUID()
  await adapter.createSession!({
    sessionToken,
    userId: user.id,
    expires: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  })
  return { userId: Number(user.id), cookies: { [SESSION_COOKIE]: sessionToken } }
}

suite('U1 — accounts and quota enforcement (database)', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url
    await cleanup()
    await seed()
  })
  beforeEach(() => {
    resetRateLimits()
  })
  afterAll(async () => {
    await cleanup()
    await closeDb()
  })

  // ─────────────────── the exit criterion, in one test ───────────────────

  describe('incognito + the same CNPJ is still limited', () => {
    it('inherits the three-day clock from the same device, not from the browser', async () => {
      // One machine throughout: same address, same user agent, new cookie jar.
      // Since 2026-09-24 the window is inherited per **device**, so a test
      // about clearing cookies has to hold the device still — with the random
      // address `request()` hands out by default, "incognito" and "a stranger
      // in another city" were indistinguishable, and the rule cannot tell them
      // apart either. The stranger is the test below.
      const machine = device('incognito')

      // 1. A device searches the CNPJ and uses both of its screenings.
      const first = await searchAs({}, SHARED_CNPJ, machine)
      const deviceA = visitorCookieFrom(first.response)
      expect(first.body.state).toBe('ready')
      if (first.body.state !== 'ready') throw new Error('expected ready')
      expect(first.body.visitor).toMatchObject({ expired: false, screeningsUsed: 0 })

      const cookiesA = { [VISITOR_COOKIE]: deviceA }
      expect(
        (await postScreening(request(cookiesA, undefined, machine), params(TENDERS[1]))).status,
      ).toBe(202)
      expect(
        (await postScreening(request(cookiesA, undefined, machine), params(TENDERS[2]))).status,
      ).toBe(202)
      // Two spent: the third is refused on the quota, the ordinary §10 path.
      const spent = await postScreening(request(cookiesA, undefined, machine), params(TENDERS[3]))
      expect(spent.status).toBe(402)

      // 2. Three days pass. (The row is aged rather than the clock advanced —
      //    this is the only way to reach the window's far side in a test.)
      await pool().query(
        "update visitors set created_at = now() - interval '4 days' where cnpj = $1",
        [SHARED_CNPJ],
      )

      // 3. **Incognito.** No cookie whatsoever: a different browser profile, a
      //    cleared jar, a new device. It gets a brand-new `visitors` row with
      //    its own `created_at` of *now* and not one `usage` row to its name.
      const second = await searchAs({}, SHARED_CNPJ, machine)
      const deviceB = visitorCookieFrom(second.response)
      expect(deviceB).not.toBe(deviceA)

      const fresh = await pool().query<{ n: string }>(
        "select count(*) n from usage where visitor_id = $1::uuid and feature = 'screening'",
        [deviceB],
      )
      expect(Number(fresh.rows[0]?.n)).toBe(0)

      // …and it is still refused, because the window it inherited is this
      // machine's. Note *which* refusal: `visitor_expired`, not
      // `quota_exceeded`.
      // Nothing was spent — the clock alone closed the door.
      if (second.body.state !== 'ready') throw new Error('expected ready')
      expect(second.body.visitor).toMatchObject({ expired: true })

      const refused = await postScreening(
        request({ [VISITOR_COOKIE]: deviceB }, undefined, machine),
        params(TENDERS[4]),
      )
      const body = (await refused.json()) as ScreeningResponse
      expect(refused.status).toBe(403)
      if (body.state !== 'error') throw new Error('expected an error')
      expect(body.error).toBe('visitor_expired')

      const after = await pool().query<{ n: string }>(
        "select count(*) n from usage where visitor_id = $1::uuid",
        [deviceB],
      )
      expect(Number(after.rows[0]?.n)).toBe(0)
    }, 120_000)

    /**
     * The other half of decision 5, which the implementation did not have.
     *
     * §17 says the window is counted **"per device and per CNPJ"**. Until
     * 2026-09-24 `windowStartedAt` keyed on the CNPJ alone — `where cnpj = $1`,
     * no device term — so the oldest search of a number by *anybody* became
     * every later visitor's start date. A CNPJ is public and is not owned by
     * whoever typed it first, so that charged the wrong person: an accountant
     * checking a client, a number passed around a WhatsApp group, a founder
     * demoing. Each burned that CNPJ permanently for its real owner.
     *
     * Measured on production the morning founders week opened, the CNPJ used in
     * every demo that week had been first searched three days earlier and was
     * already expired for every new visitor, with two more a day behind it.
     *
     * The test above keeps the abuse case honest — same machine, new cookie
     * jar, still refused. This one is the person the old rule was charging by
     * mistake.
     */
    /**
     * The hole a code review found the same day the fix shipped.
     *
     * The first version required `user_agent_hash` to match as well. The
     * user-agent is a request header the caller chooses, and `hash(null)`
     * returns null — so an empty one switched the CNPJ rule off entirely, and
     * varying the string minted a new device per request. The rule caught
     * nothing a script does while still costing the honest user.
     */
    it('is not defeated by changing or omitting the user agent', async () => {
      const machine = { ip: '198.51.100.77', userAgent: 'LicitaQuiTest/real' }

      const first = await searchAs({}, SHARED_CNPJ, machine)
      expect(first.body.state).toBe('ready')
      await pool().query(
        "update visitors set created_at = now() - interval '4 days' where cnpj = $1",
        [SHARED_CNPJ],
      )

      // Same address, a user-agent the caller made up. Still expired.
      const disguised = await searchAs({}, SHARED_CNPJ, { ...machine, userAgent: 'x1' })
      if (disguised.body.state !== 'ready') throw new Error('expected ready')
      expect(disguised.body.visitor).toMatchObject({ expired: true })

      // Same address, no user-agent at all — the version that switched the
      // whole rule off.
      const bare = await searchAs({}, SHARED_CNPJ, { ...machine, userAgent: '' })
      if (bare.body.state !== 'ready') throw new Error('expected ready')
      expect(bare.body.visitor).toMatchObject({ expired: true })
    }, 120_000)

    it('does not expire a different device that happens to search the same CNPJ', async () => {
      const mine = device('owner')
      const stranger = device('somebody-else-entirely')
      expect(stranger.ip).not.toBe(mine.ip)

      // Somebody searched this company and their window aged out.
      const theirs = await searchAs({}, SHARED_CNPJ, mine)
      expect(theirs.body.state).toBe('ready')
      await pool().query(
        "update visitors set created_at = now() - interval '4 days' where cnpj = $1",
        [SHARED_CNPJ],
      )

      // A different machine, on a different connection, searches the same
      // number for the first time. It is not their clock.
      const fresh = await searchAs({}, SHARED_CNPJ, stranger)
      const cookie = visitorCookieFrom(fresh.response)
      if (fresh.body.state !== 'ready') throw new Error('expected ready')
      expect(fresh.body.visitor).toMatchObject({ expired: false })

      // And they can actually use it — an unexpired window that still refuses
      // would be the same defect wearing a different status code.
      const allowed = await postScreening(
        request({ [VISITOR_COOKIE]: cookie }, undefined, stranger),
        params(TENDERS[5]),
      )
      expect(allowed.status).toBe(202)
    }, 120_000)

    it('does not expire a device that searched a different company', async () => {
      // The rule must bite on the CNPJ, not on the clock alone: a visitor born
      // after the aged one, searching another company, is unaffected.
      const other = await searchAs({}, FRESH_CNPJ)
      if (other.body.state !== 'ready') throw new Error('expected ready')
      expect(other.body.visitor).toMatchObject({ expired: false })
    }, 60_000)
  })

  // ───────────────────────── the visitor, unchanged ─────────────────────────

  describe('the visitor path an account must never become a precondition for', () => {
    it('reads a tender with no cookie at all, and gets the locked block', async () => {
      const response = await getTender(
        new Request('https://licitaqui.test/api'),
        params(TENDERS[0]),
      )
      const body = (await response.json()) as TenderResponse
      expect(response.status).toBe(200)
      if (body.state !== 'ready') throw new Error('expected ready')
      // §8: "files only with an account". `null`, never `[]`.
      expect(body.tender.files).toBeNull()
    })
  })

  // ──────────────────────────── Básico, with an account ────────────────────

  describe('Básico', () => {
    it('gets five screenings a month from plan_limits, not two', async () => {
      const { cookies } = await signedIn('basico')

      const first = await postScreening(request(cookies), params(TENDERS[0]))
      const body = (await first.json()) as ScreeningResponse
      expect(first.status).toBe(202)
      if (body.state !== 'analyzing') throw new Error(`expected analyzing, got ${body.state}`)
      expect(body.quota).toMatchObject({ plan: 'basico', period: 'month', limit: 5, used: 1 })
      // The 3-day banner is a visitor affordance and must be gone.
      expect(body.visitor ?? null).toBeNull()

      // Four more distinct tenders exhaust the month; the sixth is refused.
      for (const id of TENDERS.slice(1, 5)) {
        expect((await postScreening(request(cookies), params(id))).status).toBe(202)
      }
      const refused = await postScreening(request(cookies), params(TENDERS[5]))
      const over = (await refused.json()) as ScreeningResponse
      expect(refused.status).toBe(402)
      if (over.state !== 'error') throw new Error('expected an error')
      expect(over.error).toBe('quota_exceeded')
      expect(over.quota).toMatchObject({ limit: 5, used: 5, left: 0 })
    }, 120_000)

    it('never mints a visitor row for a signed-in user', async () => {
      const { userId, cookies } = await signedIn('no-visitor')
      const response = await postScreening(request(cookies), params(TENDERS[0]))
      expect(response.headers.get('set-cookie')).toBeNull()

      const charged = await pool().query<{ user_id: string | null; visitor_id: string | null }>(
        'select user_id, visitor_id from usage where user_id = $1::bigint',
        [userId],
      )
      expect(charged.rows.length).toBeGreaterThan(0)
      for (const row of charged.rows) expect(row.visitor_id).toBeNull()
    }, 60_000)

    it('has no three-day window to run out of', async () => {
      const { userId, cookies } = await signedIn('no-window')
      // Age everything a visitor of this company could inherit. An account is
      // not a visitor, so none of it applies.
      await pool().query(
        "update visitors set created_at = now() - interval '9 days' where cnpj = $1",
        [SHARED_CNPJ],
      )
      await searchAs(cookies, SHARED_CNPJ)
      const response = await postScreening(request(cookies), params(TENDERS[6]))
      expect(response.status).toBe(202)

      // …and the search was remembered on `users.cnpj` (§6.2), not on a
      // `visitors` row, which is what E1's digest will read.
      const user = await pool().query<{ cnpj: string | null }>(
        'select cnpj from users where id = $1::bigint',
        [userId],
      )
      expect(user.rows[0]?.cnpj?.trim()).toBe(SHARED_CNPJ)
    }, 60_000)

    it('unlocks the edital and its annexes', async () => {
      const { cookies } = await signedIn('files')
      const response = await getTender(request(cookies), params(TENDERS[0]))
      const body = (await response.json()) as TenderResponse
      if (body.state !== 'ready') throw new Error('expected ready')
      expect(body.tender.files).not.toBeNull()
      expect(body.tender.files?.[0]?.url).toBe('https://pncp.example/edital.pdf')
    }, 60_000)

    it('can poll only for a tender it has paid for, same as a visitor', async () => {
      const { cookies } = await signedIn('poll')
      const unpaid = await readScreening(request(cookies), params(TENDERS[1]))
      expect(unpaid.status).toBe(404)

      await postScreening(request(cookies), params(TENDERS[1]))
      const paid = await readScreening(request(cookies), params(TENDERS[1]))
      const body = (await paid.json()) as ScreeningReadResponse
      expect(paid.status).toBe(200)
      if (body.state === 'error') throw new Error('expected pending or ready')
      expect(body.quota.plan).toBe('basico')
      expect(body.visitor ?? null).toBeNull()
    }, 60_000)

    it('keeps one account’s spending out of another’s', async () => {
      const a = await signedIn('sep-a')
      const b = await signedIn('sep-b')
      await postScreening(request(a.cookies), params(TENDERS[0]))

      const response = await postScreening(request(b.cookies), params(TENDERS[1]))
      const body = (await response.json()) as ScreeningResponse
      if (body.state !== 'analyzing') throw new Error(`expected analyzing, got ${body.state}`)
      expect(body.quota.used).toBe(1)
    }, 60_000)
  })

  // ───────────────────────────── the session itself ─────────────────────────

  describe('the session', () => {
    it('is read from the cookie the adapter wrote', async () => {
      const { userId, cookies } = await signedIn('session')
      const found = await readSessionUser(
        `${SESSION_COOKIE}=${cookies[SESSION_COOKIE]}`,
        db(),
      )
      expect(found).toMatchObject({ userId, plan: 'basico', founderSeat: null })
    })

    it('is nobody once it has expired, without deleting the row', async () => {
      const { cookies } = await signedIn('expired')
      const token = cookies[SESSION_COOKIE]
      await pool().query(
        `update sessions set expires = now() - interval '1 hour' where "sessionToken" = $1`,
        [token],
      )
      expect(await readSessionUser(`${SESSION_COOKIE}=${token}`, db())).toBeNull()

      const still = await pool().query('select 1 from sessions where "sessionToken" = $1', [token])
      expect(still.rowCount).toBe(1)

      // …and the caller falls back to being a visitor, not to an error.
      const response = await postScreening(request(cookies), params(TENDERS[0]))
      expect(response.status).toBe(202)
      expect(response.headers.get('set-cookie')).toContain(VISITOR_COOKIE)
    }, 60_000)

    it('is gone after `deleteSession`, which is what signing out does', async () => {
      const { cookies } = await signedIn('signout')
      const token = cookies[SESSION_COOKIE]
      await licitaquiAdapter(db()).deleteSession!(token)
      expect(await readSessionUser(`${SESSION_COOKIE}=${token}`, db())).toBeNull()
    })

    it('finds the same user again through the OAuth account, not a second one', async () => {
      const adapter = licitaquiAdapter(db())
      const user = await adapter.createUser!({
        id: '',
        email: EMAIL('oauth'),
        name: 'Teste OAuth',
        emailVerified: null,
      })
      await adapter.linkAccount!({
        userId: user.id,
        type: 'oidc',
        provider: 'google',
        providerAccountId: `google-${RUN_ID}`,
      })

      const again = await adapter.getUserByAccount!({
        provider: 'google',
        providerAccountId: `google-${RUN_ID}`,
      })
      expect(again?.id).toBe(user.id)

      // A second sign-in with the same address must not make a second row:
      // `users.email` is `citext`, so the case does not matter either.
      const byEmail = await adapter.getUserByEmail!(EMAIL('oauth').toUpperCase())
      expect(byEmail?.id).toBe(user.id)
    })

    it('stores no Google profile photo — nothing shows one (§12)', async () => {
      const adapter = licitaquiAdapter(db())
      const user = await adapter.createUser!({
        id: '',
        email: EMAIL('minimal'),
        name: 'Teste Mínimo',
        emailVerified: null,
        image: 'https://lh3.googleusercontent.com/a/photo',
      })
      expect(user.image).toBeNull()
      const columns = await pool().query<{ column_name: string }>(
        `select column_name from information_schema.columns where table_name = 'users'`,
      )
      const names = columns.rows.map((row) => row.column_name)
      expect(names).not.toContain('image')
      expect(names).not.toContain('emailVerified')
    })
  })

  // ──────────────────────────── the founder seat ────────────────────────────

  /**
   * `founders_list.seat` is **globally unique and only 48 wide**, and task F1's
   * suite fills all 48 of them in its concurrency test. Two suites cannot both
   * own that space, so nothing below is ever committed: the whole block runs
   * inside one transaction that always rolls back. Within it the seat is freed
   * first (invisible to anyone else, restored on rollback), the founder and the
   * account are created against the transaction, and `linkFounderSeat` is
   * exercised exactly as `createUser` calls it.
   *
   * The consequence worth stating: this needs no `cleanup()` at all, because it
   * never writes anything another connection can see.
   */
  describe('the founder seat', () => {
    class Rollback extends Error {}

    async function inRolledBackTransaction(run: (tx: Transaction) => Promise<void>) {
      try {
        await db().transaction(async (tx) => {
          await run(tx)
          throw new Rollback()
        })
      } catch (error) {
        if (!(error instanceof Rollback)) throw error
      }
    }

    /** A seat of this run's own, freed inside the transaction that will undo it. */
    const SEAT = 1 + (RUN_NUMBER % MAX_SEAT)

    async function freeTheSeat(tx: Transaction, seat: number) {
      await tx.execute(sql`update users set founder_seat = null where founder_seat = ${seat}`)
      await tx.execute(sql`delete from founders_list where seat = ${seat}`)
    }

    async function onTheList(tx: Transaction, what: string, seat: number | null) {
      await tx.execute(sql`
        insert into founders_list (name, email, seat, contact_consent)
        values (${`Fundador ${RUN_ID}`}, ${EMAIL(what)}, ${seat}, true)
      `)
    }

    /** `createUser` as Auth.js calls it, against the transaction. */
    async function createUser(tx: Transaction, what: string) {
      const user = await licitaquiAdapter(tx).createUser!({
        id: '',
        email: EMAIL(what),
        name: `Teste ${what}`,
        emailVerified: null,
      })
      return Number(user.id)
    }

    it('is connected to the account created with the same e-mail', async () => {
      await inRolledBackTransaction(async (tx) => {
        await freeTheSeat(tx, SEAT)
        await onTheList(tx, 'founder', SEAT)
        const userId = await createUser(tx, 'founder')

        const row = await tx.execute<{ founder_seat: number | null; plan: string }>(sql`
          select founder_seat, plan from users where id = ${userId}::bigint
        `)
        expect(Number(row.rows[0]?.founder_seat)).toBe(SEAT)
        // The seat is the *right* to the R$ 26 price, not the plan. Billing is
        // F2 at M5; setting `promocional` here would hand 48 people Essencial
        // for free, six weeks before anything can charge them.
        expect(row.rows[0]?.plan).toBe('basico')
      })
    }, 60_000)

    it('records the privacy consent at the moment the account is created (§12)', async () => {
      await inRolledBackTransaction(async (tx) => {
        const userId = await createUser(tx, 'consent')
        const row = await tx.execute<{ privacy_consent_at: string | null }>(sql`
          select privacy_consent_at from users where id = ${userId}::bigint
        `)
        expect(row.rows[0]?.privacy_consent_at).not.toBeNull()
      })
    }, 60_000)

    it('gives no seat to someone on the waitlist, and none to a stranger', async () => {
      await inRolledBackTransaction(async (tx) => {
        await onTheList(tx, 'waitlist', null)
        const waitlisted = await createUser(tx, 'waitlist')
        expect(await linkFounderSeat(waitlisted, tx)).toBeNull()

        const stranger = await createUser(tx, 'stranger')
        expect(await linkFounderSeat(stranger, tx)).toBeNull()
      })
    }, 60_000)

    it('is idempotent, so signing in again cannot move it', async () => {
      await inRolledBackTransaction(async (tx) => {
        await freeTheSeat(tx, SEAT)
        await onTheList(tx, 'repeat', SEAT)
        const userId = await createUser(tx, 'repeat')

        expect(await linkFounderSeat(userId, tx)).toBe(SEAT)
        expect(await linkFounderSeat(userId, tx)).toBe(SEAT)

        const held = await tx.execute<{ n: string }>(sql`
          select count(*) n from users where founder_seat = ${SEAT}
        `)
        expect(Number(held.rows[0]?.n)).toBe(1)
      })
    }, 60_000)

    it('catches up for someone who joined the list after creating the account', async () => {
      await inRolledBackTransaction(async (tx) => {
        await freeTheSeat(tx, SEAT)
        const userId = await createUser(tx, 'late')
        expect(await linkFounderSeat(userId, tx)).toBeNull()

        // …they sign the Offer afterwards, which is the likely order in
        // founders week, and the next sign-in connects it.
        await onTheList(tx, 'late', SEAT)
        expect(await linkFounderSeat(userId, tx)).toBe(SEAT)
      })
    }, 60_000)

    it('refuses a seat another account already holds', async () => {
      await inRolledBackTransaction(async (tx) => {
        await freeTheSeat(tx, SEAT)
        await onTheList(tx, 'holder', SEAT)
        const holder = await createUser(tx, 'holder')
        expect(await linkFounderSeat(holder, tx)).toBe(SEAT)

        // The same seat offered to a second address. Impossible through the
        // Offer form, which assigns each seat once — but `users.founder_seat`
        // is unique, so the statement must decline rather than raise.
        // (`founders_list.seat` is unique too, hence the hand-off.)
        await tx.execute(sql`
          update founders_list set seat = null where email = ${EMAIL('holder')}
        `)
        await tx.execute(sql`
          insert into founders_list (name, email, seat, contact_consent)
          values (${`Fundador ${RUN_ID}`}, ${EMAIL('impostor')}, ${SEAT}, true)
        `)
        const second = await createUser(tx, 'impostor')
        expect(await linkFounderSeat(second, tx)).toBeNull()

        // The seat stayed where it was.
        const still = await tx.execute<{ id: string }>(sql`
          select id from users where founder_seat = ${SEAT}
        `)
        expect(still.rows).toHaveLength(1)
        expect(Number(still.rows[0]?.id)).toBe(holder)
      })
    }, 60_000)
  })
})
