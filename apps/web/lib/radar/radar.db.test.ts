import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GET as getJob } from '@/app/api/jobs/[id]/route'
import { POST as postCnpj } from '@/app/api/radar/cnpj/route'
import { GET as getTenders } from '@/app/api/radar/tenders/route'
import { GET as getTender } from '@/app/api/tenders/[id]/route'
import { POST as postScreening } from '@/app/api/tenders/[id]/screening/route'
import { cnpjRef } from '@/lib/cnpj'
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
 */

const url = testDatabaseUrl('TEST_DATABASE_URL_R1') ?? testDatabaseUrl()
const suite = url ? describe : describe.skip

/** POC 1's labels, as `tenders.segments` and `cnae_segments.segment` spell them. */
const IT = 'Informática / TI'
const FOOD = 'Alimentos'
const FURNITURE = 'Mobiliário'

const DAY_MS = 24 * 60 * 60 * 1000

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
  await pool().query('insert into visitors (id, cnpj) values ($1, $2)', [id, cnpj])
  return id
}

function cookie(visitorId: string): string {
  return `lq_visitor=${visitorId}`
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
  }, 180_000)

  beforeEach(async () => {
    await resetRateLimits()
  })

  afterAll(async () => {
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
      // 2026-09-28T08:30:00 in São Paulo (UTC-3) is 11:30 UTC. Cast straight to
      // timestamptz it would be stored as 08:30 UTC — every deadline three
      // hours early, on a product that sells "before the deadline".
      const fixture = fixtures.find((f) => f.closeAt === '2026-09-28T08:30:00')
      expect(fixture, 'the 08:30 fixture must still be in db/seed/fixtures').toBeTruthy()
      const found = await pool().query<{ at: Date }>(
        'select proposals_close_at at from tenders where id = $1',
        [fixture?.id],
      )
      expect(found.rows[0]?.at.toISOString()).toBe('2026-09-28T11:30:00.000Z')
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
      const response = await postCnpj(request('11111111111111'))
      const body = (await response.json()) as CnpjResponse

      expect(response.status).toBe(400)
      if (body.state !== 'error') throw new Error('expected an error')
      expect(body.error).toBe('validation')
      expect(body.fields?.cnpj).toBe('cnpjInvalid')
      const anyJob = await pool().query<{ n: string }>(
        "select count(*) n from jobs where kind = 'company_lookup' and created_at > now() - interval '1 minute'",
      )
      expect(Number(anyJob.rows[0]?.n)).toBe(0)
    })
  })

  // ──────────────── the CNAE → segment join, §8's grouping ────────────────

  describe('GET /api/radar/tenders', () => {
    let compatibleTender: SeedFixture
    let checkTender: SeedFixture
    let otherTender: SeedFixture

    beforeAll(async () => {
      expect(openTenders.length, 'the fixtures must still contain open tenders').toBeGreaterThan(2)
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

    it('puts a main-CNAE segment in Compatível', async () => {
      const { body } = await list({ group: 'compatible' })
      const ids = body.tenders.map((t) => t.id)
      expect(ids).toContain(compatibleTender.id)
      expect(ids).not.toContain(checkTender.id)
      const card = body.tenders.find((t) => t.id === compatibleTender.id)
      expect(card?.matchedSegments).toEqual([
        { segment: IT, fit: 'compatible', fromMainCnae: true, fromSecondaryCnae: false },
      ])
    })

    it('caps a secondary-CNAE segment at Verificar, however the map rates it', async () => {
      const { body } = await list({ group: 'check' })
      const ids = body.tenders.map((t) => t.id)
      expect(ids).toContain(checkTender.id)
      expect(ids).not.toContain(compatibleTender.id)
      expect(body.tenders.find((t) => t.id === checkTender.id)?.matchedSegments[0]?.fit).toBe('check')
    })

    it('leaves a segment the company has no CNAE for out of both groups', async () => {
      const compatible = await list({ group: 'compatible' })
      const check = await list({ group: 'check' })
      expect(compatible.body.tenders.map((t) => t.id)).not.toContain(otherTender.id)
      expect(check.body.tenders.map((t) => t.id)).not.toContain(otherTender.id)
    })

    it('finds an unmatched tender by keyword, accents and all', async () => {
      // A distinctive word from the tender's own object, typed without its
      // accents: `licitacao` has to match `licitação`.
      const word = longestWord(otherTender.object)
      expect(word.length).toBeGreaterThan(5)
      const { body } = await list({ group: 'keyword', q: unaccent(word) })
      expect(body.tenders.map((t) => t.id)).toContain(otherTender.id)
      expect(body.tenders.find((t) => t.id === otherTender.id)?.group).toBe('keyword')
    })

    it('counts every group under the same filters, for the tabs', async () => {
      const { body } = await list({ group: 'compatible' })
      expect(body.counts.compatible).toBeGreaterThanOrEqual(1)
      expect(body.counts.check).toBeGreaterThanOrEqual(1)
      // No search term: the keyword group is empty by construction.
      expect(body.counts.keyword).toBe(0)
    })

    it('filters by state and never returns a closed tender by default', async () => {
      const { body } = await list({ group: 'compatible', state: 'ZZ' })
      expect(body.tenders).toEqual([])

      const closed = closedTenders[0]
      expect(closed, 'the fixtures must still contain a closed tender').toBeTruthy()
      await pool().query('update tenders set segments = $2 where id = $1', [closed?.id, [IT]])
      const open = await list({ group: 'compatible' })
      expect(open.body.tenders.map((t) => t.id)).not.toContain(closed?.id)
      await pool().query('update tenders set segments = null where id = $1', [closed?.id])
    })

    it('says how old the list is and queues no sweep of its own', async () => {
      const before = await pool().query<{ n: string }>(
        "select count(*) n from jobs where kind = 'sync_open_tenders'",
      )
      const { body } = await list({ group: 'compatible' })
      expect(['fresh', 'stale']).toContain(body.freshness.state)
      const after = await pool().query<{ n: string }>(
        "select count(*) n from jobs where kind = 'sync_open_tenders'",
      )
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n)
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
      const before = await pool().query<{ n: string }>('select count(*) n from visitors')
      const response = await getTender(request(), params((openTenders[0] as SeedFixture).id))
      const after = await pool().query<{ n: string }>('select count(*) n from visitors')

      expect(response.headers.get('set-cookie')).toBeNull()
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n)
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

      const response = await postScreening(request(visitor), params(fixture.id))
      const body = (await response.json()) as ScreeningResponse

      expect(response.status).toBe(202)
      if (body.state !== 'analyzing') throw new Error(`expected analyzing, got ${body.state}`)
      expect(body.quota).toMatchObject({ feature: 'screening', plan: 'visitor', limit: 2, used: 1 })

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

    it('spends the visitor’s two screenings and then refuses', async () => {
      const visitor = await newVisitor()
      // Tenders no earlier test has cached an analysis for: a cache hit answers
      // 200, and this test is about the 202 path running out.
      const [first, second, third] = openTenders.slice(2)

      expect((await postScreening(request(visitor), params((first as SeedFixture).id))).status).toBe(202)
      expect((await postScreening(request(visitor), params((second as SeedFixture).id))).status).toBe(202)

      const response = await postScreening(request(visitor), params((third as SeedFixture).id))
      const body = (await response.json()) as ScreeningResponse
      expect(response.status).toBe(402)
      if (body.state !== 'error') throw new Error('expected an error')
      expect(body.error).toBe('quota_exceeded')
      expect(body.quota).toMatchObject({ limit: 2, used: 2, left: 0 })
      // Four sequential route calls against a remote Neon: comfortably past
      // Vitest's 5 s default, and nothing here is waiting on the product.
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

    it('refuses once the visitor’s three days are up', async () => {
      // Its own company: the window is counted per CNPJ as well as per device
      // (§8, decision 5 in §17), so ageing a visitor of the main one would
      // expire every visitor a later test creates.
      const visitor = await newVisitor(RUN_EXPIRED_CNPJ)
      await pool().query('update visitors set created_at = now() - interval \'4 days\' where id = $1', [
        visitor,
      ])
      const response = await postScreening(request(visitor), params((openTenders[0] as SeedFixture).id))
      const body = (await response.json()) as ScreeningResponse

      expect(response.status).toBe(403)
      if (body.state !== 'error') throw new Error('expected an error')
      expect(body.error).toBe('visitor_expired')
    })

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

/**
 * The longest word of the object: long enough to be distinctive, and never a
 * stopword, which `websearch_to_tsquery` would drop and leave an empty query.
 */
function longestWord(text: string): string {
  return text
    .split(/\s+/)
    .map((word) => word.replace(/[^\p{L}]/gu, ''))
    .reduce((longest, word) => (word.length > longest.length ? word : longest), '')
}

function unaccent(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '')
}
