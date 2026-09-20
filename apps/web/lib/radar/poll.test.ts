import { describe, expect, it } from 'vitest'
import type { JobRef } from './contract'
import { delay, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, waitForData, type JobStatus } from './poll'

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
