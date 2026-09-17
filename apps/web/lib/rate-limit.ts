import { createHash } from 'node:crypto'

/**
 * A fixed-window rate limiter for public routes (spec §8: "rate limit per IP").
 *
 * ## Why in memory, and what that buys
 *
 * Spec §3.3 puts rate limiting in Postgres, but the table it would need does
 * not exist yet and the schema is another PR's to change (CLAUDE.md). So this
 * counts in the instance's memory: it stops the case that actually matters on
 * an offer page — one script hammering one endpoint, which a single serverless
 * instance keeps serving while it stays warm — and it degrades honestly when
 * Vercel runs several instances, since each holds its own window. It is a speed
 * bump, not a quota: the correctness of the 48 seats never depends on it (that
 * is the transaction in `founders/signup.ts`), and a repeat signup is a no-op
 * by e-mail anyway.
 *
 * Replacing the map with a `rate_limits` table or Vercel's firewall later means
 * changing this file only — callers see `check()`.
 *
 * ## The IP never gets stored
 *
 * §12 forbids logging personal data, and an IP address is personal data under
 * the LGPD. The key is a truncated SHA-256 of the address plus a per-process
 * salt, so the map cannot be read back into a list of visitors, and nothing is
 * ever written to a log or to the database.
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

type Holder = { [BUCKETS]?: Map<string, Window>; [SALT]?: string }
const holder = globalThis as unknown as Holder

function buckets(): Map<string, Window> {
  holder[BUCKETS] ??= new Map()
  return holder[BUCKETS]
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
function sweep(now: number): void {
  const map = buckets()
  if (map.size < 5_000) return
  for (const [key, window] of map) {
    if (window.resetAt <= now) map.delete(key)
  }
}

/**
 * Counts one request against `key` and says whether it may proceed. `key`
 * should already be hashed — `rateLimitRequest` does that for you.
 */
export function check(key: string, options: RateLimitOptions, now = Date.now()): RateLimitDecision {
  const map = buckets()
  sweep(now)

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

/** `check()` keyed by the request's (hashed) client address and a route name. */
export function rateLimitRequest(
  route: string,
  headers: Headers,
  options: RateLimitOptions,
  now = Date.now(),
): RateLimitDecision {
  return check(`${route}:${hashClient(clientAddress(headers))}`, options, now)
}

/** Tests only: forgets every window. */
export function resetRateLimits(): void {
  buckets().clear()
}
