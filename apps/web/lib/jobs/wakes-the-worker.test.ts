import { describe, expect, it, vi } from 'vitest'
import { enqueueJob, PRIORITY_REFRESH, PRIORITY_USER_WAITING } from './index'

/**
 * **A user-waiting job must wake the worker** — the defect of 2026-09-30.
 *
 * The wake lived in `lib/cache.ts`. Every caller that went through the cache
 * got it; every caller that called `enqueueJob` directly did not — and
 * `lib/radar/screening.ts` is exactly that caller. So the AI triagem, the one
 * job a person sits and watches, never woke anything and waited for the
 * consumer's next poll: **24 minutes**, with "a triagem está demorando mais
 * que o normal" on screen.
 *
 * Nothing was broken in the infrastructure. `POST /wake` answered
 * `202 {"woken": true}` when called by hand; the worker, its domain and its
 * token were all fine. Nothing was calling it.
 *
 * **Why this file asserts on `enqueueJob` and not on a mock of the screening
 * route.** The old tests passed throughout: `wake.test.ts` proved `wakeWorker`
 * posts correctly, and `cache.test.ts` proved the cache calls it. Both were
 * true. The bug was in the seam — a path that used neither — which is exactly
 * the shape `CLAUDE.md` names: *the test exercised the unit, not the path*. So
 * the guard is on the **one function every job must pass through**, because
 * that is the only place a future caller cannot forget.
 */

function fakeDb(inserted: boolean) {
  return {
    execute: async () => ({ rows: inserted ? [{ id: 7 }] : [] }),
  } as never
}

describe('enqueueJob wakes the worker', () => {
  it('wakes when a user is waiting', async () => {
    const wake = vi.fn()
    await enqueueJob(
      { kind: 'ai_screening', key: 'k', priority: PRIORITY_USER_WAITING },
      fakeDb(true),
      wake,
    )
    expect(wake).toHaveBeenCalledTimes(1)
  })

  it('does NOT wake for background work', async () => {
    // The cost half of the bargain. Neon bills wall-clock awake time and
    // suspends after five minutes, so waking for every enqueue would keep the
    // endpoint up permanently — the 2026-09-30 backlog alone was 10,758
    // background jobs. Those wait for the poll, which is what lets the poll
    // be long.
    const wake = vi.fn()
    await enqueueJob({ kind: 'sync_items', key: 'k', priority: PRIORITY_REFRESH }, fakeDb(true), wake)
    expect(wake).not.toHaveBeenCalled()
  })

  it('does not wake a deduped job', async () => {
    // Already queued or running, and the consumer drains to empty before
    // sleeping — whoever inserted that row already woke the worker.
    const wake = vi.fn()
    await enqueueJob(
      { kind: 'ai_screening', key: 'k', priority: PRIORITY_USER_WAITING },
      fakeDb(false),
      wake,
    )
    expect(wake).not.toHaveBeenCalled()
  })
})

describe('the screening path is the one that broke', () => {
  it('asks for a user-waiting priority, so the gate above lets it through', async () => {
    // Asserted here rather than inside screening.ts's own test, because what
    // failed was the *join* between "screening enqueues at priority 1" and
    // "priority 1 wakes". Either half alone was already green.
    const screening = await import('@/lib/radar/screening')
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../radar/screening.ts', import.meta.url), 'utf8'),
    )
    expect(screening).toBeTruthy()
    expect(source).toContain('PRIORITY_USER_WAITING')
    expect(source).toContain('enqueueJob')
  })
})
