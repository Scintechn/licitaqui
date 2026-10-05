import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, pool } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import { catalogBandForItem } from './catalog-band'

/**
 * B35's read path, against a real Postgres.
 *
 * **Every filter in `catalogBandForItem` lives in SQL**, which is the whole
 * point of the module — it reads one row by primary key instead of computing
 * quartiles from a trigram join. A test with a fake executor would therefore
 * assert nothing that matters: drop `and c.rule = 'exact'` and a mocked test
 * stays green while the screen starts drawing **+18.6 % biased** prefix
 * matches. That is `CLAUDE.md` §4b's "the test exercised the unit, not the
 * path", and B37 hit it in this exact shape a week ago.
 *
 * So this file seeds the five ways a band can be absent and the one way it is
 * present, and asserts the query tells them apart.
 *
 * Skips without a DSN or before `0013`/`0014` are applied, for the reason
 * `feeds.db.test.ts` gives: an environment whose migrations lag cannot answer
 * the question, and a suite that is red for that reason teaches people to
 * ignore red.
 */

const url = testDatabaseUrl('TEST_DATABASE_URL_C1') ?? testDatabaseUrl()

async function tablesExist(): Promise<boolean> {
  if (!url) return false
  process.env.DATABASE_URL = url
  try {
    const found = await pool().query(
      `select 1 from information_schema.tables
        where table_name in ('catalog_bands', 'tender_item_codes')`,
    )
    return found.rowCount === 2
  } catch {
    return false
  }
}

const ready = await tablesExist()
const suite = url && ready ? describe : describe.skip

/** Scoped per run, never per task: two concurrent runs must not collide. */
const RUN = `b35r-${process.pid}-${Date.now()}`
const TENDER = `99999999999999-9-${String(process.pid % 1_000_000).padStart(6, '0')}/2026`
const BASE_CODE = 990_000_000 + (process.pid % 10_000) * 10

/** One item per scenario, so each assertion is independent of the others. */
const ITEM = {
  banded: 1,
  refused: 2,
  prefix: 3,
  service: 4,
  unmapped: 5,
  twoWindows: 6,
} as const

const CODE = {
  banded: BASE_CODE + 1,
  refused: BASE_CODE + 2,
  prefix: BASE_CODE + 3,
  service: BASE_CODE + 4,
  twoWindows: BASE_CODE + 6,
} as const

const VERSION = 'price-band-v1:test'

suite('catalogBandForItem — the filters are in SQL, so they are tested in SQL', () => {
  beforeAll(async () => {
    const p = pool()
    await p.query(
      `insert into tenders (id, agency_cnpj, year, sequence, object)
       values ($1, '99999999999999', 2026, 1, $2)
       on conflict (id) do nothing`,
      [TENDER, `${RUN} fixture`],
    )
    for (const number of Object.values(ITEM)) {
      await p.query(
        `insert into tender_items (tender_id, number, description)
         values ($1, $2, $3) on conflict do nothing`,
        [TENDER, number, `${RUN} item ${number}`],
      )
    }

    const map = async (item: number, kind: string, code: number | null, rule: string) =>
      p.query(
        `insert into tender_item_codes
           (tender_id, item_number, kind, code, rule, matcher)
         values ($1, $2, $3, $4, $5, $6) on conflict do nothing`,
        [TENDER, item, kind, code, rule, `${RUN}`],
      )

    await map(ITEM.banded, 'M', CODE.banded, 'exact')
    await map(ITEM.refused, 'M', CODE.refused, 'exact')
    await map(ITEM.prefix, 'M', CODE.prefix, 'prefix')
    await map(ITEM.service, 'S', CODE.service, 'exact')
    await map(ITEM.unmapped, 'M', null, 'no_match')
    await map(ITEM.twoWindows, 'M', CODE.twoWindows, 'exact')

    const band = async (
      kind: string,
      code: number,
      windowEnd: string,
      low: number | null,
      median: number | null,
      high: number | null,
      n: number,
      refused: string | null,
    ) =>
      p.query(
        `insert into catalog_bands
           (kind, code, window_end, low, median, high, n_purchases,
            refused_reason, band_version)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing`,
        [kind, code, windowEnd, low, median, high, n, refused, VERSION],
      )

    await band('M', CODE.banded, '2026-10-01', 10, 12.5, 15, 42, null)
    // A refusal IS a row. The xor constraint forces the nulls; the query must
    // still exclude it, or the screen draws a band over evidence we rejected.
    await band('M', CODE.refused, '2026-10-01', null, null, null, 31, 'spread_too_wide')
    await band('M', CODE.prefix, '2026-10-01', 20, 22, 24, 9, null)
    await band('S', CODE.service, '2026-10-01', 30, 33, 36, 7, null)
    // Two windows for one code: the newest must win.
    await band('M', CODE.twoWindows, '2026-09-01', 1, 2, 3, 5, null)
    await band('M', CODE.twoWindows, '2026-10-01', 100, 110, 120, 50, null)
  })

  afterAll(async () => {
    const p = pool()
    await p.query('delete from catalog_bands where band_version = $1', [VERSION])
    await p.query('delete from tender_item_codes where tender_id = $1', [TENDER])
    await p.query('delete from tender_items where tender_id = $1', [TENDER])
    await p.query('delete from tenders where id = $1', [TENDER])
    await closeDb()
  })

  it('returns the band for an exact-matched material item', async () => {
    const reading = await catalogBandForItem(TENDER, ITEM.banded)
    expect(reading).not.toBeNull()
    expect(reading?.band).toEqual({ low: 10, median: 12.5, high: 15, sampleSize: 42 })
    expect(reading?.code).toBe(CODE.banded)
    expect(reading?.bandVersion).toBe(VERSION)
    expect(reading?.windowEnd).toBe('2026-10-01')
  })

  it('returns null for a stored refusal, which is a row and not an absence', async () => {
    expect(await catalogBandForItem(TENDER, ITEM.refused)).toBeNull()
  })

  it('returns null for a prefix match even though that code HAS a band', async () => {
    // The band exists and is readable; only `rule = 'exact'` keeps it out.
    // Prefix matches measured +18.6% biased — worse than showing nothing.
    const direct = await pool().query('select low from catalog_bands where code = $1', [
      CODE.prefix,
    ])
    expect(direct.rowCount).toBe(1)
    expect(await catalogBandForItem(TENDER, ITEM.prefix)).toBeNull()
  })

  it('returns null for a service even though that code HAS a band', async () => {
    const direct = await pool().query('select low from catalog_bands where code = $1', [
      CODE.service,
    ])
    expect(direct.rowCount).toBe(1)
    expect(await catalogBandForItem(TENDER, ITEM.service)).toBeNull()
  })

  it('returns null when the item mapped to no code at all', async () => {
    expect(await catalogBandForItem(TENDER, ITEM.unmapped)).toBeNull()
  })

  it('reads the newest window when a code has several', async () => {
    const reading = await catalogBandForItem(TENDER, ITEM.twoWindows)
    expect(reading?.windowEnd).toBe('2026-10-01')
    expect(reading?.band.median).toBe(110)
  })

  it('returns null for an item that does not exist', async () => {
    expect(await catalogBandForItem(TENDER, 99)).toBeNull()
  })
})
