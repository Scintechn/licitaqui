import { beforeEach, describe, expect, it } from 'vitest'
import {
  check,
  clientAddress,
  hashClient,
  rateLimitRequest,
  resetRateLimits,
} from './rate-limit'

const options = { limit: 3, windowMs: 60_000 }

beforeEach(async () => {
  await resetRateLimits()
})

/**
 * No `DATABASE_URL` is set for this file (`rate-limit.db.test.ts` covers the
 * Postgres-backed path against a real database), so every `check()` here
 * exercises the in-memory fallback: `checkDb()` throws on `db()` — no
 * connection string — and `check()` falls through to `checkMemory()`. That is
 * itself worth asserting once, rather than trusting it silently.
 */
describe('check (in-memory fallback)', () => {
  it('allows up to the limit and then refuses', async () => {
    const now = 1_000_000
    expect(await check('k', options, now)).toMatchObject({ ok: true, remaining: 2 })
    expect(await check('k', options, now)).toMatchObject({ ok: true, remaining: 1 })
    expect(await check('k', options, now)).toMatchObject({ ok: true, remaining: 0 })

    const refused = await check('k', options, now)
    expect(refused.ok).toBe(false)
    expect(refused.retryAfter).toBe(60)
  })

  it('opens a fresh window once the old one expires', async () => {
    const now = 1_000_000
    for (let i = 0; i < 4; i += 1) await check('k', options, now)
    expect(await check('k', options, now + 60_001)).toMatchObject({ ok: true, remaining: 2 })
  })

  it('counts each key on its own', async () => {
    const now = 1_000_000
    for (let i = 0; i < 4; i += 1) await check('a', options, now)
    expect((await check('b', options, now)).ok).toBe(true)
  })
})

describe('clientAddress', () => {
  it('takes the first hop of x-forwarded-for', () => {
    const headers = new Headers({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18' })
    expect(clientAddress(headers)).toBe('203.0.113.7')
  })

  it('falls back to x-real-ip, then to a constant', () => {
    expect(clientAddress(new Headers({ 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9')
    expect(clientAddress(new Headers())).toBe('unknown')
  })
})

describe('hashClient', () => {
  it('never returns the address it was given', () => {
    const hash = hashClient('203.0.113.7')
    expect(hash).not.toContain('203')
    expect(hash).toMatch(/^[0-9a-f]{24}$/)
    expect(hashClient('203.0.113.7')).toBe(hash)
    expect(hashClient('203.0.113.8')).not.toBe(hash)
  })
})

describe('rateLimitRequest', () => {
  it('buckets per route and per address', async () => {
    const one = new Headers({ 'x-forwarded-for': '203.0.113.7' })
    const two = new Headers({ 'x-forwarded-for': '203.0.113.8' })

    for (let i = 0; i < 3; i += 1) await rateLimitRequest('founders', one, options)
    expect((await rateLimitRequest('founders', one, options)).ok).toBe(false)
    expect((await rateLimitRequest('founders', two, options)).ok).toBe(true)
    expect((await rateLimitRequest('founders-seats', one, options)).ok).toBe(true)
  })
})
