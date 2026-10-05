import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, pool } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import { readCoverage } from './coverage'

/**
 * B17's watchdog **SQL**, against a real Postgres.
 *
 * `coverage.test.tsx` pins the state machine with a fake executor, and that is
 * not enough — `feeds.db.test.ts` exists because a mutation to B37's query
 * left all ten of its fake-executor tests green, since they never execute the
 * statement. `CLAUDE.md` §4b: the test exercised the unit, not the path.
 *
 * What only a real database can answer here: that `distinct on (props->>'q')`
 * picks the newest row per keyword rather than an arbitrary one, that every
 * `props->>` cast parses (a `::float8` on a JSON number, a `::boolean` on a
 * JSON `true`), and that `props ? 'ratio'` excludes a row that is not a
 * measurement. Rename a key under this query and this file fails, instead of
 * `/admin` quietly reading `never` on a database full of readings.
 *
 * ## Why this does not assert the state
 *
 * Three lanes share one Neon test database, and this query reads **every**
 * `coverage_check` row by name, at any date — there is no column to scope it
 * by, and the date predicate was removed on purpose (a lookback turned a
 * month-old silence into "nunca mediu"). So the rows are written under keywords nothing else would use
 * (a per-run suffix, per `CLAUDE.md`'s rule about per-run rather than per-task
 * ids) and the assertions are about *those* rows inside the answer. A test
 * asserting the overall state would pass or fail on what another lane happened
 * to insert, which is worse than no test: it would teach people to ignore red.
 */

const url = testDatabaseUrl('TEST_DATABASE_URL_O1') ?? testDatabaseUrl()

/** Per run, never per task: two concurrent runs must not delete each other's rows. */
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const FRESH = `__cov_fresh_${RUN}`
const MOVED = `__cov_moved_${RUN}`
const SHAPELESS = `__cov_shapeless_${RUN}`
/** In the set and never measured — the row that is absent on purpose. */
const ABSENT = `__cov_absent_${RUN}`

async function eventsExist(): Promise<boolean> {
  if (!url) return false
  process.env.DATABASE_URL = url
  try {
    const found = await pool().query(
      "select 1 from information_schema.tables where table_name = 'events'",
    )
    return found.rowCount === 1
  } catch {
    return false
  }
}

const ready = await eventsExist()
const suite = url && ready ? describe : describe.skip

suite('readCoverage against Postgres', () => {
  beforeAll(async () => {
    await clean()
    // A measurement, as the worker writes one.
    await insert(FRESH, {
      segment: 'Veículos / Peças',
      ratio: 0.42,
      held: 42,
      collected: 100,
      pncp_total: 137,
      target: 0.95,
      met: false,
      truncated: true,
      standing: true,
      query_set: [FRESH, MOVED],
    })
    // Two rows for one keyword, the older one better: `distinct on` must take
    // the newer, or a card could print a reading the Radar has since lost.
    await insert(MOVED, { ratio: 0.99, held: 99, collected: 100, met: true }, '2 hours')
    await insert(
      MOVED,
      {
        ratio: 0.51,
        held: 51,
        collected: 100,
        met: false,
        // The newest standing row carries the set, and this one names a
        // keyword that wrote no row at all.
        standing: true,
        query_set: [FRESH, MOVED, ABSENT],
      },
      '1 minute',
    )
    // Not a measurement: no ratio. `props ? 'ratio'` must drop it, and it is
    // also the only shape that could ever put a zero on this card.
    await insert(SHAPELESS, { note: 'queued' })
  })

  afterAll(async () => {
    await clean()
    await closeDb()
  })

  async function clean() {
    await pool().query(
      "delete from events where name = 'coverage_check' and props->>'q' = any($1)",
      [[FRESH, MOVED, SHAPELESS]],
    )
  }

  async function insert(q: string, props: Record<string, unknown>, ago = '5 minutes') {
    await pool().query(
      `insert into events (name, props, created_at)
       values ('coverage_check', $1::jsonb, now() - $2::interval)`,
      [JSON.stringify({ q, ...props }), ago],
    )
  }

  async function queries() {
    const coverage = await readCoverage(undefined, new Date())
    expect(coverage.reading.state).not.toBe('error')
    expect(coverage.reading.state).not.toBe('never')
    if (
      coverage.reading.state !== 'fresh' &&
      coverage.reading.state !== 'short' &&
      coverage.reading.state !== 'incomplete'
    ) {
      throw new Error(`rows were just inserted, so this cannot be ${coverage.reading.state}`)
    }
    return coverage.reading.summary.queries
  }

  it('parses every field of a real row', async () => {
    const found = (await queries()).find((query) => query.q === FRESH)
    expect(found).toBeDefined()
    expect(found!.ratio).toBeCloseTo(0.42)
    expect(found!.held).toBe(42)
    expect(found!.collected).toBe(100)
    expect(found!.pncpTotal).toBe(137)
    expect(found!.met).toBe(false)
    expect(found!.truncated).toBe(true)
    expect(found!.segment).toBe('Veículos / Peças')
    expect(found!.hours).toBeLessThan(1)
  })

  it('takes the newest row per keyword, not the best one', async () => {
    const found = (await queries()).find((query) => query.q === MOVED)
    expect(found).toBeDefined()
    // 0.99 is two hours old; 0.51 is one minute old. The card must say 0.51.
    expect(found!.ratio).toBeCloseTo(0.51)
  })

  it('drops a row that is not a measurement', async () => {
    expect((await queries()).some((query) => query.q === SHAPELESS)).toBe(false)
  })

  it('names a keyword of the set that wrote no row at all', async () => {
    /**
     * The absence this card is for, through real JSON: `props->'query_set'`
     * has to arrive as an array and not as a string, or `missing` would be
     * silently empty for ever and a keyword failing every night would be
     * invisible — which is precisely the shape of B32.
     *
     * It reads the set off the newest **standing** row, and the row inserted
     * a minute ago is the newest `coverage_check` row in any database this
     * suite is pointed at. If that stops being true the assertion goes soft,
     * not wrong: another lane's set would simply not contain this run's
     * keyword.
     */
    const coverage = await readCoverage(undefined, new Date())
    if (
      coverage.reading.state === 'never' ||
      coverage.reading.state === 'error' ||
      coverage.reading.state === 'stale'
    ) {
      throw new Error(`rows were just inserted, so this cannot be ${coverage.reading.state}`)
    }
    expect(coverage.reading.summary.missing).toContain(ABSENT)
  })
})
