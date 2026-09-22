import type { JobRef } from './contract'

/**
 * The "analyzing" loop of spec §3.1, step 4:
 *
 * > If it does not exist: enqueue with high priority and respond `202` +
 * > "analyzing" state. **The client polls every 3 s (max 60 s)**.
 *
 * Written as a plain async function over injected `read`, `pollJob`, `sleep`
 * and `now` rather than as a React hook, for two reasons:
 *
 *  1. it is the one piece of the Radar with a real policy in it — an interval,
 *     a deadline and a decision about what to do when the job id is `null` —
 *     and a policy that cannot be tested is a policy nobody can change safely;
 *  2. both screens need it, and a hook would tie it to one of them.
 *
 * ## Why it polls the job *and* re-reads
 *
 * `GET /api/jobs/:id` answers "done", not "here is your company": the job
 * writes a row and the route that reads that row is the one that has the data.
 * So a tick asks the job whether it is worth re-reading, and only re-reads when
 * the answer is yes. That keeps twenty polls per minute on the cheap endpoint
 * instead of twenty `company_lookup` reads plus twenty enqueue attempts.
 *
 * ## Why a `null` job id is not an error
 *
 * `enqueueJob` de-duplicates: two hundred people asking for the same CNPJ in
 * the same minute produce one job, and the ones who lost the race get
 * `job.id === null` (`contract.ts`: "Poll anyway"). There is nothing to poll,
 * so those ticks re-read directly — which is exactly right, because somebody
 * else's job is about to write the row they are waiting for.
 */

/** §3.1: every 3 s. */
export const POLL_INTERVAL_MS = 3_000

/** §3.1: for at most 60 s. Twenty ticks. */
export const POLL_TIMEOUT_MS = 60_000

/** What `GET /api/jobs/:id` can tell us, plus "the route said 404". */
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'gone'

export type WaitOptions<T> = {
  /** Re-runs the read that answered `202`. Must be cheap and idempotent. */
  read: () => Promise<T>
  /** The job to wait on, or `null` once the value is no longer "analyzing". */
  analyzing: (value: T) => JobRef | null
  /** Reads `GET /api/jobs/:id`. Omit it to re-read on every tick instead. */
  pollJob?: (id: number) => Promise<JobStatus>
  intervalMs?: number
  timeoutMs?: number
  /** Injected by the tests; `AbortSignal` support keeps React strict mode calm. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  signal?: AbortSignal
}

export type WaitResult<T> = {
  /** The last value read. Still "analyzing" when `timedOut` is true. */
  value: T
  /** 60 s passed and the job had not finished. §3.1 gives no fourth state. */
  timedOut: boolean
  /** Ticks spent waiting. `0` means the first read was already ready. */
  ticks: number
}

export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * §3.1's deadline is written for a read whose job writes its row in one hop —
 * `company_lookup`, one BrasilAPI call. An `ai_screening` is not that: §7.1 and
 * §7.2 give it `sync_files`, a PDF download (120 s), `extract_text` and then the
 * lite model (90 s). The two budgets never agreed, so the poll was structurally
 * certain to give up first, and it gave up *silently*: it stopped reading.
 *
 * Measured on production on 2026-09-22 (CNPJ 36955612000185, tender
 * `13654405000195-1-000033/2026`): the screen said "está demorando" at 60 s and
 * made no further request; the row was readable at **≈178 s**. The user's only
 * way to see their own answer was to navigate away and come back, which is
 * exactly what Sci did and reported.
 *
 * So the deadline stops being where the waiting ends. `waitThenWatch` runs
 * §3.1's twenty three-second ticks, and if they run out with the job still
 * alive it tells the caller — which puts an honest card on screen — and goes on
 * reading, slowly, until the answer lands. That is §3.1's own rule ("respond
 * with what we have, refresh behind it") applied to a screen: the user sees the
 * truth at 60 s and the result replaces it when there is one.
 *
 * Ten seconds is six reads a minute against a route whose limit is forty; five
 * minutes is past the worst case the worker's own timeouts allow.
 */
export const WATCH_INTERVAL_MS = 10_000
export const WATCH_TIMEOUT_MS = 5 * 60_000

export type WatchOptions<T> = WaitOptions<T> & {
  /**
   * The first deadline passed and the job is still running. Called once, with
   * the last value read, before the slow phase starts — this is where a screen
   * says "está demorando" without also saying "and I have stopped looking".
   */
  onTimeout?: (value: T) => void
  intervalMs?: number
  timeoutMs?: number
  watchIntervalMs?: number
  watchTimeoutMs?: number
}

export type WatchResult<T> = WaitResult<T> & {
  /** The slow phase ran, so `onTimeout` has already been called. */
  watched: boolean
}

export async function waitThenWatch<T>(options: WatchOptions<T>): Promise<WatchResult<T>> {
  const first = await waitForData(options)
  if (!first.timedOut) return { ...first, watched: false }

  options.onTimeout?.(first.value)

  const second = await waitForData({
    ...options,
    intervalMs: options.watchIntervalMs ?? WATCH_INTERVAL_MS,
    timeoutMs: options.watchTimeoutMs ?? WATCH_TIMEOUT_MS,
  })
  return { ...second, ticks: first.ticks + second.ticks, watched: true }
}

export async function waitForData<T>(options: WaitOptions<T>): Promise<WaitResult<T>> {
  const interval = options.intervalMs ?? POLL_INTERVAL_MS
  const timeout = options.timeoutMs ?? POLL_TIMEOUT_MS
  const sleep = options.sleep ?? delay
  const now = options.now ?? (() => Date.now())

  const deadline = now() + timeout
  let value = await options.read()
  let ticks = 0

  while (options.analyzing(value) !== null) {
    // One more tick has to fit inside the 60 s window, or we stop and say so
    // rather than overshooting it by an interval.
    if (now() + interval > deadline) break
    await sleep(interval, options.signal)
    ticks += 1

    const job = options.analyzing(value)
    if (job && job.id !== null && options.pollJob) {
      const status = await options.pollJob(job.id)
      // `failed` and `gone` still get a read: a failed `company_lookup` writes
      // the placeholder row that turns the screen into "enter your CNAE by
      // hand", which is a better answer than a spinner that never stops.
      if (status === 'queued' || status === 'running') continue
    }

    value = await options.read()
  }

  return { value, timedOut: options.analyzing(value) !== null, ticks }
}
