import { after } from 'next/server'

/**
 * `POST /wake` — telling the worker that somebody is on screen (spec §3.1, §7.3).
 *
 * The worker's consumer sleeps `DEFAULT_POLL_INTERVAL_SECONDS = 120` between
 * drains, and that number is deliberate: a two-second poll would keep the Neon
 * compute awake and spend the Free plan's 100 CU-hours on finding nothing. The
 * price of that choice is that a job inserted one second after a drain waits
 * up to two minutes to run. Measured in production on 2026-09-21: three
 * `company_lookup` jobs whose work took ~1.9 s took 9 s, 82 s and 107 s
 * end to end, all of it idle poll.
 *
 * `POST /wake` is the release valve the worker already serves
 * (`worker/licitaqui/server.py`): it notifies the consumer's `WakeSignal`, the
 * pause ends, and the job starts within a second. It carries no payload — a
 * leaked endpoint can make the worker look at its own queue and nothing else.
 *
 * ## Why nothing here is ever awaited by a request
 *
 * §3's golden rule is that no web request waits on a slow call, and the worker
 * is the slowest kind of call there is: one that is usually *absent*.
 * `WORKER_URL` is unset in preview, points at `localhost` in dev, and is
 * unreachable in production until the Easypanel container exists. So this
 * module is built so that the worst case — a worker that accepts the
 * connection and never answers — costs the user nothing:
 *
 * 1. an unset `WORKER_URL` or `WORKER_WAKE_TOKEN` returns before any I/O;
 * 2. the POST is handed to `after()`, which runs it once the response has been
 *    sent, so it is off the request's critical path by construction;
 * 3. it aborts after {@link WAKE_TIMEOUT_MS};
 * 4. every failure is swallowed. A wake that does not arrive costs at most the
 *    two-minute poll we already have — the job is on the queue either way.
 *
 * ## Never in a log
 *
 * The bearer token is a shared secret (§12) and so is anything a misconfigured
 * `WORKER_URL` might carry in its userinfo. Nothing below logs either: the one
 * log line carries an HTTP status code and no more.
 */

/**
 * How long the POST may take before it is abandoned. The worker answers `202`
 * after setting an in-process `threading.Event`, so a healthy one replies in
 * milliseconds; anything past this is a worker that is not going to help.
 */
export const WAKE_TIMEOUT_MS = 1_500

/**
 * The two variables this reads:
 *
 * | name | what it is |
 * |---|---|
 * | `WORKER_URL` | origin of the worker's HTTP surface, e.g. `https://worker.example.com` |
 * | `WORKER_WAKE_TOKEN` | the shared secret `worker/licitaqui/server.py` compares against |
 *
 * An index signature rather than those two keys, so `process.env` itself is
 * assignable and the default argument needs no cast.
 */
type WakeEnv = Record<string, string | undefined>

export type WakeTarget = { url: string; token: string }

/**
 * The endpoint to call, or `null` when the worker is not configured — which is
 * the normal state of preview and of local development, and must therefore be
 * silent rather than an error.
 */
export function wakeTarget(env: WakeEnv = process.env): WakeTarget | null {
  const origin = env.WORKER_URL?.trim()
  const token = env.WORKER_WAKE_TOKEN?.trim()
  if (!origin || !token) return null
  try {
    // `new URL` rather than string concatenation: it normalises a trailing
    // slash, and it rejects a malformed value here instead of at fetch time.
    return { url: new URL('/wake', origin).toString(), token }
  } catch {
    return null
  }
}

export type WakeOptions = {
  env?: WakeEnv
  /** Injected by the tests; nothing in the product passes it. */
  fetch?: typeof fetch
}

/**
 * Posts the wake and reports whether the worker accepted it. Never throws:
 * an unreachable host, a DNS failure and a timeout are all the same answer —
 * `false`, and the queue's own poll will pick the job up.
 */
export async function postWake(
  target: WakeTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const response = await fetchImpl(target.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(WAKE_TIMEOUT_MS),
      cache: 'no-store',
    })
    // The body is `{"woken":true}` and nothing reads it; cancelling it releases
    // the socket instead of leaving it open until the runtime collects it.
    await response.body?.cancel().catch(() => undefined)
    if (!response.ok) {
      // Status only. A 401 here means the two sides hold different secrets,
      // which is exactly the thing that must not be printed to find that out.
      console.warn(`worker wake refused (${response.status})`)
      return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Wake the worker after this response has been sent. Returns immediately, and
 * returns `void` on purpose: there is no promise for a caller to await by
 * accident.
 *
 * Callers should reach this through `readOrEnqueue`, which knows when a
 * priority-1 job was actually inserted; calling it on a cache hit would be
 * load with nothing behind it.
 */
export function wakeWorker(options: WakeOptions = {}): void {
  const target = wakeTarget(options.env)
  if (!target) return

  const run = async () => {
    await postWake(target, options.fetch)
  }

  try {
    after(run)
  } catch {
    // `after()` throws outside a request scope — a unit test, or a script.
    // Fire and forget instead; still nothing is awaited and nothing throws.
    void run()
  }
}
