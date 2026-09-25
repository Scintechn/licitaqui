import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, pool } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import { check, resetRateLimits } from './rate-limit'

/**
 * The gap the audit found: `apps/web/lib/rate-limit.ts` counted in a `Map` on
 * `globalThis`, which is honest about being "a speed bump, not a quota" — on
 * Vercel each lambda instance holds its own window, so a script rotating
 * across instances (or IPs) never sees the limit at all. This suite proves
 * the fix holds a count that survives across separate calls the way separate
 * lambda instances would each make it — never sharing this test process's own
 * in-memory map — by writing directly to `rate_limits` the way *another*
 * instance's own `checkDb()` call would, then asserting `check()` in *this*
 * process still refuses. A `Map`-based limiter has no way to see a row it did
 * not write itself; only a durable one does.
 *
 * Runs against `TEST_DATABASE_URL`; skips entirely without one, so `pnpm
 * test` stays green with no database (`signup.db.test.ts` documents the same
 * pattern in more detail).
 */

const url = testDatabaseUrl()
const suite = url ? describe : describe.skip

/** A prefix no other suite's bucket keys can collide with. */
const PREFIX = 'rl-db-test'

function configurePool() {
  process.env.DATABASE_URL = url
}

async function cleanup() {
  await pool().query("delete from rate_limits where bucket like $1", [`${PREFIX}:%`])
}

suite('rate limit (database)', () => {
  beforeAll(configurePool)

  beforeEach(async () => {
    await resetRateLimits()
    await cleanup()
  })

  afterAll(async () => {
    await cleanup()
    await closeDb()
  })

  it('holds a count set by a row this process never wrote to its own memory', async () => {
    // Simulates a sibling Vercel instance: written straight to Postgres,
    // never through this process's `check()`, so nothing in this process's
    // memory knows about it.
    const key = `${PREFIX}:preset-${Date.now()}`
    const options = { limit: 3, windowMs: 60_000 }
    const now = Date.now()
    const windowStart = new Date(Math.floor(now / options.windowMs) * options.windowMs)

    await pool().query(
      'insert into rate_limits (bucket, window_start, count) values ($1, $2, $3)',
      [key, windowStart.toISOString(), options.limit],
    )

    const decision = await check(key, options, now)
    expect(decision.ok).toBe(false)
    expect(decision.remaining).toBe(0)
    expect(decision.retryAfter).toBeGreaterThan(0)

    const row = await pool().query<{ count: number }>(
      'select count from rate_limits where bucket = $1',
      [key],
    )
    // The refusal still counted: a script retrying past the limit does not
    // get to probe for free.
    expect(Number(row.rows[0].count)).toBe(options.limit + 1)
  })

  it('increments one shared row across repeated calls, atomically', async () => {
    const key = `${PREFIX}:count-${Date.now()}`
    const options = { limit: 5, windowMs: 60_000 }
    const now = Date.now()

    // Twenty concurrent calls against the same bucket — the case an upsert
    // that reads then writes in two statements loses: two callers can read
    // the same count and both write the same increment, undercounting.
    const decisions = await Promise.all(
      Array.from({ length: 20 }, () => check(key, options, now)),
    )

    expect(decisions.filter((d) => d.ok)).toHaveLength(options.limit)
    expect(decisions.filter((d) => !d.ok)).toHaveLength(20 - options.limit)

    const row = await pool().query<{ count: number }>(
      'select count from rate_limits where bucket = $1',
      [key],
    )
    expect(Number(row.rows[0].count)).toBe(20)
  })

  it('resetRateLimits() clears only the buckets this process touched', async () => {
    const mine = `${PREFIX}:mine-${Date.now()}`
    const someoneElses = `${PREFIX}:someone-elses-${Date.now()}`
    const options = { limit: 1, windowMs: 60_000 }
    const now = Date.now()
    const windowStart = new Date(Math.floor(now / options.windowMs) * options.windowMs)

    // A bucket this process actually checked...
    await check(mine, options, now)
    // ...and one written directly, the way another suite's own row would be.
    await pool().query(
      'insert into rate_limits (bucket, window_start, count) values ($1, $2, 1)',
      [someoneElses, windowStart.toISOString()],
    )

    await resetRateLimits()

    const rows = await pool().query<{ bucket: string }>(
      'select bucket from rate_limits where bucket = any($1::text[])',
      [[mine, someoneElses]],
    )
    expect(rows.rows.map((row) => row.bucket)).toEqual([someoneElses])
  })
})
