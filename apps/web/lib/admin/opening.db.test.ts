import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, pool } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import { readOpening } from './opening'

/**
 * E20's watchdog **SQL**, against a real Postgres.
 *
 * `opening.test.tsx` pins the mechanism with a fake executor, and that is not
 * enough: `feeds.db.test.ts` exists because a mutation to B37's query left all
 * ten of its fake-executor tests green, since they never execute the statement.
 * `CLAUDE.md` §4b — the test exercised the unit, not the path.
 *
 * What only a real database can answer here:
 *
 * - that the row the worker writes with `Jsonb(props)` parses back through
 *   `props ->> …` as the dates and numbers this reader expects. An
 *   `isoformat()` string and a `date` object are both fine in Python and only
 *   one of them survives the round trip;
 * - that `order by created_at desc, id desc limit 1` really takes the newest
 *   reading, not an arbitrary one — a card showing a reading the queue has
 *   since lost is worse than no card;
 * - that `props ? 'state'` excludes a row that is not a reading. Rename a key on
 *   the worker side and this file fails, instead of `/admin` quietly reading
 *   *"nunca conferiu"* on a database full of readings.
 *
 * ## Why it does not clean up by event name
 *
 * Three lanes share one Neon test database and this query reads **every**
 * `opening_broadcast_check` row, at any date — there is no column to scope it by
 * and the date predicate was left out on purpose (a lookback turns a month-old
 * silence into "never checked", the alarm getting quieter as the problem gets
 * older). So every row here carries a **per-run** key (`CLAUDE.md`'s rule: never
 * a per-task constant, or two concurrent runs delete each other's fixtures) and
 * the cleanup deletes only those.
 *
 * The one assertion that cannot be made run-scoped is *"this is the newest
 * row"*, because newest is global. The fixture rows are inserted at `now()` and
 * read back immediately, so only a second run of **this file** inside the same
 * few milliseconds could take the headline — and if that happens the test fails
 * with the reason named, rather than passing on somebody else's row. That is the
 * same trade `coverage.db.test.ts` documents, made explicit rather than soft.
 */

const url = testDatabaseUrl('TEST_DATABASE_URL_O1') ?? testDatabaseUrl()

/** Per run, never per task. */
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const KEY = `__opening_check_${RUN}`
/** The instant the broadcast is due: 17/10 12:00 BRT = 15:00 UTC. */
const DUE = '2026-10-17T15:00:00+00:00'

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

suite('readOpening against Postgres', () => {
  beforeAll(async () => {
    await clean()
    // An older, healthy reading — the one that must NOT win.
    await insert(
      {
        state: 'queued',
        alarm: false,
        job_id: 103288,
        job_status: 'queued',
        job_run_after: DUE,
      },
      '3 hours',
    )
    // The newest reading, and the bad one. 2026-10-03, as a row.
    await insert(
      {
        state: 'missing',
        alarm: true,
        job_id: null,
        job_status: null,
        job_run_after: null,
        seated: 2,
        waitlisted: 3,
        date_matches_product: false,
        opening_date: '2026-10-24',
      },
      '1 second',
    )
    // Not a reading: no `state`. `props ? 'state'` must drop it, and it is the
    // only shape that could put a verdict on the card no check produced.
    await pool().query(
      `insert into events (name, props, created_at)
       values ('opening_broadcast_check', $1::jsonb, now())`,
      [JSON.stringify({ expected_key: KEY, note: 'not a reading' })],
    )
  })

  afterAll(async () => {
    await clean()
    await closeDb()
  })

  async function clean() {
    await pool().query(
      "delete from events where name = 'opening_broadcast_check' and props->>'expected_key' = $1",
      [KEY],
    )
  }

  async function insert(props: Record<string, unknown>, ago: string) {
    const checkedAt = new Date(Date.parse('2026-10-09T12:00:00Z'))
    await pool().query(
      `insert into events (name, props, created_at)
       values ('opening_broadcast_check', $1::jsonb, now() - $2::interval)`,
      [
        JSON.stringify({
          expected_key: KEY,
          opening_date: '2026-10-17',
          due_at: DUE,
          due_at_brt: '2026-10-17T12:00:00-03:00',
          checked_at: checkedAt.toISOString(),
          hours_to_due: 198,
          product_opening_date: '2026-10-17',
          date_matches_product: true,
          broadcast_hour_brt: '12:00',
          whatsapp_delivery: 'send',
          email_delivery: 'dry_run',
          delivery_ready: false,
          seated: 2,
          waitlisted: 0,
          ...props,
        }),
        ago,
      ],
    )
  }

  /** The reading the card would show, with this run's row asserted to be it. */
  async function mine() {
    // `now` is the recorded `checked_at`, so the fixture is never stale: this
    // file is about the SQL, and the staleness decision is `opening.test.tsx`'s.
    const found = await readOpening(undefined, new Date('2026-10-09T12:00:00Z'))
    if (!('reading' in found.watch)) {
      throw new Error(`rows were just inserted, so this cannot be ${found.watch.kind}`)
    }
    expect(
      found.watch.reading.expectedKey,
      'another run of this file took the newest row; re-run it alone',
    ).toBe(KEY)
    return found.watch.reading
  }

  it('parses every field of a real row the worker wrote', async () => {
    const reading = await mine()
    expect(reading.dueAt.toISOString()).toBe('2026-10-17T15:00:00.000Z')
    expect(reading.hourBrt).toBe('12:00')
    expect(reading.seated).toBe(2)
    expect(reading.waitlisted).toBe(3)
    expect(reading.hoursToDue).toBeCloseTo(198, 0)
    expect(reading.at.toISOString()).toBe('2026-10-09T12:00:00.000Z')
  })

  it('takes the newest reading, not the healthiest one', async () => {
    /**
     * The three-hour-old row says `queued` with job 103288; the one-second-old
     * row says `missing`. A card that showed the older one would report a row
     * that has since been deleted as present — which is the 2026-10-03 incident
     * with the alarm pointing the wrong way.
     */
    const reading = await mine()
    expect(reading.state).toBe('missing')
    expect(reading.alarm).toBe(true)
    expect(reading.jobId).toBeNull()
    expect(reading.jobStatus).toBeNull()
    expect(reading.jobRunAfter).toBeNull()
  })

  it('reads a JSON false as a real false, not as a truthy string', async () => {
    /**
     * `date_matches_product` is the field that makes a stale
     * `FOUNDERS_OPENING_DATE` visible (E5 called it unverifiable from a laptop).
     * Through `props->>`, a JSON `false` arrives as the **string** `"false"`,
     * which is truthy — so this is the one field whose round trip could invert
     * the alarm, and it is asserted against a real row rather than a fake one.
     */
    const reading = await mine()
    expect(reading.dateMatchesProduct).toBe(false)
    // Same trap, second field, and this one gates the card's whole accent.
    expect(reading.deliveryReady).toBe(false)
    expect(reading.emailDelivery).toBe('dry_run')
    expect(reading.whatsappDelivery).toBe('send')
    expect(reading.openingDate).toBe('2026-10-24')
    expect(reading.productOpeningDate).toBe('2026-10-17')
  })

  it('drops a row that is not a reading rather than rendering it', async () => {
    // The shapeless row is the newest by `created_at` — `now()` against the
    // real reading's `now() - 1 second` — so if `props ? 'state'` stopped
    // excluding it, `mine()` would see it and `state` would be absent.
    const reading = await mine()
    expect(reading.state).toBe('missing')
  })
})
