import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GET as getJob } from '@/app/api/jobs/[id]/route'
import { POST as postCnpj } from '@/app/api/radar/cnpj/route'
import { GET as getTenders } from '@/app/api/radar/tenders/route'
import { GET as getTender } from '@/app/api/tenders/[id]/route'
import { POST as postScreening } from '@/app/api/tenders/[id]/screening/route'
import { cnpjRef, normaliseCnpj } from '@/lib/cnpj'
import { closeDb, db, pool } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import { resetRateLimits } from '@/lib/rate-limit'
import type {
  CnpjResponse,
  JobResponse,
  ScreeningResponse,
  TenderListResponse,
  TenderResponse,
} from './contract'
import { listFreshness } from './tenders'
import {
  cleanupRun,
  insertFixture,
  loadFixtures,
  RUN_AGENCY_CNPJ,
  RUN_COMPANY_CNPJ,
  RUN_EXPIRED_CNPJ,
  RUN_ID,
  type SeedFixture,
} from './fixtures'

/**
 * R1's acceptance criteria, run against the real database:
 *
 * > Contract tests on seed data; stale data served + refresh job enqueued.
 *
 * Both halves are here. The fixtures are the 20 real PNCP payloads
 * `pnpm db:seed` loads (`db/seed/fixtures/pncp/`), re-inserted under a
 * per-run agency so two concurrent runs of this file cannot delete each other's
 * rows — the failure CLAUDE.md warns about and this project has paid for four
 * times. Nothing here is hand-built except the classification `sync_items` has
 * not run to produce.
 *
 * The suite drives the **route handlers**, not the libraries underneath: Zod,
 * the rate limiter, the visitor cookie, the quota transaction and the queue all
 * take part, because a contract test that skipped them would not be testing the
 * contract.
 *
 * `TEST_DATABASE_URL_R1` is task R1's own isolated, migrated database. The
 * connection string is resolved programmatically and never printed. Without it
 * the file skips, so `pnpm test` stays green on a machine with no database.
 *
 * ## No assertion here reads a row this run did not write (card **D54**)
 *
 * `RUN_ID` scopes what this file **writes**, and `cleanupRun` deletes exactly
 * that. Neither can scope what it **reads**, and for a while several assertions
 * below read the whole table: a tender asserted to be on page 1 of 20 of a
 * search filtered by neither agency nor run, a `company_lookup` count over a
 * one-minute wall-clock window, a global `visitors` count, a global
 * `sync_open_tenders` count either side of one request. Each of those is a
 * statement about every other lane's rows as well as this one's, and in the
 * 24 hours to 2026-10-06 they produced red runs in three lanes where nothing
 * was broken — one of which was reported as a defect in the wrong place.
 *
 * The shapes that replaced them, chosen per assertion and argued at each:
 *
 * - **a filter only this run's rows can satisfy** — `TOKEN`, below, for every
 *   list assertion that names one of its own tenders;
 * - **the key or id the thing under test would have used** — for the job a
 *   rejected CNPJ would have enqueued, and for the visitor a mint would leave;
 * - **a watermark** — `max(jobs.id)` before the request, so *any* new job of a
 *   kind is visible without counting the kind over the whole table;
 * - **a window taken from the database clock**, narrowed by every column this
 *   run can account for.
 *
 * What is deliberately *not* done is a blanket weakening, and the §4b review of
 * the first version of this work is the reason the distinction is written down
 * at every one of them: it found three assertions that had come out *narrower*
 * than what they replaced — one of them unable to catch a one-word regression
 * the global count did catch, and two that a single failure would have disarmed
 * for ever. Scoping an assertion and weakening it are one keystroke apart. The
 * lower bounds in the tab counts therefore stay lower bounds, because a foreign
 * row can only raise them; the negatives that scoping made small carry a
 * positive control each; and the one claim that only the *unscoped* list can
 * make is still asserted unscoped, in the direction where a foreign row cannot
 * lie.
 *
 * **Reference data is read, and that is a different thing.** `cnae_segments`
 * (migration 0003) and `plan_limits` (0002) are seeded by migrations and are not
 * rows any run writes, so `soleCnaeFor`, `unmappedCnae` and `planLimit` read them
 * on purpose — and all three fail with a message naming the migration rather than
 * asserting against an empty table. What D54 is about is rows a *run* leaves
 * behind.
 *
 * `plan_limits` used to be the exception, and is card **D64**: its values were
 * pinned here as literals (`limit: 2`, `interval '4 days'`) while
 * `entitlement.db.test.ts` inserts and updates that table. D54 could leave it
 * because the two were on different databases. **That protection is being
 * removed on purpose** — Sci ruled on 2026-10-07 that there is one test database
 * and the rest are dropped (**B31**, recorded in **D63**) — so with one database
 * `RUN_ID` scoping is the only isolation left, and it cannot scope a read. The
 * three literals are now reads; see `planLimit`.
 */

const url = testDatabaseUrl('TEST_DATABASE_URL_R1') ?? testDatabaseUrl()
const suite = url ? describe : describe.skip

/** POC 1's labels, as `tenders.segments` and `cnae_segments.segment` spell them. */
const IT = 'Informática / TI'
const FOOD = 'Alimentos'
const FURNITURE = 'Mobiliário'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * This run's handle **inside the search vector** — unique to the run, and a
 * single lexeme so `websearch_to_tsquery` keeps it (D54).
 *
 * `GET /api/radar/tenders` takes no agency parameter, so there is no way to ask
 * it for "my rows" through `?cnpj=` or `?state=`: the compatible and check
 * groups are an array overlap against 14 shared segment labels, which any row in
 * the table can carry. `?q=` is the one filter a foreign row cannot satisfy, and
 * `scope()` in `tenders.ts` is why it is enough — with a `q` the segment overlap
 * is *replaced* by the tsquery, so the token narrows the rows while the group
 * expression still decides which bucket each one lands in. The grouping under
 * test is untouched; only the universe it runs over is.
 *
 * The same trick as `pagination.db.test.ts` and `sort.db.test.ts`, which state
 * the reason in the same words: a bare CNPJ search also returns rows another run
 * inserted into the same segment. **One difference worth naming**: those two put
 * their token in `object` and let `insertFixture`'s own statement index it, while
 * this one is appended to the vector afterwards, because these fixtures' objects
 * are the real PNCP payloads and the tests read them. So the token here depends
 * on `to_tsvector` and `websearch_to_tsquery` classifying `radarr1<hex>` the same
 * way — they do, through the one `pt_unaccent` configuration both calls name —
 * and on nothing re-running `insertFixture`'s `update … set search` over these
 * rows, which would drop the token. That fails loudly rather than quietly: every
 * `listOwn` positive control stops finding its own tender.
 */
const TOKEN = `radarr1${RUN_ID}`

/**
 * Written to `visitors.ip_hash` on every visitor **this file** creates by hand.
 *
 * Two jobs, both D54's. It gives the "does not mint a visitor" assertion a way
 * to exclude this suite's own rows from a window it cannot otherwise scope — see
 * that test — and it gives `afterAll` a way to delete them: `cleanupRun` deletes
 * visitors by `cnpj`, and `newVisitor(null)` writes none, so those rows have been
 * leaking out of every run of this file. This database was holding **19**
 * visitors nobody owns when this card was written (measured 2026-10-06, R1), and
 * that is one of the ways they get there.
 *
 * The column is free text — `loadOrCreateVisitor` writes a truncated SHA-256 and
 * nothing constrains it — and the value is never compared to a real digest. Each
 * row gets `${VISITOR_MARK}-${id}`; see `newVisitor` for why the mark is per row
 * and not per run.
 */
const VISITOR_MARK = `radarr1-${RUN_ID}`

let fixtures: SeedFixture[] = []
let openTenders: SeedFixture[] = []
let closedTenders: SeedFixture[] = []

/** A CNAE that maps to exactly one segment, so the test company's fits are exact. */
async function soleCnaeFor(segment: string, fit: 'compatible' | 'check'): Promise<string> {
  const found = await pool().query<{ cnae: string }>(
    `select s.cnae from cnae_segments s
      where s.segment = $1 and s.fit = $2
        and (select count(*) from cnae_segments x where x.cnae = s.cnae) = 1
      order by s.cnae limit 1`,
    [segment, fit],
  )
  const cnae = found.rows[0]?.cnae
  if (!cnae) throw new Error(`no single-segment CNAE for ${segment}/${fit} — is migration 0003 applied?`)
  return cnae
}

/**
 * A 7-digit code `cnae_segments` maps to nothing — one of B6's 777 unmapped
 * subclasses. Read rather than hard-coded: a later revision of
 * `db/reference/cnae_segments.csv` could map any particular code and the test
 * would then be measuring the wrong thing silently.
 */
async function unmappedCnae(): Promise<string> {
  const found = await pool().query<{ cnae: string }>(
    `select c.cnae from (
       select lpad(generate_series::text, 7, '0') as cnae from generate_series(1000000, 1000200)
     ) c
      where not exists (select 1 from cnae_segments s where s.cnae = c.cnae)
      order by c.cnae limit 1`,
  )
  const cnae = found.rows[0]?.cnae
  if (!cnae) throw new Error('no unmapped CNAE in 1000000-1000200 — is migration 0003 applied?')
  return cnae
}

/**
 * A `plan_limits` row, read in the same test as the assertion that uses it
 * (card **D64**).
 *
 * ## Why read and not own
 *
 * The other half of D64's remedy — insert a run-scoped plan and assert against
 * that, the way `entitlement.db.test.ts` does — **cannot work for any assertion
 * in this file**, because every one of them goes through a route handler and the
 * route chooses the plan name itself: `POST /api/tenders/:id/screening` looks up
 * `VISITOR_PLAN` (`lib/radar/visitor.ts`) for an anonymous caller, so there is no
 * input that would make it consult `plano-${RUN_ID}`. The alternative — writing
 * `visitor`'s own row — is a run altering migration-seeded reference data in a
 * database every other suite reads, which is the thing `entitlement.db.test.ts`
 * warns against at length in its own header. So: read.
 *
 * ## By its own query, not through `readLimit`
 *
 * The route reads this row with `readLimit`. If the assertion did too, a
 * regression inside that function would move both sides together and the test
 * would stay green — the tautology `keyword-limits.db.test.ts` avoids for the
 * same reason, and it is why the plan and feature names below are plain strings
 * rather than `VISITOR_PLAN` and `FEATURES.*`: the test states the keys, the code
 * under test does not get to agree with itself.
 *
 * Throws naming the migration when the row is absent, like `soleCnaeFor`. That
 * matters more than it looks: `readLimit` reads a missing row as `quantity: 0`,
 * so an unseeded table would otherwise make "the route refused" assertions pass
 * for entirely the wrong reason.
 */
async function planLimit(plan: string, feature: string) {
  const found = await pool().query<{ period: string | null; quantity: number | null }>(
    'select period, quantity from plan_limits where plan = $1 and feature = $2',
    [plan, feature],
  )
  const row = found.rows[0]
  if (!row) throw new Error(`plan_limits has no ${plan}/${feature} row — is migration 0002 applied?`)
  return { period: row.period, quantity: row.quantity === null ? null : Number(row.quantity) }
}

/**
 * The same read, narrowed to a quantity the test can count to — `null` is
 * "unlimited" and `0` is "the plan does not include this", and neither can be
 * exhausted or waited out.
 *
 * **This is the half of the literal worth keeping.** `limit: 2` said two things at
 * once: *the route reports what the table holds* and *the visitor plan is capped
 * at a small number*. Reading the row keeps the first; refusing anything but a
 * countable value keeps the second, without pinning which number it is.
 *
 * Every assertion below that reads `plan_limits` goes through here rather than
 * through `planLimit` directly, and the §4b review of this work is why: the first
 * version used the unguarded read for the `202` quota assertion, which would have
 * stayed green on a visitor plan with `quantity: null` — the one thing `limit: 2`
 * could not miss. Scoping an assertion and weakening it are one keystroke apart
 * (D54), and that is the keystroke.
 */
async function countableLimit(plan: string, feature: string) {
  const row = await planLimit(plan, feature)
  if (row.quantity === null || !Number.isInteger(row.quantity) || row.quantity < 1) {
    throw new Error(
      `plan_limits ${plan}/${feature} is ${row.quantity}; this test needs a countable value of 1 or more`,
    )
  }
  return { period: row.period, quantity: row.quantity }
}

/**
 * Back-dates a visitor to one hour **inside** (`+1`) or one hour **outside**
 * (`-1`) a window of `days` days.
 *
 * ## Which clock, exactly
 *
 * The back-dating arithmetic is the database's, from one `now()`, so the row's
 * age is not a function of this laptop's clock. The **comparison** is not: the
 * route reads `created_at` into a `Date` and `visitorView` measures it against
 * Node's `new Date()`. Both sides are therefore absolute instants, which is why
 * the three-clock problem CLAUDE.md names does not bite here — Portugal and
 * Brasília are a display difference, not an epoch one, and only genuine skew
 * between this machine and Neon could move the answer. An hour is roughly four
 * orders of magnitude more margin than NTP skew, which is why the edge is an
 * hour and not a minute.
 */
async function ageVisitorToWindowEdge(id: string, days: number, hours: 1 | -1) {
  await pool().query(
    `update visitors
        set created_at = now() - ($2::int * interval '1 day') + ($3::int * interval '1 hour')
      where id = $1`,
    [id, days, hours],
  )
}

type CompanyOptions = { mainCnae?: string | null; secondaryCnaes?: string[]; updatedAt?: Date }

async function upsertCompany(options: CompanyOptions = {}) {
  await pool().query(
    `insert into companies (cnpj, legal_name, trade_name, main_cnae, secondary_cnaes,
                            size, is_mei, state, city, registration_status, updated_at)
     values ($1, $2, $3, $4, $5, 'ME', false, 'SP', 'São Paulo', 'ATIVA', coalesce($6::timestamptz, now()))
     on conflict (cnpj) do update set
       main_cnae = excluded.main_cnae,
       secondary_cnaes = excluded.secondary_cnaes,
       updated_at = excluded.updated_at`,
    [
      RUN_COMPANY_CNPJ,
      `EMPRESA TESTE R1 ${RUN_ID} LTDA`,
      `Teste R1 ${RUN_ID}`,
      options.mainCnae ?? null,
      options.secondaryCnaes ?? null,
      options.updatedAt?.toISOString() ?? null,
    ],
  )
}

async function newVisitor(cnpj: string | null = RUN_COMPANY_CNPJ): Promise<string> {
  const id = randomUUID()
  // `ip_hash` carries this run's mark, so these rows can be told apart from a row
  // the product minted and can be deleted in `afterAll` (D54; see `VISITOR_MARK`).
  //
  // **One mark per visitor, not one per run.** `windowStartedAt` treats a shared
  // `ip_hash` as the same device and counts the 3-day window from the earliest
  // row of that (device, CNPJ) pair, which is why the suite has a second company
  // for the test that back-dates one. A run-wide value would switch that rule on
  // for every visitor here at once; a per-row value leaves it exactly where
  // `null` left it — each row its own device — while still being greppable by
  // prefix.
  await pool().query('insert into visitors (id, cnpj, ip_hash) values ($1, $2, $3)', [
    id,
    cnpj,
    `${VISITOR_MARK}-${id}`,
  ])
  return id
}

function cookie(visitorId: string): string {
  return `lq_visitor=${visitorId}`
}

/**
 * A 14-digit CNPJ `normaliseCnpj` refuses, **unique to this run**: this run's own
 * company with its last check digit shifted by one.
 *
 * Unique matters because the job key the route would build from it is
 * `company:<cnpjRef>`, and a key no cleanup pattern covers is a key a single
 * regression poisons for ever. See the test that uses it.
 */
function invalidCnpj(): string {
  return `${RUN_COMPANY_CNPJ.slice(0, 13)}${(Number(RUN_COMPANY_CNPJ[13]) + 1) % 10}`
}

/** Requests always carry a distinct address so the rate limiter stays out of the way. */
let address = 0
function headers(visitorId?: string): HeadersInit {
  address += 1
  const value: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': `203.0.113.${address % 250}`,
  }
  if (visitorId) value.cookie = cookie(visitorId)
  return value
}

async function jobsFor(key: string) {
  const found = await pool().query<{
    id: string
    kind: string
    key: string
    priority: number
    status: string
    payload: Record<string, unknown> | null
  }>('select id, kind, key, priority, status, payload from jobs where key = $1 order by id', [key])
  return found.rows
}

async function clearJobs() {
  await pool().query('delete from jobs where key like $1 or key = $2', [
    `%${RUN_AGENCY_CNPJ}%`,
    `company:${cnpjRef(RUN_COMPANY_CNPJ)}`,
  ])
}

/**
 * Every job on the queue that belongs to this run — the same two key patterns
 * `clearJobs` deletes, read instead of deleted.
 *
 * This is what "the route enqueued nothing" is asserted against (D54). A count
 * of some `kind` over the whole table cannot say who created the row, so one
 * sweep enqueued by anybody in the window reddens a route that did nothing.
 */
async function ourJobs() {
  const found = await pool().query<{ id: string; kind: string; key: string }>(
    'select id, kind, key from jobs where key like $1 or key = $2 order by id',
    [`%${RUN_AGENCY_CNPJ}%`, `company:${cnpjRef(RUN_COMPANY_CNPJ)}`],
  )
  return found.rows
}

async function ageTender(id: string, updatedAt: Date) {
  await pool().query('update tenders set updated_at = $2 where id = $1', [id, updatedAt])
  await pool().query('update tender_items set updated_at = $2 where tender_id = $1', [id, updatedAt])
}

suite('Radar read APIs (database)', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url
    fixtures = loadFixtures()
    const now = Date.now()
    openTenders = fixtures.filter(
      (f) => f.closeAt !== null && new Date(`${f.closeAt}-03:00`).getTime() > now,
    )
    closedTenders = fixtures.filter(
      (f) => f.closeAt !== null && new Date(`${f.closeAt}-03:00`).getTime() <= now,
    )
    await cleanupRun(db())
    for (const fixture of fixtures) await insertFixture(db(), fixture)
    // The run's handle, appended to the vector `insertFixture` built (D54).
    //
    // `object`, `raw` and every column a screen renders are left exactly as PNCP
    // sent them — this adds one lexeme to the index and nothing else — so the
    // assertions that read a tender's own text still read the real payload. What
    // it buys is that `?q=TOKEN` selects this run's 20 rows and no others, which
    // is the only run-scoped filter the route exposes.
    await pool().query(
      `update tenders set search = search || to_tsvector('pt_unaccent', $2)
        where agency_cnpj = $1`,
      [RUN_AGENCY_CNPJ, TOKEN],
    )
  }, 180_000)

  beforeEach(async () => {
    await resetRateLimits()
  })

  afterAll(async () => {
    // The visitors this file creates by hand, which `cleanupRun` cannot reach:
    // it deletes by `cnpj` and `newVisitor(null)` writes none, so those rows have
    // been surviving every run (D54). `usage` goes with them by cascade;
    // `events.visitor_id` is `on delete set null`, which is why those rows are
    // deleted first, the same order `cleanupRun` uses.
    await pool().query(
      'delete from events where visitor_id in (select id from visitors where ip_hash like $1)',
      [`${VISITOR_MARK}-%`],
    )
    await pool().query('delete from visitors where ip_hash like $1', [`${VISITOR_MARK}-%`])
    // And the one job key `cleanupRun` does not know about: the rejected CNPJ's.
    // Nothing creates it unless the validation regresses, and then it should not
    // outlive the run that found it.
    await pool().query('delete from jobs where key = $1', [`company:${cnpjRef(invalidCnpj())}`])
    await cleanupRun(db())
    await closeDb()
  })

  describe('the seed fixtures', () => {
    it('loads the 20 real PNCP tenders and their 940 items', async () => {
      const tenders = await pool().query<{ n: string }>(
        'select count(*) n from tenders where agency_cnpj = $1',
        [RUN_AGENCY_CNPJ],
      )
      const items = await pool().query<{ n: string }>(
        `select count(*) n from tender_items i
          join tenders t on t.id = i.tender_id where t.agency_cnpj = $1`,
        [RUN_AGENCY_CNPJ],
      )
      expect(Number(tenders.rows[0]?.n)).toBe(20)
      expect(Number(items.rows[0]?.n)).toBe(940)
      expect(fixtures.reduce((total, f) => total + f.items, 0)).toBe(940)
    })

    it('keeps PNCP’s naive Brasília time in Brasília', async () => {
      // A naive `08:30` in São Paulo (UTC−3) is `11:30Z`. Cast straight to
      // timestamptz it would be stored as `08:30Z` — every deadline three
      // hours early, on a product that sells "before the deadline".
      //
      // **Stated as the rule, not as a date.** This used to pin the literal
      // `2026-09-28T08:30:00` against `2026-09-28T11:30:00.000Z`, which was
      // exact and also made the test a hostage of the fixture's calendar: the
      // fixtures are now re-dated at load (see `CAPTURED_AT`), so a hardcoded
      // instant would fail for a reason that has nothing to do with time
      // zones. The assertion below is the same rule and cannot drift.
      const fixture = fixtures.find((f) => f.closeAt !== null)
      expect(fixture, 'a fixture with a deadline must exist').toBeTruthy()
      const naive = fixture?.closeAt as string
      const found = await pool().query<{ at: Date }>(
        'select proposals_close_at at from tenders where id = $1',
        [fixture?.id],
      )
      const stored = found.rows[0]?.at.toISOString()
      // Read as Brasília, which is what PNCP means.
      expect(stored).toBe(new Date(`${naive}-03:00`).toISOString())
      // And explicitly *not* read as UTC, which is the bug this guards.
      expect(stored).not.toBe(new Date(`${naive}Z`).toISOString())
    })

    it('builds an accent-insensitive search vector over object and items', async () => {
      // `licitacao` must match `licitação`: the `pt_unaccent` configuration is
      // what makes a Brazilian user's unaccented typing work.
      const found = await pool().query<{ n: string }>(
        `select count(*) n from tenders
          where agency_cnpj = $1 and search @@ websearch_to_tsquery('pt_unaccent', 'aquisicao')`,
        [RUN_AGENCY_CNPJ],
      )
      expect(Number(found.rows[0]?.n)).toBeGreaterThan(0)
    })
  })

  // ─────────────── §3.1: the three states of readOrEnqueue ───────────────

  describe('POST /api/radar/cnpj', () => {
    beforeEach(async () => {
      await pool().query('delete from companies where cnpj = $1', [RUN_COMPANY_CNPJ])
      await clearJobs()
    })

    function request(cnpj: string = RUN_COMPANY_CNPJ, visitorId?: string) {
      return new Request('https://licitaqui.test/api/radar/cnpj', {
        method: 'POST',
        headers: headers(visitorId),
        body: JSON.stringify({ cnpj }),
      })
    }

    it('absent: answers 202 analyzing and queues company_lookup at priority 1', async () => {
      const response = await postCnpj(request())
      const body = (await response.json()) as CnpjResponse

      expect(response.status).toBe(202)
      expect(body.state).toBe('analyzing')

      const queued = await jobsFor(`company:${cnpjRef(RUN_COMPANY_CNPJ)}`)
      expect(queued).toHaveLength(1)
      expect(queued[0]?.kind).toBe('company_lookup')
      expect(queued[0]?.priority).toBe(1)
      expect(queued[0]?.status).toBe('queued')
      // The worker reads the CNPJ from the payload; the key never carries it.
      expect(queued[0]?.payload).toEqual({ cnpj: RUN_COMPANY_CNPJ })
      expect(queued[0]?.key).not.toContain(RUN_COMPANY_CNPJ)
    })

    it('stale: serves the row it has AND queues a refresh — the R1 criterion', async () => {
      const cnae = await soleCnaeFor(IT, 'compatible')
      // §3.2 gives a company 30 days. This one was resolved 31 days ago.
      await upsertCompany({ mainCnae: cnae, updatedAt: new Date(Date.now() - 31 * DAY_MS) })

      const response = await postCnpj(request())
      const body = (await response.json()) as CnpjResponse

      // Served, not withheld: the user sees their company immediately.
      expect(response.status).toBe(200)
      if (body.state !== 'ready') throw new Error(`expected ready, got ${body.state}`)
      expect(body.company.legalName).toContain('EMPRESA TESTE R1')
      expect(body.company.mainCnae).toBe(cnae)
      expect(body.company.segments.map((s) => s.segment)).toContain(IT)

      // …and told it is stale, with the age the screen shows.
      expect(body.freshness.state).toBe('stale')
      expect(body.freshness.ageSeconds).toBeGreaterThan(30 * 24 * 60 * 60)

      // …and the refresh is on the queue, behind the answer, at priority 5.
      const queued = await jobsFor(`company:${cnpjRef(RUN_COMPANY_CNPJ)}`)
      expect(queued).toHaveLength(1)
      expect(queued[0]?.kind).toBe('company_lookup')
      expect(queued[0]?.priority).toBe(5)
    })

    it('stale: a second request de-duplicates onto the one live job', async () => {
      await upsertCompany({
        mainCnae: await soleCnaeFor(IT, 'compatible'),
        updatedAt: new Date(Date.now() - 31 * DAY_MS),
      })

      await postCnpj(request())
      await postCnpj(request())

      expect(await jobsFor(`company:${cnpjRef(RUN_COMPANY_CNPJ)}`)).toHaveLength(1)
    })

    it('fresh: serves the row and queues nothing', async () => {
      await upsertCompany({ mainCnae: await soleCnaeFor(IT, 'compatible') })

      const response = await postCnpj(request())
      const body = (await response.json()) as CnpjResponse

      expect(response.status).toBe(200)
      if (body.state !== 'ready') throw new Error(`expected ready, got ${body.state}`)
      expect(body.freshness.state).toBe('fresh')
      expect(await jobsFor(`company:${cnpjRef(RUN_COMPANY_CNPJ)}`)).toHaveLength(0)
    })

    it('a company with no CNAEs asks for them by hand rather than showing nothing', async () => {
      // `main_cnae is null` is the worker's MANUAL_CNAE_PREDICATE: BrasilAPI
      // has no SLA (§9) and this is the fallback row it leaves behind.
      await upsertCompany({ mainCnae: null })

      const response = await postCnpj(request())
      const body = (await response.json()) as CnpjResponse

      expect(response.status).toBe(200)
      if (body.state !== 'ready') throw new Error(`expected ready, got ${body.state}`)
      expect(body.manualCnae).toBe(true)
      expect(body.company.segments).toEqual([])
    })

    it('tells "both sources said it does not exist" apart from "they were down"', async () => {
      // The worker's STATUS_NOT_FOUND / STATUS_FAILED. The two draw different
      // sentences on the Radar: check the number, or try later.
      await upsertCompany({ mainCnae: null })
      const answers: Record<string, boolean> = {}
      for (const status of ['lookup:not_found', 'lookup:failed']) {
        await pool().query('update companies set registration_status = $1 where cnpj = $2', [
          status,
          RUN_COMPANY_CNPJ,
        ])
        const body = (await (await postCnpj(request())).json()) as CnpjResponse
        if (body.state !== 'ready') throw new Error(`expected ready, got ${body.state}`)
        expect(body.manualCnae).toBe(true)
        answers[status] = body.cnpjNotFound
      }
      expect(answers).toEqual({ 'lookup:not_found': true, 'lookup:failed': false })
    })

    it('mints a visitor cookie and remembers the CNPJ against the device', async () => {
      await upsertCompany({ mainCnae: await soleCnaeFor(IT, 'compatible') })

      const response = await postCnpj(request())
      const setCookie = response.headers.get('set-cookie') ?? ''

      expect(setCookie).toContain('lq_visitor=')
      expect(setCookie).toContain('HttpOnly')
      expect(setCookie).toContain('SameSite=Lax')
      expect(response.headers.get('cache-control')).toBe('private, no-store')

      const visitorId = /lq_visitor=([^;]+)/.exec(setCookie)?.[1]
      const found = await pool().query<{ cnpj: string }>('select cnpj from visitors where id = $1', [
        visitorId,
      ])
      expect(found.rows[0]?.cnpj).toBe(RUN_COMPANY_CNPJ)
    })

    it('rejects a CNPJ whose check digits do not add up, before any job', async () => {
      /*
       * Scoped to the key this input would have produced (D54).
       *
       * This used to count every `company_lookup` created anywhere in the last
       * minute, which is one of the sharpest cases of the defect: a job enqueued
       * by a concurrent suite — or left behind by a run killed within the
       * minute — reddens a validation that worked perfectly, and the failure
       * message points at the CNPJ route.
       *
       * What the test means is *this request enqueued nothing*, and the route's
       * key for a CNPJ is `company:<cnpjRef>` (`lib/radar/company.ts`), so that
       * is the only key a job for this input could appear under.
       *
       * **The rejected CNPJ is derived from this run's own**, rather than being
       * the constant `11111111111111` it used to be, and that is not cosmetic: a
       * constant key is never deleted by anything — `clearJobs` and `cleanupRun`
       * only know this run's patterns — so the first run in which the guard
       * regressed would leave a `queued` row under it for ever, `jobs_dedupe`
       * would refuse every later insert, and the assertion would be satisfied
       * permanently. Found in review before it could happen. Run-scoped, the
       * assertion stays a positive zero that nothing can mask.
       */
      const rejected = invalidCnpj()
      expect(
        normaliseCnpj(rejected),
        'the input must really be invalid, or the 400 below proves nothing',
      ).toBeNull()
      const key = `company:${cnpjRef(rejected)}`

      const response = await postCnpj(request(rejected))
      const body = (await response.json()) as CnpjResponse

      expect(response.status).toBe(400)
      if (body.state !== 'error') throw new Error('expected an error')
      expect(body.error).toBe('validation')
      expect(body.fields?.cnpj).toBe('cnpjInvalid')
      expect(await jobsFor(key)).toHaveLength(0)
      expect(await ourJobs()).toEqual([])
    })
  })

  // ──────────────── the CNAE → segment join, §8's grouping ────────────────

  describe('GET /api/radar/tenders', () => {
    let compatibleTender: SeedFixture
    let checkTender: SeedFixture
    let otherTender: SeedFixture

    beforeAll(async () => {
      expect(
        openTenders.length,
        'the fixtures must still contain open tenders (see CAPTURED_AT in fixtures.ts)',
      ).toBeGreaterThan(2)
      compatibleTender = openTenders[0] as SeedFixture
      checkTender = openTenders[1] as SeedFixture
      otherTender = openTenders[2] as SeedFixture

      // What `sync_items` would have written. The classifier is B3's and is
      // tested there; what this suite tests is the join.
      await pool().query('update tenders set segments = $2 where id = $1', [
        compatibleTender.id,
        [IT],
      ])
      await pool().query('update tenders set segments = $2 where id = $1', [checkTender.id, [FOOD]])
      await pool().query('update tenders set segments = $2 where id = $1', [
        otherTender.id,
        [FURNITURE],
      ])

      // The company: IT through its **main** CNAE, food only through a
      // secondary one. B6's rule caps the second at `check`.
      await upsertCompany({
        mainCnae: await soleCnaeFor(IT, 'compatible'),
        secondaryCnaes: [await soleCnaeFor(FOOD, 'compatible')],
      })
    })

    function request(params: Record<string, string>, visitorId?: string) {
      const search = new URLSearchParams({ cnpj: RUN_COMPANY_CNPJ, ...params })
      return new Request(`https://licitaqui.test/api/radar/tenders?${search}`, {
        headers: headers(visitorId),
      })
    }

    async function list(params: Record<string, string>) {
      const response = await getTenders(request(params))
      const body = (await response.json()) as TenderListResponse
      if (body.state !== 'ready') throw new Error(`expected ready, got ${body.state}`)
      return { response, body }
    }

    /**
     * The same read, over this run's own rows only (D54).
     *
     * Two things are added to the query string. `q` carries `TOKEN`, so no row
     * this suite did not write can be in the answer at all — and when the test
     * is also asking about a search, the token is prepended to it:
     * `websearch_to_tsquery` ands its terms, so `TOKEN informatica` still has to
     * match `informática` through `pt_unaccent` for the row to come back, which
     * is the mechanism those tests exist for.
     *
     * `limit` is `MAX_LIMIT`, and this run inserts 20 tenders, so every row it
     * owns fits on one page — asserted below rather than assumed. That is what
     * turns *"the tender is in the answer"* into a statement about the whole
     * result set instead of about position 1 of 20, which is the assertion shape
     * this card exists to remove.
     *
     * **The conjunction has a trap, and `expectSearchable` is the guard.**
     * `websearch_to_tsquery` silently drops a stopword, and a dropped term in a
     * conjunction leaves the token alone — the row would come back and the test
     * would pass without the search term taking any part. Before the token, a
     * dropped term produced an empty tsquery and no match at all, so the same
     * accident failed loudly. Found in review.
     */
    async function listOwn(params: Record<string, string>) {
      const { q, ...rest } = params
      if (q) await expectSearchable(q)
      const answer = await list({ ...rest, q: q ? `${TOKEN} ${q}` : TOKEN, limit: '50' })
      expect(
        answer.body.nextCursor,
        'this run owns 20 tenders and asked for 50: there can be no second page',
      ).toBeNull()
      return answer
    }

    it('puts a main-CNAE segment in Compatível', async () => {
      // `listOwn`, not `list`: an unfiltered `group=compatible` is page 1 of 20
      // of every row in the table whose segments overlap `Informática / TI`, so
      // anybody's fixture carrying that label could displace this one (D54).
      const { body } = await listOwn({ group: 'compatible' })
      const ids = body.tenders.map((t) => t.id)
      expect(ids).toContain(compatibleTender.id)
      expect(ids).not.toContain(checkTender.id)
      const card = body.tenders.find((t) => t.id === compatibleTender.id)
      expect(card?.matchedSegments).toEqual([
        { segment: IT, fit: 'compatible', fromMainCnae: true, fromSecondaryCnae: false },
      ])
    })

    it('caps a secondary-CNAE segment at Verificar, however the map rates it', async () => {
      // Scoped for the same reason as the test above (D54): `Alimentos` is one
      // of the 14 shared labels and any row may carry it.
      const { body } = await listOwn({ group: 'check' })
      const ids = body.tenders.map((t) => t.id)
      expect(ids).toContain(checkTender.id)
      expect(ids).not.toContain(compatibleTender.id)
      expect(body.tenders.find((t) => t.id === checkTender.id)?.matchedSegments[0]?.fit).toBe('check')
    })

    it('leaves a segment the company has no CNAE for out of both groups', async () => {
      const compatible = await listOwn({ group: 'compatible' })
      const check = await listOwn({ group: 'check' })
      // The positive control each negative needs. Scoping a list down to this
      // run's rows makes it small, and a `not.toContain` over an empty page
      // passes for the wrong reason — the shape §4b keeps finding. These two say
      // the lists are the ones the assertions below are about.
      expect(compatible.body.tenders.map((t) => t.id)).toContain(compatibleTender.id)
      expect(check.body.tenders.map((t) => t.id)).toContain(checkTender.id)
      expect(compatible.body.tenders.map((t) => t.id)).not.toContain(otherTender.id)
      expect(check.body.tenders.map((t) => t.id)).not.toContain(otherTender.id)

      /*
       * And once **unscoped**, because scoping moved the reason (D54, review).
       *
       * With a `q`, `scope()` swaps the segment overlap for the tsquery, so above
       * this tender is in the universe and absent only because `groupExpression`
       * labels it `keyword`. Without a `q` it is not on the Radar **at all**,
       * which is the stronger claim `tenders.ts` makes — *"only tenders the
       * company's CNAEs reach"* — and the only other assertion in this file that
       * still covers it is `counts.keyword === 0`.
       *
       * Safe unscoped because the direction is safe: a foreign row can add rows
       * to this page but can never put *this* id on it. Unlike a `toContain`,
       * this negative cannot be displaced.
       */
      const unfiltered = await list({ group: 'compatible' })
      expect(unfiltered.body.tenders.map((t) => t.id)).not.toContain(otherTender.id)
    })

    it('finds an unmatched tender by keyword, accents and all', async () => {
      /*
       * This is the assertion D54 is named after, and it had two problems.
       *
       * It asserted that the tender was on **page 1 of 20** of a search filtered
       * by neither agency nor run, so any row anywhere in `tenders` carrying the
       * same word displaced it — measured at 1 failure in 3 against the orphaned
       * fixtures this database held on 2026-10-06. `listOwn` sends the run token
       * with the word, and `websearch_to_tsquery` ands them, so the row still has
       * to match the unaccented word to come back: the mechanism is unchanged and
       * the universe is this run's 20 rows.
       *
       * And the word it picked was the longest one — `componentes`, which carries
       * no accent at all, so *"accents and all"* was tested by nothing. The word
       * is now the longest **accented** one (`informática` → `informatica`), and
       * the assertion that it differs from its own unaccented form is what keeps
       * that true if the fixtures ever change.
       */
      const word = await keywordFrom(otherTender)
      const { body } = await listOwn({ group: 'keyword', q: unaccent(word) })
      expect(body.tenders.map((t) => t.id)).toContain(otherTender.id)
      expect(body.tenders.find((t) => t.id === otherTender.id)?.group).toBe('keyword')
    })

    it('counts every group under the same filters, for the tabs', async () => {
      /*
       * The one list read here that is deliberately **not** scoped, because
       * scoping it would destroy what it measures (D54).
       *
       * `countGroups` runs over the same `scope()` as the page, and with no `q`
       * that scope is the segment overlap — which is the condition this test is
       * about. Sending the run token would replace it with the tsquery and the
       * keyword group would stop being empty, so the assertion would no longer be
       * the one in its name.
       *
       * It is safe unscoped, which is a property of the three assertions rather
       * than of the data: the first two are **lower bounds** this run's own rows
       * satisfy, and a foreign row can only raise a count, never lower it. The
       * third is structural — with no search term `scope()` adds no tsquery
       * condition at all, so nothing can land in `keyword` whatever the table
       * holds.
       */
      const { body } = await list({ group: 'compatible' })
      expect(body.counts.compatible).toBeGreaterThanOrEqual(1)
      expect(body.counts.check).toBeGreaterThanOrEqual(1)
      // No search term: the keyword group is empty by construction.
      expect(body.counts.keyword).toBe(0)
    })

    it('filters by state and never returns a closed tender by default', async () => {
      // Both halves scoped (D54). `ZZ` is not a UF, but it is also not reserved:
      // a foreign fixture using it as a placeholder — with a segment this company
      // reaches — would turn "the state filter excludes everything" into a flake,
      // and the closed-tender half is a `not.toContain` that a page full of
      // somebody else's rows would satisfy without proving anything.
      const { body } = await listOwn({ group: 'compatible', state: 'ZZ' })
      expect(body.tenders).toEqual([])

      const closed = closedTenders[0]
      expect(closed, 'the fixtures must still contain a closed tender').toBeTruthy()
      await pool().query('update tenders set segments = $2 where id = $1', [closed?.id, [IT]])
      const open = await listOwn({ group: 'compatible' })
      // The positive control: this list really is the compatible list, so the
      // absence below is the closed tender being excluded and not an empty page.
      expect(open.body.tenders.map((t) => t.id)).toContain(compatibleTender.id)
      expect(open.body.tenders.map((t) => t.id)).not.toContain(closed?.id)
      await pool().query('update tenders set segments = null where id = $1', [closed?.id])
    })

    it('says how old the list is and queues nothing to refresh it', async () => {
      /*
       * Two halves, and the division is §4c's: **the mechanism in a direct call,
       * the result through the route** (D54).
       *
       * The old assertion was `count(*) from jobs where kind='sync_open_tenders'`
       * either side of one request — the whole queue, so the scheduler, a
       * concurrent suite or a leftover row all move it and none of them is this
       * route. Narrowing it to one key is worse, which is what the first version
       * of this fix did and the §4b review caught: `listFreshness`'s own
       * docstring names the hazard as *"a web route inventing a key for it"*, and
       * an assertion about one key cannot see an invented one.
       *
       * A watermark on `jobs.id` was the next attempt, over both refreshing
       * kinds, and it is **measured not to work**: with a writer enqueueing
       * `sync_open_tenders` beside this suite — which is what the scheduler does
       * on every real database — it failed on that row, `d54-interference-sweep-…`,
       * because a kind and an id tell you a job is new and never tell you who
       * made it. *Nothing read from `jobs` can attribute a row to this request
       * unless the key or the payload carries something the request owns.*
       *
       * So the breadth comes from the one place that **can** attribute it: the
       * value `readOrEnqueue` returns. `Cached.job` is *the job this call
       * created*, whatever key it chose, and `enqueue: false` makes it
       * permanently null. Forcing the read stale is what puts the enqueue branch
       * on the path, so this cannot pass by never reaching the code.
       *
       * Through the route, what is left is attributable and stays: nothing under
       * this run's keys, and nothing under the key `listFreshness` names.
       */
      await clearJobs()
      const watermark = await pool().query<{ id: string | null }>('select max(id) id from jobs')

      // Two hours ahead of the 30-minute TTL: stale, so a regression enqueues.
      const forced = await listFreshness(
        { state: null },
        { executor: db(), now: new Date(Date.now() + 2 * 60 * 60 * 1000) },
      )
      expect(forced.state, 'the read must be stale, or the enqueue branch is not on the path').toBe(
        'stale',
      )
      expect(forced.job, 'listFreshness must never create the sweep: it is the scheduler’s').toBeNull()

      const { body } = await listOwn({ group: 'compatible' })

      expect(['fresh', 'stale']).toContain(body.freshness.state)
      // And the age, which the old version did not assert despite the title:
      // `['fresh','stale']` is exhaustive — the route maps `absent` to `stale` —
      // so that assertion alone could never fail. This run inserted 7 open
      // tenders seconds ago, so the list has an age and it is a recent one.
      expect(typeof body.freshness.updatedAt).toBe('string')
      expect(Date.parse(String(body.freshness.updatedAt))).toBeLessThanOrEqual(Date.now() + 60_000)
      expect(body.freshness.ageSeconds).toBeGreaterThanOrEqual(0)

      const named = await pool().query<{ id: string; kind: string }>(
        `select id, kind from jobs where key = 'unused' and id > coalesce($1::bigint, 0)`,
        [watermark.rows[0]?.id ?? null],
      )
      expect(named.rows).toEqual([])
      expect(await ourJobs()).toEqual([])
    })

    /**
     * D19, on the real route: the list reports the company it grouped by.
     *
     * The CNPJ here is in **`visitors.cnpj`** and nowhere else — no `?cnpj=`,
     * which is the address Sci screenshotted. The browser cannot read that
     * cookie (`httpOnly`), so before `groupedBy` existed the header had no way
     * to know this list was grouped by anything at all and rendered
     * *"sem CNAE lido"* over it.
     */
    it('reports the cookie company it grouped by, and counts CNAEs not segments', async () => {
      const visitor = await newVisitor()
      /**
       * A third CNAE that `cnae_segments` does not map, so the two numbers
       * **differ**: 3 CNAEs on the row, 2 segments reached.
       *
       * Without it this assertion passes under the old implementation too.
       * `soleCnaeFor` picks codes mapping to exactly one segment, so the
       * fixture's main + one secondary give `segments.length === 2 === cnaeCount`
       * and `segments.length` — the thing D19 replaced — is indistinguishable
       * from the right answer. B6 leaves 777 codes unmapped, so a CNAE reaching
       * nothing is the ordinary case rather than a contrived one.
       */
      const main = await soleCnaeFor(IT, 'compatible')
      const food = await soleCnaeFor(FOOD, 'compatible')
      const unmapped = await unmappedCnae()
      await upsertCompany({ mainCnae: main, secondaryCnaes: [food, unmapped] })
      try {
        // `?q=` and `?limit=` for the same reason as `listOwn` (D54) — this one
        // builds its own request because the point is that there is no `?cnpj=`,
        // so it cannot go through `list`. The run token keeps the page to this
        // run's rows; the CNPJ still comes from the cookie and nowhere else.
        const response = await getTenders(
          new Request(
            `https://licitaqui.test/api/radar/tenders?group=compatible&limit=50&q=${TOKEN}`,
            { headers: headers(visitor) },
          ),
        )
        const body = (await response.json()) as TenderListResponse
        if (body.state !== 'ready') throw new Error(`expected ready, got ${body.state}`)

        // No `?cnpj=` anywhere: the CNPJ came from `visitors.cnpj`, behind an
        // `httpOnly` cookie the browser cannot read. That is the address Sci
        // screenshotted, and the reason the route has to say what it grouped by.
        expect(body.groupedBy, 'a cookie CNPJ drove this list').not.toBeNull()
        expect(body.groupedBy?.cnaeCount).toBe(3)
        expect(body.groupedBy?.company?.segments).toHaveLength(2)
        /*
         * **And the CNPJ itself is not on the wire** (D60, one line changed in
         * this file). This assertion used to read
         * `expect(body.groupedBy?.company?.cnpj).toBe(RUN_COMPANY_CNPJ)` — it
         * proved the route reported the right company, and it also proved the
         * cookie's CNPJ reaching page JavaScript, which is the one thing D19
         * removed `GroupedBy.cnpj` to prevent. It came back nested inside
         * `company`, and `ListSnapshot.grouping` wrote it into `sessionStorage`.
         * `GroupedCompany` is `CompanyView` without that field, so the identity
         * of the company is now asserted by what the header renders.
         */
        expect(JSON.stringify(body.groupedBy)).not.toContain(RUN_COMPANY_CNPJ)
        expect(body.groupedBy?.company?.legalName).toBeTruthy()
        // And it really did group by them, which is what made the header's
        // contradiction visible in the first place.
        expect(body.tenders.map((t) => t.id)).toContain(compatibleTender.id)
      } finally {
        // Back to exactly what `beforeAll` built, for the tests after this one.
        await upsertCompany({ mainCnae: main, secondaryCnaes: [food] })
      }
    })

    /**
     * The other acceptance criterion, measured rather than reasoned: with no
     * company anywhere, there is nothing to report and every row is `keyword`.
     *
     * `labels([])` is `array[]::text[]` and `&&` against it is false, so this is
     * the grouping behaving correctly — D19's card says so and says not to
     * change it. What was wrong was only the sentence above it.
     */
    it('reports no company when none drove the list, and groups it all as keyword', async () => {
      // `keywordFrom` rather than the bare helper: this test took the word with
      // no assertion about it, so an unaccented or stopword fixture would have
      // left every assertion below satisfied by the run token alone (D54).
      const word = await keywordFrom(otherTender)
      const visitor = await newVisitor(null)
      // The run token with the word, and `limit=50` (D54). Unscoped, every
      // assertion below held over **somebody else's** rows: `tenders.length > 0`
      // was satisfied by any match anywhere, and `every(keyword)` is trivially
      // true of a foreign row too, since with no company nothing can be anything
      // but keyword. Scoped, the same two assertions are about this run's tender,
      // which is why the first one now names it.
      const response = await getTenders(
        new Request(
          `https://licitaqui.test/api/radar/tenders?group=keyword&limit=50&q=${encodeURIComponent(`${TOKEN} ${unaccent(word)}`)}`,
          { headers: headers(visitor) },
        ),
      )
      const body = (await response.json()) as TenderListResponse
      if (body.state !== 'ready') throw new Error(`expected ready, got ${body.state}`)

      expect(body.groupedBy).toBeNull()
      // Structural, not a count of the table: with no company `labels([])` is
      // `array[]::text[]` and `&&` against it is false for every row, so these
      // two are zero whatever else is in `tenders`.
      expect(body.counts.compatible).toBe(0)
      expect(body.counts.check).toBe(0)
      expect(body.tenders.map((t) => t.id)).toContain(otherTender.id)
      expect(body.tenders.every((t) => t.group === 'keyword')).toBe(true)
    })

    it('refuses a request with neither a CNPJ nor a search term', async () => {
      const response = await getTenders(
        new Request('https://licitaqui.test/api/radar/tenders', { headers: headers() }),
      )
      expect(response.status).toBe(400)
    })
  })

  // ─────────────────────── GET /api/tenders/:id ───────────────────────

  describe('GET /api/tenders/:id', () => {
    function params(id: string) {
      return { params: Promise.resolve({ id }) }
    }

    function request(visitorId?: string) {
      return new Request('https://licitaqui.test/api/tenders/x', { headers: headers(visitorId) })
    }

    beforeEach(clearJobs)

    it('serves the header and every item, and locks the files behind an account', async () => {
      const fixture = openTenders[0] as SeedFixture
      const response = await getTender(request(), params(fixture.id))
      const body = (await response.json()) as TenderResponse

      expect(response.status).toBe(200)
      if (body.state !== 'ready') throw new Error(`expected ready, got ${body.state}`)
      expect(body.tender.id).toBe(fixture.id)
      expect(body.tender.items).toHaveLength(fixture.items)
      expect(body.tender.items[0]?.description).toBeTruthy()
      // §8: files only with an account. `null` is the locked block; `[]` would
      // mean the agency published nothing.
      expect(body.tender.files).toBeNull()
      expect(response.headers.get('cache-control')).toBe('private, no-store')
    })

    it('stale: serves the tender AND queues sync_items on the worker’s own key', async () => {
      const fixture = openTenders[1] as SeedFixture
      // §3.2 gives items 12 hours while the tender is open.
      await ageTender(fixture.id, new Date(Date.now() - 13 * 60 * 60 * 1000))

      const response = await getTender(request(), params(fixture.id))
      const body = (await response.json()) as TenderResponse

      expect(response.status).toBe(200)
      if (body.state !== 'ready') throw new Error(`expected ready, got ${body.state}`)
      expect(body.tender.items.length).toBeGreaterThan(0)
      expect(body.freshness.state).toBe('stale')

      const queued = await jobsFor(fixture.id)
      expect(queued).toHaveLength(1)
      expect(queued[0]?.kind).toBe('sync_items')
      expect(queued[0]?.priority).toBe(5)
      expect(queued[0]?.payload).toEqual({ tender_id: fixture.id })

      await ageTender(fixture.id, new Date())
    })

    it('a closed tender is permanent: ancient, fresh, and nothing queued', async () => {
      const fixture = closedTenders[0] as SeedFixture
      await ageTender(fixture.id, new Date(Date.now() - 400 * DAY_MS))

      const response = await getTender(request(), params(fixture.id))
      const body = (await response.json()) as TenderResponse

      expect(response.status).toBe(200)
      if (body.state !== 'ready') throw new Error(`expected ready, got ${body.state}`)
      expect(body.tender.closed).toBe(true)
      expect(body.freshness.state).toBe('fresh')
      expect(await jobsFor(fixture.id)).toHaveLength(0)
    })

    it('answers 404 for an id we hold no header for, and queues nothing', async () => {
      const unknown = `${RUN_AGENCY_CNPJ}-1-999999/2026`
      const response = await getTender(request(), params(unknown))
      const body = (await response.json()) as TenderResponse

      expect(response.status).toBe(404)
      if (body.state !== 'error') throw new Error('expected an error')
      expect(body.error).toBe('not_found')
      // `sync_items` cannot create a header, so a 202 would be a promise the
      // worker could not keep — and an open door for filling the queue.
      expect(await jobsFor(unknown)).toHaveLength(0)
    })

    it('rejects an id that is not a numeroControlePNCP', async () => {
      const response = await getTender(request(), params('../../etc/passwd'))
      expect(response.status).toBe(400)
    })

    it('does not mint a visitor: a GET must not let a crawler fill the table', async () => {
      /*
       * `select count(*) from visitors` either side of one request is a count of
       * every lane's rows (D54) — a concurrent suite minting one visitor in the
       * window reddens a route that did nothing, and this database was holding
       * **19** visitors nobody owns when this card was written (measured, R1,
       * 2026-10-06), left by runs killed before their `afterAll`.
       *
       * Four assertions replace it, and **the fourth is the one that matters**,
       * because the first three miss the likeliest regression of all. The route
       * reads `readViewer` (`app/api/tenders/[id]/route.ts`) and passes no IP and
       * no user-agent to anything; swapping that one word for
       * `readOrCreateViewer` type-checks and inserts a row with `ip_hash` **null**,
       * `user_agent_hash` null, `cnpj` null and a **fresh** id. That escapes a
       * fingerprint assertion and a cookie-id assertion alike — found in review,
       * and the old global count did catch it. Worse, `cleanupRun` deletes
       * visitors by `cnpj`, so the row it misses is also a row nothing can clean.
       *
       * 1. the `set-cookie` the caller would need — a row the client never
       *    receives is not an identity, so this is the contract half;
       * 2. no row under `ip_hash = sha256(<this request's forwarded-for>)[:32]`,
       *    which is what `loadOrCreateVisitor` stamps when it is *given* an IP —
       *    the CNPJ route passes the raw header (`api/radar/cnpj/route.ts`), so
       *    this is the trace of a mint that copied that route;
       * 3. no row under the id a dangling cookie named — the other shape, an
       *    upsert on a cookie that names nothing;
       * 4. **no row created since this request began that could be anybody's
       *    mint**: `created_at >= now()` taken from the database, `cnpj is null`
       *    (the route has no CNPJ to attach), and an `ip_hash` that is either
       *    null or this request's fingerprint. That excludes every visitor this
       *    file creates, because `newVisitor` marks them (see `VISITOR_MARK`);
       *    every visitor the CNPJ route mints, because those carry a CNPJ and a
       *    real digest; and everything written before the window. What it does
       *    **not** exclude is a second process inserting a CNPJ-less,
       *    fingerprint-less visitor inside the same ~300 ms — nothing in this
       *    database does, and that residue is the price of proving a negative
       *    about a table two writers share.
       *
       * Both callers a crawler can be are asked: one with no cookie, one with a
       * cookie naming a visitor that does not exist. Each asserts a 200 first, so
       * neither can pass by never reaching the identity code at all.
       */
      const fixture = openTenders[0] as SeedFixture
      for (const [index, dangling] of [null, randomUUID()].entries()) {
        // The first hop is what the rate limiter keys on; the rest of the header
        // is hashed whole, which is where the run's uniqueness goes.
        const forwardedFor = `203.0.113.${200 + index}, 100.64.0.0 run-${RUN_ID}`
        const fingerprint = createHash('sha256').update(forwardedFor).digest('hex').slice(0, 32)
        const headersWith: Record<string, string> = {
          'content-type': 'application/json',
          'x-forwarded-for': forwardedFor,
        }
        if (dangling) headersWith.cookie = cookie(dangling)

        // From the database, not from this laptop: the two clocks are an hour
        // apart (CLAUDE.md, Clocks) and the comparison below is against
        // `visitors.created_at`, which is UTC and Postgres's.
        const since = await pool().query<{ at: Date }>('select now() at')

        const response = await getTender(
          new Request('https://licitaqui.test/api/tenders/x', { headers: headersWith }),
          params(fixture.id),
        )
        expect(response.status).toBe(200)
        expect(response.headers.get('set-cookie')).toBeNull()

        const traced = await pool().query<{ n: string }>(
          'select count(*) n from visitors where ip_hash = $1 or id = $2::uuid',
          [fingerprint, dangling ?? '00000000-0000-0000-0000-000000000000'],
        )
        expect(Number(traced.rows[0]?.n)).toBe(0)

        const anonymous = await pool().query<{ n: string }>(
          `select count(*) n from visitors
            where created_at >= $1 and cnpj is null
              and (ip_hash is null or ip_hash = $2)`,
          [since.rows[0]?.at, fingerprint],
        )
        expect(
          Number(anonymous.rows[0]?.n),
          'the GET minted a visitor with no cookie, no CNPJ and no fingerprint',
        ).toBe(0)
      }
    })
  })

  // ───────────────── POST /api/tenders/:id/screening ─────────────────

  describe('POST /api/tenders/:id/screening', () => {
    function params(id: string) {
      return { params: Promise.resolve({ id }) }
    }

    function request(visitorId: string) {
      return new Request('https://licitaqui.test/api/tenders/x/screening', {
        method: 'POST',
        headers: headers(visitorId),
      })
    }

    beforeEach(clearJobs)

    it('queues ai_screening at priority 1 and answers 202 with the quota', async () => {
      const visitor = await newVisitor()
      const fixture = openTenders[0] as SeedFixture
      // The allowance comes from the table, not from memory (D64). `limit: 2` was
      // a bet on a row this run does not write; what the route is actually
      // responsible for is reporting the row it read, which is what is asserted —
      // `period` with it, which the literal version never checked at all.
      const screening = await countableLimit('visitor', 'screening')

      const response = await postScreening(request(visitor), params(fixture.id))
      const body = (await response.json()) as ScreeningResponse

      expect(response.status).toBe(202)
      if (body.state !== 'analyzing') throw new Error(`expected analyzing, got ${body.state}`)
      expect(body.quota).toMatchObject({
        feature: 'screening',
        plan: 'visitor',
        period: screening.period,
        limit: screening.quantity,
        used: 1,
      })

      const queued = await jobsFor(`screening:${fixture.id}`)
      expect(queued).toHaveLength(1)
      expect(queued[0]?.kind).toBe('ai_screening')
      expect(queued[0]?.priority).toBe(1)
    })

    it('returns a cached analysis instead of paying for it twice', async () => {
      const visitor = await newVisitor()
      const fixture = openTenders[1] as SeedFixture
      await pool().query(
        `insert into ai_analyses (tender_id, mode, model, prompt_version, extraction_version,
                                  files_hash, status, result)
         values ($1, 'lite', 'qwen/qwen3.7-flash', 'v1', 3, $2, 'ok', $3::jsonb)`,
        [fixture.id, `hash-${RUN_ID}`, JSON.stringify({ resumo: 'triagem de teste' })],
      )

      const response = await postScreening(request(visitor), params(fixture.id))
      const body = (await response.json()) as ScreeningResponse

      expect(response.status).toBe(200)
      if (body.state !== 'ready') throw new Error(`expected ready, got ${body.state}`)
      expect(body.status).toBe('ok')
      expect(body.result).toEqual({ resumo: 'triagem de teste' })
      // §3.2: the analysis is shared, so nothing is queued for it.
      expect(await jobsFor(`screening:${fixture.id}`)).toHaveLength(0)
    })

    it('spends every screening the visitor plan grants and then refuses', async () => {
      const visitor = await newVisitor()
      // How many, from `plan_limits` (D64). The literal `2` was here three times
      // over — twice in the assertion and once in the shape of the test, which
      // wrote out exactly two allowed calls — so a row saying anything else broke
      // this test for being right. The loop now runs as far as the row says.
      const { quantity: granted } = await countableLimit('visitor', 'screening')
      // Tenders no earlier test has cached an analysis for: a cache hit answers
      // 200, and this test is about the 202 path running out.
      // Asserted, not assumed. Indexing blindly into `openTenders` is how
      // this suite broke: it read past the end and threw a TypeError whose
      // message said nothing about fixtures expiring.
      expect(
        openTenders.length,
        `this test needs ${granted + 1} open fixtures after the first two; re-dating keeps seven`,
      ).toBeGreaterThan(granted + 2)
      const spendable = openTenders.slice(2)

      for (let spent = 0; spent < granted; spent += 1) {
        const allowed = await postScreening(
          request(visitor),
          params((spendable[spent] as SeedFixture).id),
        )
        expect(allowed.status, `screening ${spent + 1} of ${granted} was refused`).toBe(202)
      }

      const response = await postScreening(
        request(visitor),
        params((spendable[granted] as SeedFixture).id),
      )
      const body = (await response.json()) as ScreeningResponse
      expect(response.status).toBe(402)
      if (body.state !== 'error') throw new Error('expected an error')
      expect(body.error).toBe('quota_exceeded')
      expect(body.quota).toMatchObject({ limit: granted, used: granted, left: 0 })
      // `granted + 1` sequential route calls against a remote Neon: comfortably
      // past Vitest's 5 s default, and nothing here is waiting on the product.
    }, 60_000)

    it('does not charge again for the same tender — §3.1 tells the client to poll', async () => {
      const visitor = await newVisitor()
      const fixture = openTenders[0] as SeedFixture

      await postScreening(request(visitor), params(fixture.id))
      const again = await postScreening(request(visitor), params(fixture.id))
      const body = (await again.json()) as ScreeningResponse

      expect(again.status).toBe(202)
      if (body.state !== 'analyzing') throw new Error(`expected analyzing, got ${body.state}`)
      expect(body.quota.used).toBe(1)

      const used = await pool().query<{ n: string }>(
        "select count(*) n from usage where visitor_id = $1 and feature = 'screening'",
        [visitor],
      )
      expect(Number(used.rows[0]?.n)).toBe(1)
      // Same reason as the test above, which already carries this: four
      // sequential round trips to a remote Neon are past Vitest's 5 s default
      // the moment another database suite is running in a second worker. This
      // one was missed, and it timed out — never failed an assertion — once U1
      // added a third concurrent suite.
    }, 60_000)

    it('refuses once the visitor’s free days are up, and not an hour before', async () => {
      // The window, read from `plan_limits (visitor, days)` rather than written
      // into the SQL as `interval '4 days'` (D64) — a literal that was really
      // "3 + 1" with the 3 taken from a row this run does not own.
      const { quantity: days } = await countableLimit('visitor', 'days')
      // The in-window half of this test **spends** a screening, which the version
      // it replaces never did, so the visitor's screening row is now a
      // precondition here too (§4b). Without this read a `0` in that row would
      // answer 402 and the failure would blame a `${days}-day window` for a row
      // that has nothing to do with the clock.
      await countableLimit('visitor', 'screening')
      // Its own company: the window is counted per CNPJ as well as per device
      // (§8, decision 5 in §17), so ageing a visitor of the main one would
      // expire every visitor a later test creates.
      const visitor = await newVisitor(RUN_EXPIRED_CNPJ)

      /**
       * **Both sides of the boundary, on the one row** — and this is the part that
       * reading the number would otherwise have cost.
       *
       * `interval '4 days'` against a seeded `3` asserted two things: that an
       * expired visitor is refused, *and* that the route's window is three days
       * long. Ageing by `days + 1` keeps only the first: a route that read the
       * row and then used some other number of days would still refuse a visitor
       * that old, and the test would pass. So the window is pinned from both
       * directions instead — an hour inside it must be served, an hour outside it
       * must not — which says what the row says whatever the row holds, and is
       * tighter than the literal was.
       *
       * The in-window call spends one of this visitor's screenings; the expired
       * call is refused before the quota is ever consulted (the route checks
       * tender → window → quota, in that order), so the second answer is a 403
       * and not a 402 no matter what the first one cost. The same ordering is
       * why both calls may name the same tender: which one it is cannot change
       * the refusal.
       */
      await ageVisitorToWindowEdge(visitor, days, 1)
      const inWindow = await postScreening(request(visitor), params((openTenders[0] as SeedFixture).id))
      expect(inWindow.status, `an hour inside a ${days}-day window must still be served`).toBe(202)

      await ageVisitorToWindowEdge(visitor, days, -1)
      const response = await postScreening(request(visitor), params((openTenders[0] as SeedFixture).id))
      const body = (await response.json()) as ScreeningResponse

      expect(response.status, `an hour past a ${days}-day window must be refused`).toBe(403)
      if (body.state !== 'error') throw new Error('expected an error')
      expect(body.error).toBe('visitor_expired')
      // Two sequential route calls against a remote Neon.
    }, 60_000)

    it('answers 404 for a tender we do not hold, without spending a screening', async () => {
      const visitor = await newVisitor()
      const response = await postScreening(
        request(visitor),
        params(`${RUN_AGENCY_CNPJ}-1-999998/2026`),
      )
      expect(response.status).toBe(404)
      const used = await pool().query<{ n: string }>(
        'select count(*) n from usage where visitor_id = $1',
        [visitor],
      )
      expect(Number(used.rows[0]?.n)).toBe(0)
    })
  })

  // ───────────────────────── GET /api/jobs/:id ─────────────────────────

  describe('GET /api/jobs/:id', () => {
    function params(id: string) {
      return { params: Promise.resolve({ id }) }
    }

    function request() {
      return new Request('https://licitaqui.test/api/jobs/x', { headers: headers() })
    }

    it('reports the state of a job the web created, and nothing else about it', async () => {
      await clearJobs()
      const visitor = await newVisitor()
      const fixture = openTenders[0] as SeedFixture
      await postScreening(
        new Request('https://licitaqui.test/api/tenders/x/screening', {
          method: 'POST',
          headers: headers(visitor),
        }),
        params(fixture.id),
      )
      const [job] = await jobsFor(`screening:${fixture.id}`)
      expect(job).toBeTruthy()

      const response = await getJob(request(), params(String(job?.id)))
      const body = (await response.json()) as JobResponse

      expect(response.status).toBe(200)
      if (body.state !== 'ready') throw new Error(`expected ready, got ${body.state}`)
      expect(body.job).toEqual({
        id: Number(job?.id),
        kind: 'ai_screening',
        status: 'queued',
        attempts: 0,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      })
      // No payload, no key, no error text: §12, and there is no owner column
      // to check against yet.
      expect(Object.keys(body.job).sort()).toEqual([
        'attempts',
        'createdAt',
        'id',
        'kind',
        'status',
        'updatedAt',
      ])
    })

    it('does not expose a job kind the web never creates', async () => {
      const inserted = await pool().query<{ id: string }>(
        `insert into jobs (kind, key) values ('sync_open_tenders', $1) returning id`,
        [`${RUN_AGENCY_CNPJ}-sweep`],
      )
      const response = await getJob(request(), params(String(inserted.rows[0]?.id)))
      expect(response.status).toBe(404)
    })

    it('rejects an id that is not a positive integer', async () => {
      expect((await getJob(request(), params('abc'))).status).toBe(400)
      expect((await getJob(request(), params('-1'))).status).toBe(400)
    })
  })
})

/** The words of the object, stripped of punctuation. */
function words(text: string): string[] {
  return text.split(/\s+/).map((word) => word.replace(/[^\p{L}]/gu, ''))
}

/**
 * The term a keyword test is about to search for really is a search term:
 * `websearch_to_tsquery` keeps it rather than dropping it as a stopword.
 *
 * Asked of Postgres with the configuration the route uses, not reasoned about
 * from a list of Portuguese stopwords, because that list is the configuration's
 * and can change with it.
 */
async function expectSearchable(term: string): Promise<void> {
  const parsed = await pool().query<{ q: string }>(
    `select websearch_to_tsquery('pt_unaccent', $1)::text q`,
    [term],
  )
  expect(
    parsed.rows[0]?.q,
    `"${term}" is dropped by websearch_to_tsquery, so searching for it proves nothing`,
  ).not.toBe('')
}

/**
 * The word the two keyword tests search for, with every property they need
 * asserted here rather than at one of the two call sites (D54).
 *
 * Long, accented — otherwise `pt_unaccent` is not under test at all — and not a
 * stopword. The second test used to take the word with no assertion about it,
 * which is how one of these could have gone quiet without the other.
 */
async function keywordFrom(fixture: SeedFixture): Promise<string> {
  const word = longestAccentedWord(fixture.object)
  expect(word.length).toBeGreaterThan(5)
  expect(unaccent(word), 'the word must carry an accent, or nothing here tests accents').not.toBe(
    word,
  )
  await expectSearchable(unaccent(word))
  return word
}

/**
 * The longest word of the object that **carries a diacritic** — long enough to
 * be distinctive, never a stopword (`websearch_to_tsquery` would drop one and
 * leave an empty query), and accented, which is the whole point of the test that
 * reads it.
 *
 * The longest word alone is not enough: for the tender these tests search for it
 * is `componentes`, which is unaccented, so *"accents and all"* was asserting
 * that an ASCII word matches itself. The caller also asserts that the word
 * differs from its own unaccented form, so this cannot quietly stop being true.
 */
function longestAccentedWord(text: string): string {
  return words(text)
    .filter((word) => /\p{Diacritic}/u.test(word.normalize('NFD')))
    .reduce((longest, word) => (word.length > longest.length ? word : longest), '')
}

function unaccent(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '')
}
