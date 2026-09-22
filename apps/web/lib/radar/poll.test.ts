import { describe, expect, it } from 'vitest'
import type { JobRef } from './contract'
import {
  delay,
  POLL_INTERVAL_MS,
  POLL_TIMEOUT_MS,
  waitForData,
  waitThenWatch,
  WATCH_INTERVAL_MS,
  WATCH_TIMEOUT_MS,
  type JobStatus,
} from './poll'

/**
 * Spec §3.1: "The client polls every 3 s (max 60 s)". These tests are the
 * statement of that policy — a virtual clock, so sixty seconds of waiting takes
 * no real time and the tick count is exact rather than approximate.
 */

type Answer = { state: 'ready' } | { state: 'analyzing'; job: JobRef }

const READY: Answer = { state: 'ready' }
const analyzing = (id: number | null): Answer => ({ state: 'analyzing', job: { id, kind: 'company_lookup' } })

function clock() {
  let at = 0
  return {
    now: () => at,
    sleep: async (ms: number) => {
      at += ms
    },
  }
}

/** Answers from a script, then repeats the last entry for ever. */
function scripted(script: Answer[]) {
  const calls: number[] = []
  return {
    calls,
    read: async () => {
      const index = Math.min(calls.length, script.length - 1)
      calls.push(index)
      return script[index]
    },
  }
}

const isAnalyzing = (value: Answer) => (value.state === 'analyzing' ? value.job : null)

describe('waitForData', () => {
  it('does not wait at all when the first read is ready', async () => {
    const { read, calls } = scripted([READY])
    const result = await waitForData({ read, analyzing: isAnalyzing, ...clock() })

    expect(result.timedOut).toBe(false)
    expect(result.ticks).toBe(0)
    expect(calls).toHaveLength(1)
  })

  it('polls the job and only re-reads once the job has left the queue', async () => {
    const { read, calls } = scripted([analyzing(7), READY])
    const statuses: JobStatus[] = ['queued', 'running', 'done']
    const polled: number[] = []

    const result = await waitForData({
      read,
      analyzing: isAnalyzing,
      pollJob: async (id) => {
        polled.push(id)
        return statuses[polled.length - 1] ?? 'done'
      },
      ...clock(),
    })

    expect(result.value).toEqual(READY)
    expect(result.timedOut).toBe(false)
    // Three ticks: two of them said "still queued" and cost one cheap job poll
    // each; only the third spent a read.
    expect(result.ticks).toBe(3)
    expect(polled).toEqual([7, 7, 7])
    expect(calls).toHaveLength(2)
  })

  it('re-reads on a failed job: the placeholder row it wrote is the answer', async () => {
    const { read, calls } = scripted([analyzing(9), READY])
    const result = await waitForData({
      read,
      analyzing: isAnalyzing,
      pollJob: async () => 'failed',
      ...clock(),
    })

    expect(result.timedOut).toBe(false)
    expect(result.ticks).toBe(1)
    expect(calls).toHaveLength(2)
  })

  it('re-reads every tick when the job was de-duplicated away (id null)', async () => {
    const { read, calls } = scripted([analyzing(null), analyzing(null), READY])
    let polls = 0

    const result = await waitForData({
      read,
      analyzing: isAnalyzing,
      pollJob: async () => {
        polls += 1
        return 'done'
      },
      ...clock(),
    })

    expect(polls).toBe(0)
    expect(result.ticks).toBe(2)
    expect(calls).toHaveLength(3)
  })

  it('gives up after 60 s, at 3 s a tick, and says so instead of hanging', async () => {
    const { read, calls } = scripted([analyzing(1)])
    const result = await waitForData({
      read,
      analyzing: isAnalyzing,
      pollJob: async () => 'running',
      ...clock(),
    })

    expect(result.timedOut).toBe(true)
    expect(result.ticks).toBe(POLL_TIMEOUT_MS / POLL_INTERVAL_MS)
    expect(result.ticks).toBe(20)
    // Every tick was a job poll, so the expensive read ran exactly once.
    expect(calls).toHaveLength(1)
  })

  it('honours the spec numbers by default', () => {
    expect(POLL_INTERVAL_MS).toBe(3_000)
    expect(POLL_TIMEOUT_MS).toBe(60_000)
  })
})

/**
 * The defect: the screen gave up reading at 60 s, said "está demorando", and
 * stopped. The `ai_screening` it was waiting on finished at ≈178 s on
 * production and its result sat unread in `ai_analyses` until the user
 * navigated away and came back — a screening they had already paid for, shown
 * only on the second visit.
 */
describe('waitThenWatch', () => {
  /** 60 s at 3 s, then 5 min at 10 s: the tick the answer arrives on. */
  const WATCH_TICKS = WATCH_TIMEOUT_MS / WATCH_INTERVAL_MS

  it('is plain waitForData when the answer comes inside the 60 s', async () => {
    const { read } = scripted([analyzing(7), READY])
    let timeouts = 0

    const result = await waitThenWatch({
      read,
      analyzing: isAnalyzing,
      onTimeout: () => {
        timeouts += 1
      },
      ...clock(),
    })

    expect(result.watched).toBe(false)
    expect(result.timedOut).toBe(false)
    expect(timeouts).toBe(0)
  })

  it('keeps reading past 60 s, and finds the answer the old poll never saw', async () => {
    // Eleven analyzing reads: twenty ticks of §3.1 cannot get there, because
    // each of them is spent on the cheap job poll while the job is running.
    const script: Answer[] = [...Array<Answer>(11).fill(analyzing(7)), READY]
    const { read } = scripted(script)
    let jobStatus: JobStatus = 'running'
    const timedOutAt: Answer[] = []

    const result = await waitThenWatch({
      read,
      analyzing: isAnalyzing,
      // The job stays `running` through §3.1's window and finishes during the
      // watch — the production shape, where the AI call alone may take 90 s.
      pollJob: async () => jobStatus,
      onTimeout: (value) => {
        timedOutAt.push(value)
        jobStatus = 'done'
      },
      ...clock(),
    })

    // The screen was told, once, that the deadline had passed…
    expect(timedOutAt).toHaveLength(1)
    expect(timedOutAt[0].state).toBe('analyzing')
    // …and then the answer arrived anyway, with no second navigation.
    expect(result.watched).toBe(true)
    expect(result.timedOut).toBe(false)
    expect(result.value).toEqual(READY)
  })

  it('gives up for good only after the watch, and still says it timed out', async () => {
    const { read } = scripted([analyzing(1)])
    const result = await waitThenWatch({
      read,
      analyzing: isAnalyzing,
      pollJob: async () => 'running',
      ...clock(),
    })

    expect(result.watched).toBe(true)
    expect(result.timedOut).toBe(true)
    expect(result.ticks).toBe(POLL_TIMEOUT_MS / POLL_INTERVAL_MS + WATCH_TICKS)
  })

  it('reads six times a minute while watching, well under the route’s forty', async () => {
    expect(WATCH_INTERVAL_MS).toBe(10_000)
    expect(60_000 / WATCH_INTERVAL_MS).toBeLessThan(40)
    // Past the worst case §7.2 allows: a 120 s download plus a 90 s AI call.
    expect(WATCH_TIMEOUT_MS).toBeGreaterThan(120_000 + 90_000)
  })
})

describe('delay', () => {
  it('rejects immediately when the caller has already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(delay(5, controller.signal)).rejects.toBeDefined()
  })

  it('rejects when aborted while waiting, and leaves no timer behind', async () => {
    const controller = new AbortController()
    const pending = delay(10_000, controller.signal)
    controller.abort()
    await expect(pending).rejects.toBeDefined()
  })
})
