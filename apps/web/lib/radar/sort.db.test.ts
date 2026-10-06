import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GET as getTenders } from '@/app/api/radar/tenders/route'
import { closeDb, db, pool } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import { resetRateLimits } from '@/lib/rate-limit'
import type { TenderListResponse } from './contract'
import { TENDER_SORTS, type TenderSort } from './contract'
import { cleanupRun, RUN_AGENCY_CNPJ, RUN_COMPANY_CNPJ, RUN_ID } from './fixtures'
import { DIVULGADA } from './tender-status'

/**
 * The three orders of D51, walked page by page against the real database and
 * the real route.
 *
 * ## Why every assertion here is a *walk* and not a page
 *
 * `tenders.ts` states the rule this file exists to enforce: *a sort key that
 * does not match its cursor silently skips rows at every page boundary.* That
 * failure is invisible to a single-page test — page 1 is correct under any
 * cursor, because there isn't one yet — and it is invisible to an `order by`
 * test, because the order within each page is right. It only shows as rows
 * missing between page 2 and page 3, which is why each order below is read to
 * the end and compared against the whole expected sequence.
 *
 * `pagination.db.test.ts` does this for the deadline order and is the shape
 * copied here; what is new is that there are now three keys to keep honest, and
 * that two of them sort on a column that can be null.
 *
 * ## Why these values
 *
 * The 18 priced rows carry `9, 10, 100, 1000, 2, 20, …` — chosen so a
 * **lexicographic** sort and a **numeric** one disagree on nearly every pair
 * (`"10.00" < "9.00"` as text). `tenders.estimated_value` is `numeric(16,2)`, so
 * the column itself cannot be sorted as text; the cursor can, because
 * node-postgres hands numerics over as strings, and `cursorKey` casts them back
 * with `::numeric`. Drop that cast and this suite fails at the second page.
 *
 * The 6 unpriced rows are the measured reality: 4 588 of 24 162 open tenders
 * carry no `estimated_value` (19%, 2026-10-06). Sorted first they would own the
 * whole opening page of *menor valor*, so they sort **last in both directions**
 * and this file asserts it from both ends.
 *
 * ## Why a run-scoped keyword and not a bare CNPJ
 *
 * The same reason `pagination.db.test.ts` gives: a bare CNPJ search would also
 * return rows another concurrent run inserted into the same segment, and
 * "exactly this sequence" would become a coin toss. Every row below carries a
 * token unique to this run in its search vector.
 */

const url = testDatabaseUrl('TEST_DATABASE_URL_R2') ?? testDatabaseUrl()
const suite = url ? describe : describe.skip

/** 24 rows, 7 a page: four pages, three boundaries to lose a row at. */
const PER_PAGE = 7

/** Unique to this run, and a single lexeme so `websearch_to_tsquery` keeps it. */
const TOKEN = `radarordem${RUN_ID}`

/** One of POC 1's 14 labels, so `company_segments` can reach it. */
const SEGMENT = 'Informática / TI'

/**
 * Text order and numeric order disagree on almost every pair of these.
 * Ascending numerically they are 2, 3, 4, 5, 9, 10, 20, …; as text, "10.00"
 * comes before "2.00".
 */
const VALUES = [
  '9.00', '10.00', '100.00', '1000.00',
  '2.00', '20.00', '200.00', '2000.00',
  '3.00', '30.00', '300.00', '3000.00',
  '4.00', '40.00', '400.00', '4000.00',
  '5.00', '50.00',
]

/** How many rows carry no declared value at all. */
const UNPRICED = 6

type Row = { id: string; value: string | null }

const rows: Row[] = []

async function insertRows(): Promise<void> {
  // Deadlines an hour apart from tomorrow: every row open, and the deadline
  // order unambiguous and equal to the id order.
  const base = Date.now() + 24 * 60 * 60 * 1000
  const values: (string | null)[] = [...VALUES, ...Array.from({ length: UNPRICED }, () => null)]
  const literals = values.map((value, index) => {
    const sequence = 910_000 + index
    const id = `${RUN_AGENCY_CNPJ}-1-${String(sequence).padStart(6, '0')}/2026`
    rows.push({ id, value })
    const object = `Pregão ${TOKEN} lote ${index + 1}`
    return sql`(
      ${id}, ${RUN_AGENCY_CNPJ}, 2026, ${sequence}, ${object}, 'SP',
      ${new Date(base + index * 3_600_000).toISOString()}::timestamptz,
      ${value}::numeric,
      array[${SEGMENT}]::text[],
      ${DIVULGADA},
      to_tsvector('pt_unaccent', ${object})
    )`
  })
  // `status` is set explicitly: B9 made it the first sort key, and a null would
  // make all 24 rows *halted* — the sequences would still line up and the suite
  // would pass while testing the wrong list.
  await db().execute(sql`
    insert into tenders (id, agency_cnpj, year, sequence, object, state,
                         proposals_close_at, estimated_value, segments, status, search)
    values ${sql.join(literals, sql`, `)}
    on conflict (id) do nothing
  `)
}

/** A CNAE whose only segment is `SEGMENT`, so the company's fit is exact. */
async function soleCnae(): Promise<string> {
  const found = await pool().query<{ cnae: string }>(
    `select s.cnae from cnae_segments s
      where s.segment = $1 and s.fit = 'compatible'
        and (select count(*) from cnae_segments x where x.cnae = s.cnae) = 1
      order by s.cnae limit 1`,
    [SEGMENT],
  )
  const cnae = found.rows[0]?.cnae
  if (!cnae) throw new Error(`no single-segment CNAE for ${SEGMENT} — is migration 0003 applied?`)
  return cnae
}

let address = 0

async function page(sort: TenderSort | null, cursor: string | null) {
  address += 1
  const params = new URLSearchParams({
    group: 'compatible',
    cnpj: RUN_COMPANY_CNPJ,
    q: TOKEN,
    limit: String(PER_PAGE),
  })
  if (sort) params.set('sort', sort)
  if (cursor) params.set('cursor', cursor)
  const response = await getTenders(
    new Request(`http://localhost/api/radar/tenders?${params.toString()}`, {
      headers: { 'x-forwarded-for': `198.51.100.${address % 250}` },
    }),
  )
  return (await response.json()) as TenderListResponse
}

/** Every page of one order, appended, with the page sizes alongside. */
async function walk(sort: TenderSort | null): Promise<{ seen: string[]; sizes: number[] }> {
  const seen: string[] = []
  const sizes: number[] = []
  let cursor: string | null = null
  for (let guard = 0; guard < 10; guard += 1) {
    const answer: TenderListResponse = await page(sort, cursor)
    if (answer.state !== 'ready') throw new Error(`page answered ${answer.state}`)
    sizes.push(answer.tenders.length)
    seen.push(...answer.tenders.map((tender) => tender.id))
    cursor = answer.nextCursor
    if (!cursor) break
  }
  expect(cursor).toBeNull()
  return { seen, sizes }
}

const priced = () => rows.filter((row) => row.value !== null)
const unpriced = () => rows.filter((row) => row.value === null).map((row) => row.id)

/** What each order must produce, computed here rather than read from the query. */
function expected(sort: TenderSort): string[] {
  if (sort === 'deadline') return rows.map((row) => row.id)
  const sorted = [...priced()].sort((a, b) =>
    sort === 'valueAsc' ? Number(a.value) - Number(b.value) : Number(b.value) - Number(a.value),
  )
  // Nulls last in both directions, and among themselves by id — the only
  // tiebreak left once the value component is constant.
  return [...sorted.map((row) => row.id), ...unpriced()]
}

suite('the Radar list, in each of the three orders (database)', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url
    await cleanupRun(db())
    await pool().query(
      `insert into companies (cnpj, legal_name, main_cnae, size, is_mei, state, city,
                              registration_status, updated_at)
       values ($1, $2, $3, 'ME', false, 'SP', 'São Paulo', 'ATIVA', now())
       on conflict (cnpj) do update set main_cnae = excluded.main_cnae,
                                        updated_at = excluded.updated_at`,
      [RUN_COMPANY_CNPJ, `EMPRESA TESTE D51 ${RUN_ID} LTDA`, await soleCnae()],
    )
    await insertRows()
  }, 180_000)

  beforeEach(async () => {
    await resetRateLimits()
  })

  afterAll(async () => {
    await cleanupRun(db())
    await closeDb()
  })

  it('walks every order to the end without skipping or repeating a tender', async () => {
    for (const sort of TENDER_SORTS) {
      const { seen, sizes } = await walk(sort)
      // Four pages of 7, 7, 7, 3 — three boundaries, which is where a cursor
      // that disagrees with its `order by` loses rows.
      expect(sizes, sort).toEqual([PER_PAGE, PER_PAGE, PER_PAGE, rows.length - 3 * PER_PAGE])
      expect(seen, sort).toHaveLength(rows.length)
      expect(new Set(seen).size, sort).toBe(rows.length)
      expect([...seen].sort(), sort).toEqual(rows.map((row) => row.id).sort())
      // And in the right order *across* the boundaries, not only inside a page.
      expect(seen, sort).toEqual(expected(sort))
    }
  }, 180_000)

  it('is the deadline order when no sort is asked for, byte for byte', async () => {
    const absent = await walk(null)
    const named = await walk('deadline')
    expect(absent.seen).toEqual(named.seen)
    expect(absent.seen).toEqual(rows.map((row) => row.id))

    // The cursors are the same strings too, so a page-2 request already in
    // flight when this shipped still lands where it meant to.
    const first = await page(null, null)
    const explicit = await page('deadline', null)
    if (first.state !== 'ready' || explicit.state !== 'ready') throw new Error('not ready')
    expect(first.nextCursor).toBe(explicit.nextCursor)
  }, 120_000)

  it('sorts numerically, not as text', async () => {
    // The failure this guards: `"10.00" < "9.00"` as text, so a lexicographic
    // sort opens *menor valor* on 10, 100, 1000 and buries 2.
    const { seen } = await walk('valueAsc')
    const byId = new Map(rows.map((row) => [row.id, row.value]))
    const prices = seen.slice(0, priced().length).map((id) => Number(byId.get(id)))
    expect(prices[0]).toBe(2)
    expect(prices[1]).toBe(3)
    expect(prices).toEqual([...prices].sort((a, b) => a - b))
    // The text order would have put 10 before 2 — assert the two differ, so
    // this test cannot pass by the values happening to agree.
    const asText = [...priced()]
      .sort((a, b) => (a.value as string).localeCompare(b.value as string))
      .map((row) => Number(row.value))
    expect(asText).not.toEqual(prices)
  }, 120_000)

  it('puts the tenders with no declared value last, in both directions', async () => {
    for (const sort of ['valueDesc', 'valueAsc'] as const) {
      const { seen } = await walk(sort)
      const tail = seen.slice(-UNPRICED)
      expect(tail, sort).toEqual(unpriced())
      // Not merely "at the end of the last page": no unpriced row may appear
      // anywhere above, which is what a `nulls first` default would do to
      // *menor valor* — the 6 would own the whole first page.
      expect(seen.slice(0, seen.length - UNPRICED).some((id) => unpriced().includes(id)), sort).toBe(
        false,
      )
    }
  }, 120_000)

  it('keeps stopped tenders below the open ones under a value sort', async () => {
    // §3.4, and D51 decision 5: `halted` is the first component of every key.
    // The two chosen are the *most expensive* priced row and one unpriced row,
    // so "they moved" cannot be confused with "they were already last".
    const dearest = [...priced()].sort((a, b) => Number(b.value) - Number(a.value))[0]
    const stopped = [dearest.id, unpriced()[0]]
    await db().execute(sql`
      update tenders set status = 'Suspensa'
       where id in (${sql.join(stopped.map((id) => sql`${id}`), sql`, `)})
    `)
    try {
      const { seen } = await walk('valueDesc')
      // Never hidden: all 24 still reachable, still exactly once.
      expect(seen).toHaveLength(rows.length)
      expect(new Set(seen).size).toBe(rows.length)
      // The dearest tender in the database is now the second from last.
      expect(seen.slice(-2)).toEqual(stopped)
      expect(seen[0]).not.toBe(dearest.id)
    } finally {
      await db().execute(sql`
        update tenders set status = ${DIVULGADA}
         where id in (${sql.join(stopped.map((id) => sql`${id}`), sql`, `)})
      `)
    }
  }, 120_000)

  it('restarts rather than skips when a cursor meets another order', async () => {
    // The only way to reach this is a request already in flight when the order
    // changed, or a hand-edited URL. `decodeCursor` discards the cursor, so the
    // reader sees page 1 again — rows they have already seen, never rows they
    // have not.
    const first = await page('valueDesc', null)
    if (first.state !== 'ready') throw new Error(first.state)
    const cursor = first.nextCursor
    expect(cursor).not.toBeNull()

    for (const sort of ['deadline', 'valueAsc'] as const) {
      const confused = await page(sort, cursor)
      const clean = await page(sort, null)
      if (confused.state !== 'ready' || clean.state !== 'ready') throw new Error('not ready')
      expect(confused.tenders.map((t) => t.id), sort).toEqual(clean.tenders.map((t) => t.id))
      expect(confused.tenders[0]?.id, sort).toBe(expected(sort)[0])
    }

    // The same cursor under the order that minted it is still page 2, so the
    // test above is about the mismatch and not about the cursor being ignored.
    const second = await page('valueDesc', cursor)
    if (second.state !== 'ready') throw new Error(second.state)
    expect(second.tenders.map((t) => t.id)).toEqual(
      expected('valueDesc').slice(PER_PAGE, PER_PAGE * 2),
    )
  }, 120_000)

  it('refuses an order it does not know rather than quietly choosing one', async () => {
    const answer = await page('maiorValor' as TenderSort, null)
    expect(answer.state).toBe('error')
  }, 60_000)
})
