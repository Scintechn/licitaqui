import { afterEach, describe, expect, it, vi } from 'vitest'
import { readOrEnqueue, TTL } from '@/lib/cache'
import type { Executor } from '@/lib/db'
import { JOB_KINDS } from '@/lib/jobs'
import { postWake, wakeTarget, wakeWorker, WAKE_TIMEOUT_MS } from './wake'

/**
 * The wake, and — mostly — the ways it must fail.
 *
 * The happy path here is one POST. The reason this file is long is the other
 * three quarters of it: `WORKER_URL` is unset in preview, points at
 * `localhost` in dev, and is unreachable in production until the worker
 * container exists, so **absent and broken are the normal cases** and the one
 * outcome that would take the site down is a wake that leaks into the request.
 * Every test below that measures time or asserts "the response is identical"
 * is guarding that, not the feature.
 */

const TOKEN = 'wake-secret-value'
const ENV = { WORKER_URL: 'https://worker.example.com', WORKER_WAKE_TOKEN: TOKEN }

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete process.env.WORKER_URL
  delete process.env.WORKER_WAKE_TOKEN
})

/** A pool stand-in: every insert reports a new row, so nothing is deduped. */
function recorder(rows: Array<Record<string, unknown>> = [{ id: 1 }]) {
  const statements: string[] = []
  const executor = {
    execute: async (query: unknown) => {
      statements.push(JSON.stringify(query))
      return { rows }
    },
  } as unknown as Executor
  return { executor, statements }
}

const refresh = { kind: JOB_KINDS.companyLookup, key: 'company:abc' } as const

/** A fetch that accepts the connection and never answers — the worst worker. */
function hangingFetch() {
  return vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch
}

function answeringFetch(status = 202) {
  return vi.fn(
    async () => new Response(JSON.stringify({ woken: true }), { status }),
  ) as unknown as typeof fetch
}

/* ------------------------------------------------------------------ target */

describe('wakeTarget', () => {
  it('is null when the worker is not configured, which is preview and dev', () => {
    expect(wakeTarget({})).toBeNull()
    expect(wakeTarget({ WORKER_URL: 'https://worker.example.com' })).toBeNull()
    expect(wakeTarget({ WORKER_WAKE_TOKEN: TOKEN })).toBeNull()
    expect(wakeTarget({ WORKER_URL: '   ', WORKER_WAKE_TOKEN: TOKEN })).toBeNull()
    expect(wakeTarget({ WORKER_URL: 'https://worker.example.com', WORKER_WAKE_TOKEN: '  ' })).toBeNull()
  })

  it('builds /wake from the origin, whatever the trailing slash or path says', () => {
    expect(wakeTarget(ENV)?.url).toBe('https://worker.example.com/wake')
    expect(wakeTarget({ ...ENV, WORKER_URL: 'https://worker.example.com/' })?.url).toBe(
      'https://worker.example.com/wake',
    )
    expect(wakeTarget({ ...ENV, WORKER_URL: 'http://localhost:8080' })?.url).toBe(
      'http://localhost:8080/wake',
    )
  })

  it('treats a malformed WORKER_URL as "not configured", never as a crash', () => {
    expect(wakeTarget({ ...ENV, WORKER_URL: 'not a url' })).toBeNull()
  })

  it('keeps the token out of the URL: it travels as a bearer header or not at all', () => {
    expect(wakeTarget(ENV)?.url).not.toContain(TOKEN)
  })
})

/* -------------------------------------------------------------------- post */

describe('postWake', () => {
  it('posts to /wake with the shared secret and a deadline', async () => {
    const fetchImpl = answeringFetch()
    const target = wakeTarget(ENV)!

    expect(await postWake(target, fetchImpl)).toBe(true)

    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ]
    expect(url).toBe('https://worker.example.com/wake')
    expect(init.method).toBe('POST')
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
    // A hung worker must not hold the function open for its whole budget.
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(WAKE_TIMEOUT_MS).toBeLessThanOrEqual(2_000)
  })

  it('swallows an unreachable worker: the job is queued either way', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch

    await expect(postWake(wakeTarget(ENV)!, fetchImpl)).resolves.toBe(false)
  })

  it('swallows a refusal, and logs the status without the token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await postWake(wakeTarget(ENV)!, answeringFetch(401))).toBe(false)

    expect(warn).toHaveBeenCalledTimes(1)
    const line = String(warn.mock.calls[0]?.[0])
    expect(line).toContain('401')
    expect(line).not.toContain(TOKEN)
  })
})

/* ------------------------------------------------------------------ caller */

describe('wakeWorker', () => {
  it('does nothing at all when the worker is not configured', () => {
    const fetchImpl = answeringFetch()
    wakeWorker({ env: {}, fetch: fetchImpl })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns void, so no caller can await it by accident', () => {
    expect(wakeWorker({ env: {}, fetch: answeringFetch() })).toBeUndefined()
  })

  it('returns before a hung worker has answered anything', () => {
    const started = performance.now()
    wakeWorker({ env: ENV, fetch: hangingFetch() })
    expect(performance.now() - started).toBeLessThan(50)
  })
})

/* ---------------------------------------------- the rule: absent, inserted */

describe('readOrEnqueue and the wake', () => {
  it('wakes the worker when it inserts a priority-1 job for an absent row', async () => {
    const wake = vi.fn()
    const { executor, statements } = recorder()

    const result = await readOrEnqueue({
      read: async () => null,
      ttl: TTL.company,
      refresh,
      executor,
      wake,
    })

    expect(result.state).toBe('absent')
    expect(result.status).toBe(202)
    expect(statements).toHaveLength(1)
    expect(wake).toHaveBeenCalledTimes(1)
  })

  it('does not wake for a cache hit — there is nothing on the queue to run', async () => {
    const wake = vi.fn()
    const { executor } = recorder()

    await readOrEnqueue({
      read: async () => ({ data: 'cached', updatedAt: new Date() }),
      ttl: TTL.company,
      refresh,
      executor,
      wake,
    })

    expect(wake).not.toHaveBeenCalled()
  })

  it('does not wake for a stale refresh: the user already has an answer', async () => {
    const wake = vi.fn()
    const { executor } = recorder()

    const result = await readOrEnqueue({
      read: async () => ({ data: 'cached', updatedAt: new Date('2019-01-01T00:00:00.000Z') }),
      ttl: TTL.company,
      refresh,
      executor,
      wake,
    })

    expect(result.state).toBe('stale')
    expect(result.job).not.toBeNull()
    expect(wake).not.toHaveBeenCalled()
  })

  it('does not wake when the insert was deduped: that job already woke it', async () => {
    const wake = vi.fn()
    // `on conflict … do nothing` returns no row.
    const { executor } = recorder([])

    const result = await readOrEnqueue({
      read: async () => null,
      ttl: TTL.company,
      refresh,
      executor,
      wake,
    })

    expect(result.job).toMatchObject({ deduped: true, id: null })
    expect(wake).not.toHaveBeenCalled()
  })

  it('does not wake when nothing was enqueued at all', async () => {
    const wake = vi.fn()
    const { executor } = recorder()

    await readOrEnqueue({
      read: async () => null,
      ttl: TTL.tenderItems,
      refresh,
      executor,
      enqueueWhenAbsent: false,
      wake,
    })

    expect(wake).not.toHaveBeenCalled()
  })
})

/* ------------------------------------------- the failure that must not ship */

describe('an absent or unreachable worker costs the request nothing', () => {
  /** The real wake, through `process.env` and the global `fetch`. */
  async function absentRead() {
    const { executor } = recorder()
    const started = performance.now()
    const result = await readOrEnqueue({
      read: async () => null,
      ttl: TTL.company,
      refresh,
      executor,
      now: new Date('2026-09-21T12:00:00.000Z'),
    })
    return { result, elapsed: performance.now() - started }
  }

  it('answers identically, and as fast, whether WORKER_URL is set, hung or absent', async () => {
    // 1. No worker configured — preview, and every local `pnpm test`.
    const never = answeringFetch()
    vi.stubGlobal('fetch', never)
    const unset = await absentRead()
    expect(never).not.toHaveBeenCalled()

    // 2. A worker that accepts the connection and never answers.
    process.env.WORKER_URL = ENV.WORKER_URL
    process.env.WORKER_WAKE_TOKEN = TOKEN
    const hung = hangingFetch()
    vi.stubGlobal('fetch', hung)
    const hanging = await absentRead()

    // 3. A worker that is simply not there — `localhost` in dev, Easypanel
    //    before it exists. The rejection must not escape into the request.
    const refused = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', refused)
    const unreachable = await absentRead()

    // The response is the same object in all three worlds.
    expect(hanging.result).toEqual(unset.result)
    expect(unreachable.result).toEqual(unset.result)
    expect(unset.result.status).toBe(202)

    // And so is the time it took. The bar is absolute rather than relative to
    // the unset case, whose own timing is dominated by test scheduling noise.
    expect(hanging.elapsed).toBeLessThan(50)
    expect(unreachable.elapsed).toBeLessThan(50)

    // It really did try: the point is that trying is free, not that it is skipped.
    expect(hung).toHaveBeenCalledTimes(1)
    expect(refused).toHaveBeenCalledTimes(1)

    // Let the rejected wake settle inside `postWake`'s catch, so a leak would
    // surface here as an unhandled rejection rather than in an unrelated file.
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
})
