import { createHash } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db } from './db'

/**
 * A fixed-window rate limiter for public routes (spec §8: "rate limit per IP").
 *
 * ## Durable by default, in-memory as a fallback
 *
 * Spec §3.3 puts rate limiting in Postgres. This now does that: every check is
 * an atomic `insert … on conflict (bucket, window_start) do update set count =
 * count + 1` against a `rate_limits` table (migration, its own PR per
 * CLAUDE.md), so the count is shared across every Vercel lambda instance and
 * survives an IP rotation, instead of resetting per instance the way a `Map`
 * on `globalThis` does. `POST /api/founders` and `POST
 * /api/tenders/:id/screening` both go through this file — the first lets a
 * script queue real WhatsApp sends to a stranger faster than one instance's
 * window would catch, the second spends real OpenRouter credit per uncached
 * request, and one fix here closes both.
 *
 * The `Map` stays as the fallback for when the database itself is
 * unreachable: a rate limiter that fails closed on a database hiccup would
 * take the signup and the screening endpoint down with it, which is a worse
 * outcome than a speed bump that briefly forgets other instances' counts. So
 * `checkDb()` is tried first; only a thrown error (no `DATABASE_URL`, a
 * connection failure, a timeout) falls through to `checkMemory()`.
 *
 * ## The IP never gets stored
 *
 * §12 forbids logging personal data, and an IP address is personal data under
 * the LGPD. The key is a truncated SHA-256 of the address plus a per-process
 * salt, so neither the in-memory map nor the `rate_limits` table can be read
 * back into a list of visitors, and nothing is ever written to a log.
 */

export type RateLimitDecision = {
  ok: boolean
  /** Requests still allowed in this window. */
  remaining: number
  /** Seconds until the window resets — the `Retry-After` value. */
  retryAfter: number
}

export type RateLimitOptions = {
  /** Requests allowed per window. */
  limit: number
  /** Window length in milliseconds. */
  windowMs: number
}

type Window = { count: number; resetAt: number }

const BUCKETS = Symbol.for('licitaqui.rateLimit.buckets')
const SALT = Symbol.for('licitaqui.rateLimit.salt')
/** Bucket keys this process has written to `rate_limits`, for `resetRateLimits()`. */
const DB_KEYS = Symbol.for('licitaqui.rateLimit.dbKeys')
/** Until when `checkDb()` skips Postgres entirely after a failure. */
const DB_DOWN_UNTIL = Symbol.for('licitaqui.rateLimit.dbDownUntil')

type Holder = {
  [BUCKETS]?: Map<string, Window>
  [SALT]?: string
  [DB_KEYS]?: Set<string>
  [DB_DOWN_UNTIL]?: number
}
const holder = globalThis as unknown as Holder

/**
 * How long `checkDb()` stops trying Postgres after it fails once — whether
 * that is a real outage or (today, before the migration in this task's other
 * PR is applied) the `rate_limits` table not existing yet. Without this, an
 * instance that cannot reach the table pays a full failed round trip on
 * *every single request* it serves: harmless in isolation, but it turned a
 * two-request test into a five-second one during this change's own `pnpm
 * test` run, and production would pay the same tax on every founders signup
 * and every screening request until the migration lands. One failure buys 30
 * seconds of memory-only operation; the next request after that retries, so
 * the moment the table exists again this self-heals without a deploy.
 */
const DB_RETRY_COOLDOWN_MS = 30_000

function buckets(): Map<string, Window> {
  holder[BUCKETS] ??= new Map()
  return holder[BUCKETS]
}

function dbKeysTouched(): Set<string> {
  holder[DB_KEYS] ??= new Set()
  return holder[DB_KEYS]
}

function salt(): string {
  // A per-process random salt is enough: the hash only has to be unreadable,
  // never reproducible across deployments.
  holder[SALT] ??= createHash('sha256')
    .update(`${process.pid}:${Math.random()}:${Date.now()}`)
    .digest('hex')
  return holder[SALT]
}

/** An opaque, non-reversible bucket key for a client address. */
export function hashClient(address: string): string {
  return createHash('sha256').update(`${salt()}:${address}`).digest('hex').slice(0, 24)
}

/**
 * The caller's address, as the proxy in front of us reports it. Vercel sets
 * `x-forwarded-for`; the first hop is the client, the rest are proxies.
 */
export function clientAddress(headers: Headers): string {
  const forwarded = headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return headers.get('x-real-ip')?.trim() || 'unknown'
}

/** Drops windows that have expired, so the map cannot grow without bound. */
function sweepMemory(now: number): void {
  const map = buckets()
  if (map.size < 5_000) return
  for (const [key, window] of map) {
    if (window.resetAt <= now) map.delete(key)
  }
}

/** The start of `now`'s fixed window — the same instant every instance computes. */
function windowStart(now: number, windowMs: number): number {
  return Math.floor(now / windowMs) * windowMs
}

/**
 * The in-memory fallback: exactly the original implementation, kept for when
 * `checkDb()` cannot reach Postgres. A speed bump, not a quota — correct only
 * within one warm instance's own memory.
 */
function checkMemory(key: string, options: RateLimitOptions, now: number): RateLimitDecision {
  const map = buckets()
  sweepMemory(now)

  const window = map.get(key)
  if (!window || window.resetAt <= now) {
    map.set(key, { count: 1, resetAt: now + options.windowMs })
    return { ok: true, remaining: options.limit - 1, retryAfter: 0 }
  }

  window.count += 1
  const retryAfter = Math.max(1, Math.ceil((window.resetAt - now) / 1000))
  if (window.count > options.limit) {
    return { ok: false, remaining: 0, retryAfter }
  }
  return { ok: true, remaining: options.limit - window.count, retryAfter }
}

/**
 * The durable path: one row per `(bucket, window_start)`, incremented
 * atomically by Postgres — `count = rate_limits.count + 1` inside the `on
 * conflict`, not a read in one statement followed by a write in another, so
 * two lambdas racing the same window cannot both read 5 and both write 6.
 *
 * Returns `null` — never throws — when the database cannot be reached, so the
 * caller falls back to `checkMemory()` rather than fail the request the
 * limiter is meant to protect.
 */
async function checkDb(
  key: string,
  options: RateLimitOptions,
  now: number,
): Promise<RateLimitDecision | null> {
  if (holder[DB_DOWN_UNTIL] !== undefined && holder[DB_DOWN_UNTIL] > now) {
    return null
  }

  try {
    const executor = db()
    const start = new Date(windowStart(now, options.windowMs))
    const resetAt = start.getTime() + options.windowMs

    const result = await executor.execute<{ count: number | string }>(sql`
      insert into rate_limits (bucket, window_start, count)
      values (${key}, ${start.toISOString()}::timestamptz, 1)
      on conflict (bucket, window_start)
      do update set count = rate_limits.count + 1, updated_at = now()
      returning count
    `)
    dbKeysTouched().add(key)

    // A cheap, occasional sweep instead of a cron job: this table is small
    // (public routes, one row per bucket per window), so 1-in-200 checks
    // paying for a `delete` keeps it bounded without a scheduled job.
    if (Math.random() < 0.005) {
      void executor
        .execute(sql`delete from rate_limits where window_start < now() - interval '1 hour'`)
        .catch(() => {})
    }

    const count = Number(result.rows[0]?.count ?? 1)
    const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000))
    if (count > options.limit) {
      return { ok: false, remaining: 0, retryAfter }
    }
    return { ok: true, remaining: Math.max(0, options.limit - count), retryAfter }
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'unknown'
    console.error(`rate-limit: database unreachable (${code}), falling back to in-memory`)
    holder[DB_DOWN_UNTIL] = now + DB_RETRY_COOLDOWN_MS
    return null
  }
}

/**
 * Counts one request against `key` and says whether it may proceed. `key`
 * should already be hashed — `rateLimitRequest` does that for you.
 *
 * Tries the durable Postgres path first; falls back to the in-memory map only
 * when the database could not be reached.
 */
export async function check(
  key: string,
  options: RateLimitOptions,
  now = Date.now(),
): Promise<RateLimitDecision> {
  const viaDb = await checkDb(key, options, now)
  if (viaDb) return viaDb
  return checkMemory(key, options, now)
}

/** `check()` keyed by the request's (hashed) client address and a route name. */
export async function rateLimitRequest(
  route: string,
  headers: Headers,
  options: RateLimitOptions,
  now = Date.now(),
): Promise<RateLimitDecision> {
  return check(`${route}:${hashClient(clientAddress(headers))}`, options, now)
}

/**
 * Tests only: forgets every window, in memory and in the database.
 *
 * The database delete is scoped to exactly the bucket keys this process has
 * written through `checkDb()` (tracked in `dbKeysTouched()`), never a
 * broader sweep: `rate_limits` is a table other suites' requests write to in
 * the same window, and a wider delete would clear their counts too, not just
 * this suite's.
 */
export async function resetRateLimits(): Promise<void> {
  buckets().clear()
  const keys = [...dbKeysTouched()]
  dbKeysTouched().clear()
  if (keys.length === 0) return
  try {
    // Not `${keys}::text[]` as a single parameter: Drizzle flattens a JS
    // array into one bound parameter per element rather than one Postgres
    // array literal, so with more than one key Postgres answers `22P02,
    // Array value must start with "{"...` — the same gotcha `textArray()` in
    // `lib/telegram/link.ts` documents. `array[...]`, built element by
    // element through `sql.join`, is the form that actually binds.
    await db().execute(sql`
      delete from rate_limits
       where bucket = any(array[${sql.join(
         keys.map((key) => sql`${key}`),
         sql`, `,
       )}]::text[])
    `)
  } catch {
    // No database configured for this run (plain `pnpm test`): nothing to
    // clear beyond the in-memory map above.
  }
}
