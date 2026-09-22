import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GET as getTenders } from '@/app/api/radar/tenders/route'
import { closeDb, db, pool } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import { resetRateLimits } from '@/lib/rate-limit'
import type { TenderCard, TenderListResponse } from './contract'
import { appendTenders } from './pagination'
import { cleanupRun, RUN_AGENCY_CNPJ, RUN_COMPANY_CNPJ, RUN_ID } from './fixtures'
import { DIVULGADA } from './tender-status'

/**
 * The four-page walk, against the real database and the real route.
 *
 * The defect this guards is not "the cursor is wrong" — the keyset in
 * `tenders.ts` was always right. It is that nothing ever asked for page 2, so
 * a CNPJ with 79 compatible tenders showed 20 and the rest did not exist as
 * far as the product was concerned. The shape below is the one measured on the
 * live site: **79 compatible, 20 a page, four pages**, the last one short.
 *
 * ## Why 79 synthetic rows and not the seed fixtures
 *
 * `db/seed/fixtures/pncp/` holds 20 real payloads, five of them still open —
 * a single page, which is exactly the situation in which this bug is
 * invisible. These rows carry no items and no `raw`, because nothing here
 * reads either: the page boundary is a function of `(proposals_close_at, id)`
 * and of how many rows match, and those are the only two things they need to
 * be honest about.
 *
 * ## Why the query is a keyword and not a bare CNPJ
 *
 * A bare CNPJ search would also return whatever *another* concurrent run of
 * this file had inserted into the same segment, and the assertion "exactly
 * four pages" would then be a coin toss — the per-run isolation failure
 * CLAUDE.md names. Every row below carries a token unique to this run in its
 * search vector, so the result set is provably these 79 rows and nothing else.
 * They still carry the company's segment, so they are still classified
 * `compatible`: the group the live Radar was showing when it stopped at 20.
 */

const url = testDatabaseUrl('TEST_DATABASE_URL_R2') ?? testDatabaseUrl()
const suite = url ? describe : describe.skip

/** The live shape. */
const TOTAL = 79
const PER_PAGE = 20

/** Unique to this run, and a single lexeme so `websearch_to_tsquery` keeps it. */
const TOKEN = `radarpaginacao${RUN_ID}`

/** One of POC 1's 14 labels, so `company_segments` can reach it. */
const SEGMENT = 'Informática / TI'

const ids: string[] = []

async function insertPage(): Promise<void> {
  // Deadlines an hour apart from tomorrow, so the order is unambiguous and
  // every row is open. The sequence is what makes the id well-formed.
  const base = Date.now() + 24 * 60 * 60 * 1000
  const rows = Array.from({ length: TOTAL }, (_, index) => {
    const sequence = 900_000 + index
    const id = `${RUN_AGENCY_CNPJ}-1-${String(sequence).padStart(6, '0')}/2026`
    ids.push(id)
    const closeAt = new Date(base + index * 3_600_000).toISOString()
    return sql`(
      ${id}, ${RUN_AGENCY_CNPJ}, 2026, ${sequence},
      ${`Pregão ${TOKEN} item ${index + 1}`}, 'SP',
      ${closeAt}::timestamptz,
      array[${SEGMENT}]::text[],
      ${DIVULGADA},
      to_tsvector('pt_unaccent', ${`Pregão ${TOKEN} item ${index + 1}`})
    )`
  })
  // `status` is set explicitly rather than left null: B9 made it a sort key,
  // and a null would make all 79 rows *halted* — the page boundaries would
  // still line up, so the suite would go on passing while quietly testing the
  // wrong list.
  await db().execute(sql`
    insert into tenders (id, agency_cnpj, year, sequence, object, state,
                         proposals_close_at, segments, status, search)
    values ${sql.join(rows, sql`, `)}
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

async function page(cursor: string | null) {
  address += 1
  const params = new URLSearchParams({
    group: 'compatible',
    cnpj: RUN_COMPANY_CNPJ,
    q: TOKEN,
    limit: String(PER_PAGE),
  })
  if (cursor) params.set('cursor', cursor)
  const response = await getTenders(
    new Request(`http://localhost/api/radar/tenders?${params.toString()}`, {
      headers: { 'x-forwarded-for': `198.51.100.${address % 250}` },
    }),
  )
  return (await response.json()) as TenderListResponse
}

suite('the Radar list, page by page (database)', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url
    await cleanupRun(db())
    await pool().query(
      `insert into companies (cnpj, legal_name, main_cnae, size, is_mei, state, city,
                              registration_status, updated_at)
       values ($1, $2, $3, 'ME', false, 'SP', 'São Paulo', 'ATIVA', now())
       on conflict (cnpj) do update set main_cnae = excluded.main_cnae,
                                        updated_at = excluded.updated_at`,
      [RUN_COMPANY_CNPJ, `EMPRESA TESTE R2 ${RUN_ID} LTDA`, await soleCnae()],
    )
    await insertPage()
  }, 180_000)

  beforeEach(() => {
    resetRateLimits()
  })

  afterAll(async () => {
    await cleanupRun(db())
    await closeDb()
  })

  it('walks 79 compatible tenders in four pages of 20, 20, 20, 19', async () => {
    const sizes: number[] = []
    let list: TenderCard[] = []
    let cursor: string | null = null
    let total: number | null = null

    for (let guard = 0; guard < 10; guard += 1) {
      const answer: TenderListResponse = await page(cursor)
      if (answer.state !== 'ready') throw new Error(`page answered ${answer.state}`)

      sizes.push(answer.tenders.length)
      // The badge is the total under these filters, and it is the same number
      // on every page: paging does not recount, which is why the view leaves
      // it alone while a page is in flight.
      total ??= answer.counts.compatible
      expect(answer.counts.compatible).toBe(total)

      // Exactly what the screen does with the page it just received.
      list = appendTenders(list, answer.tenders)

      cursor = answer.nextCursor
      if (!cursor) break
    }
    const seen = list.map((tender) => tender.id)

    expect(total).toBe(TOTAL)
    expect(sizes).toEqual([PER_PAGE, PER_PAGE, PER_PAGE, TOTAL - 3 * PER_PAGE])
    expect(cursor).toBeNull()

    // Every tender exactly once — the whole point of a keyset over an offset.
    expect(seen).toHaveLength(TOTAL)
    expect(new Set(seen).size).toBe(TOTAL)
    expect([...seen].sort()).toEqual([...ids].sort())
    // And in deadline order across the page boundary, not only inside a page.
    expect(seen).toEqual(ids)
  }, 120_000)

  it('answers the first page identically whether or not a cursor is asked for', async () => {
    const first = await page(null)
    if (first.state !== 'ready') throw new Error(first.state)
    expect(first.tenders.map((tender) => tender.id)).toEqual(ids.slice(0, PER_PAGE))
    expect(first.nextCursor).not.toBeNull()
    expect(first.tenders.every((tender) => tender.group === 'compatible')).toBe(true)
  }, 60_000)

  /**
   * §3.4: stopped tenders fall below Divulgada ones and are **never hidden** —
   * a user may be tracking exactly the one that was suspended.
   *
   * It has to be asserted across the whole four-page walk rather than on page
   * one, because the sort key and the keyset cursor are two separate pieces of
   * SQL: order by `halted` while the cursor still compares only
   * `(close_at, id)` and rows go missing at every page boundary — silently,
   * which is the failure this test exists to catch.
   */
  it('sorts stopped tenders below the open ones without losing any', async () => {
    // Three from the middle of the deadline order, so "they moved" cannot be
    // confused with "they were already last".
    const stopped = [ids[5], ids[25], ids[60]]
    const stillOpen = ids.filter((id) => !stopped.includes(id))

    await db().execute(sql`
      update tenders set status = 'Suspensa'
       where id in (${sql.join(stopped.map((id) => sql`${id}`), sql`, `)})
    `)

    try {
      const seen: string[] = []
      let cursor: string | null = null
      for (let guard = 0; guard < 10; guard += 1) {
        const answer: TenderListResponse = await page(cursor)
        if (answer.state !== 'ready') throw new Error(`page answered ${answer.state}`)
        seen.push(...answer.tenders.map((tender) => tender.id))
        cursor = answer.nextCursor
        if (!cursor) break
      }

      // Never hidden: all 79 still reachable, still exactly once.
      expect(seen).toHaveLength(TOTAL)
      expect(new Set(seen).size).toBe(TOTAL)

      // The open ones first, in deadline order; the stopped ones after them,
      // in deadline order among themselves.
      expect(seen).toEqual([...stillOpen, ...stopped])

      // And the card carries the status, so the list item can show the chip
      // without a second request.
      const last = await page(null)
      if (last.state !== 'ready') throw new Error(last.state)
      expect(last.tenders[0]?.status).toBe(DIVULGADA)
    } finally {
      await db().execute(sql`
        update tenders set status = ${DIVULGADA}
         where id in (${sql.join(stopped.map((id) => sql`${id}`), sql`, `)})
      `)
    }
  }, 120_000)
})
