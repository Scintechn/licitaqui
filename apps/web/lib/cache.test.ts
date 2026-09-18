import { describe, expect, it } from 'vitest'
import { PERMANENT, readOrEnqueue, TTL, type CacheRead } from './cache'
import type { Executor } from './db'
import { JOB_KINDS } from './jobs'

/**
 * `readOrEnqueue()` without a database: the decision itself.
 *
 * The three states are also asserted end to end in `lib/radar/radar.db.test.ts`,
 * against real rows and the real `jobs` table. These are here because the
 * *boundaries* — one millisecond inside the TTL, one outside, a row with no
 * `updated_at`, a permanent row a year old — are tedious to arrange in a
 * database and trivial to state here, and because a wrong boundary is the kind
 * of bug that shows up as "the worker is busy" six weeks later.
 */

/** A stand-in for the pool that records the statements it is handed. */
function recorder() {
  const statements: string[] = []
  const executor = {
    // Drizzle's SQL object has no useful toString; its chunks do.
    execute: async (query: unknown) => {
      statements.push(JSON.stringify(query))
      return { rows: [{ id: 1 }] }
    },
  } as unknown as Executor
  return { executor, statements }
}

const NOW = new Date('2026-09-18T12:00:00.000Z')

function found(data: string, updatedAt: Date | null, ttl?: number | null): CacheRead<string> {
  return { data, updatedAt, ...(ttl === undefined ? {} : { ttl }) }
}

const refresh = { kind: JOB_KINDS.companyLookup, key: 'company:abc' } as const

describe('readOrEnqueue', () => {
  it('serves a fresh row and enqueues nothing', async () => {
    const { executor, statements } = recorder()
    const result = await readOrEnqueue({
      read: async () => found('cached', new Date(NOW.getTime() - 60_000)),
      ttl: TTL.tenderHeader,
      refresh,
      executor,
      now: NOW,
    })

    expect(result.state).toBe('fresh')
    expect(result.data).toBe('cached')
    expect(result.status).toBe(200)
    expect(result.ageSeconds).toBe(60)
    expect(result.job).toBeNull()
    expect(statements).toEqual([])
  })

  it('serves a stale row AND enqueues the refresh at priority 5', async () => {
    const { executor, statements } = recorder()
    const result = await readOrEnqueue({
      read: async () => found('cached', new Date(NOW.getTime() - TTL.tenderHeader - 1)),
      ttl: TTL.tenderHeader,
      refresh,
      executor,
      now: NOW,
    })

    // The point of the whole pattern: the answer does not wait for the refresh.
    expect(result.state).toBe('stale')
    expect(result.data).toBe('cached')
    expect(result.status).toBe(200)
    expect(result.job).toMatchObject({ kind: 'company_lookup', id: 1, deduped: false })
    expect(statements).toHaveLength(1)
    expect(statements[0]).toContain('insert into jobs')
  })

  it('answers absent with 202 and enqueues at priority 1', async () => {
    const { executor, statements } = recorder()
    const result = await readOrEnqueue({
      read: async () => null,
      ttl: TTL.company,
      refresh,
      executor,
      now: NOW,
    })

    expect(result.state).toBe('absent')
    expect(result.data).toBeNull()
    expect(result.status).toBe(202)
    expect(result.ageSeconds).toBeNull()
    expect(result.job?.id).toBe(1)
    expect(statements).toHaveLength(1)
  })

  it('treats the TTL boundary as still fresh, and one millisecond past it as stale', async () => {
    const { executor } = recorder()
    const atBoundary = await readOrEnqueue({
      read: async () => found('x', new Date(NOW.getTime() - TTL.tenderItems + 1)),
      ttl: TTL.tenderItems,
      refresh,
      executor,
      now: NOW,
    })
    const pastBoundary = await readOrEnqueue({
      read: async () => found('x', new Date(NOW.getTime() - TTL.tenderItems)),
      ttl: TTL.tenderItems,
      refresh,
      executor,
      now: NOW,
    })

    expect(atBoundary.state).toBe('fresh')
    expect(pastBoundary.state).toBe('stale')
  })

  it('never lets a permanent row go stale, however old it is', async () => {
    const { executor, statements } = recorder()
    const result = await readOrEnqueue({
      read: async () => found('closed tender', new Date('2019-01-01T00:00:00.000Z'), PERMANENT),
      ttl: TTL.tenderItems,
      refresh,
      executor,
      now: NOW,
    })

    expect(result.state).toBe('fresh')
    expect(result.ageSeconds).toBeGreaterThan(200_000_000)
    expect(statements).toEqual([])
  })

  it('treats a row with no updated_at as stale rather than claiming it is fresh', async () => {
    const { executor } = recorder()
    const result = await readOrEnqueue({
      read: async () => found('x', null),
      ttl: TTL.company,
      refresh,
      executor,
      now: NOW,
    })

    expect(result.state).toBe('stale')
    expect(result.ageSeconds).toBeNull()
    expect(result.job).not.toBeNull()
  })

  it('honours a per-row TTL that is shorter than the default', async () => {
    const { executor } = recorder()
    // A company row with no CNAEs: 6 hours, not 30 days.
    const result = await readOrEnqueue({
      read: async () =>
        found('placeholder', new Date(NOW.getTime() - 7 * 60 * 60 * 1000), TTL.companyUnresolved),
      ttl: TTL.company,
      refresh,
      executor,
      now: NOW,
    })

    expect(result.state).toBe('stale')
  })

  it('enqueues nothing when the caller says it may not', async () => {
    const { executor, statements } = recorder()
    const stale = await readOrEnqueue({
      read: async () => found('x', new Date('2019-01-01T00:00:00.000Z')),
      ttl: TTL.openTenderList,
      refresh,
      enqueue: false,
      executor,
      now: NOW,
    })

    expect(stale.state).toBe('stale')
    expect(stale.job).toBeNull()
    expect(statements).toEqual([])
  })

  it('can refuse to enqueue for an absent row the worker could not create', async () => {
    const { executor, statements } = recorder()
    const result = await readOrEnqueue({
      read: async () => null,
      ttl: TTL.tenderItems,
      refresh,
      enqueueWhenAbsent: false,
      executor,
      now: NOW,
    })

    expect(result.state).toBe('absent')
    expect(result.job).toBeNull()
    expect(statements).toEqual([])
  })
})

describe('the §3.2 TTL table', () => {
  it('matches the spec, in milliseconds', () => {
    expect(TTL.openTenderList).toBe(30 * 60 * 1000)
    expect(TTL.tenderHeader).toBe(6 * 60 * 60 * 1000)
    expect(TTL.tenderItems).toBe(12 * 60 * 60 * 1000)
    expect(TTL.tenderFiles).toBe(12 * 60 * 60 * 1000)
    expect(TTL.company).toBe(30 * 24 * 60 * 60 * 1000)
    expect(TTL.marketPrice).toBe(7 * 24 * 60 * 60 * 1000)
    // "permanent" in the spec's table: an award once made, and an AI analysis,
    // which is replaced by a new row rather than refreshed.
    expect(TTL.award).toBe(PERMANENT)
    expect(TTL.aiAnalysis).toBe(PERMANENT)
  })

  it('agrees with the worker on how long a failed company lookup lasts', () => {
    // `licitaqui.company.FALLBACK_TTL = timedelta(hours=6)`. A shorter value
    // here would only queue jobs the worker declines to act on.
    expect(TTL.companyUnresolved).toBe(6 * 60 * 60 * 1000)
  })
})
