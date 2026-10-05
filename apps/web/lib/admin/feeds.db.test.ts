import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, pool } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import { readFeeds } from './feeds'

/**
 * B37's **SQL**, against a real Postgres.
 *
 * `feeds.test.ts` pins the logic with a fake executor, and that is not enough:
 * a mutation replacing
 *
 *     max(computed_at) filter (where refused_reason is null)
 *
 * with a plain `max(computed_at)` — which is exactly the row-counting defect
 * this card exists to prevent — **left all ten of those tests green**, because
 * they never execute the statement. `CLAUDE.md` §4b: the test exercised the
 * unit, not the path.
 *
 * So this file inserts a refusal and a band and asserts the query tells them
 * apart. Without a test database it skips, so `pnpm test` stays green on a
 * machine without one.
 */

const url = testDatabaseUrl('TEST_DATABASE_URL_O1') ?? testDatabaseUrl()

/**
 * Skipped when `catalog_bands` is not there, for the same reason the suite is
 * skipped without a DSN: an environment whose migrations lag cannot answer the
 * question, and a red suite for that reason teaches people to ignore red.
 *
 * `0014` is applied to Neon `main` and **not** to the test database as of
 * 2026-10-05, so this skips locally and runs in CI, where the Postgres
 * container is migrated from `db/migrations`. Migrating the test database is
 * what turns this file on.
 */
async function tablesExist(): Promise<boolean> {
  if (!url) return false
  process.env.DATABASE_URL = url
  try {
    const found = await pool().query(
      "select 1 from information_schema.tables where table_name = 'catalog_bands'",
    )
    return found.rowCount === 1
  } catch {
    return false
  }
}

const ready = await tablesExist()
const suite = url && ready ? describe : describe.skip

/** Codes far outside anything real, so a shared database is left as it was. */
const REFUSED_CODE = 999_000_001
const BANDED_CODE = 999_000_002

suite('readFeeds against Postgres', () => {
  beforeAll(async () => {
    await clean()
  })
  afterAll(async () => {
    await clean()
    await closeDb()
  })

  async function clean() {
    await pool().query('delete from catalog_bands where code = any($1)', [
      [REFUSED_CODE, BANDED_CODE],
    ])
  }

  async function insertBand(code: number, refused: string | null, at: string) {
    await pool().query(
      `insert into catalog_bands
         (kind, code, window_end, low, median, high, n_purchases,
          refused_reason, computed_at, band_version)
       values ('M', $1, current_date, $2, $3, $4, 9, $5, $6, 'test')`,
      refused === null
        ? [code, 10, 12, 14, null, at]
        : [code, null, null, null, refused, at],
    )
  }

  it('a refusal is a row and does not count as work', async () => {
    /**
     * The whole point of the card. A pass that refuses everything writes rows
     * and achieves nothing — measured 2026-10-04, a real pass was 947 refusals
     * against 74 bands, so counting rows would have reported it as healthy.
     */
    await insertBand(REFUSED_CODE, 'spread_too_wide', new Date().toISOString())

    const feeds = await readFeeds(undefined, new Date())
    const prices = feeds.find((f) => f.key === 'catalog_prices')!

    expect(prices.reading.state).not.toBe('fresh')
    if (prices.reading.state === 'never' || prices.reading.state === 'error') return
    // The refusal is counted and shown, not hidden.
    expect(prices.reading.detail).toContain('recusas')
  })

  it('a band does count as work, and the query finds it', async () => {
    await insertBand(BANDED_CODE, null, new Date().toISOString())

    const feeds = await readFeeds(undefined, new Date())
    const prices = feeds.find((f) => f.key === 'catalog_prices')!

    expect(prices.reading.state).toBe('fresh')
    if (prices.reading.state !== 'fresh') return
    expect(prices.reading.hours).toBeLessThan(1)
  })

  it('the statement runs at all, and every feed comes back', async () => {
    // A column renamed under this query would fail here rather than silently
    // reading as `never` on the page.
    const feeds = await readFeeds(undefined, new Date())
    expect(feeds).toHaveLength(3)
    for (const feed of feeds) {
      expect(feed.reading.state).not.toBe('error')
    }
  })
})
