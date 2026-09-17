import { beforeEach, describe, expect, it } from 'vitest'
import {
  check,
  clientAddress,
  hashClient,
  rateLimitRequest,
  resetRateLimits,
} from './rate-limit'

const options = { limit: 3, windowMs: 60_000 }

beforeEach(() => {
  resetRateLimits()
})

describe('check', () => {
  it('allows up to the limit and then refuses', () => {
    const now = 1_000_000
    expect(check('k', options, now)).toMatchObject({ ok: true, remaining: 2 })
    expect(check('k', options, now)).toMatchObject({ ok: true, remaining: 1 })
    expect(check('k', options, now)).toMatchObject({ ok: true, remaining: 0 })

    const refused = check('k', options, now)
    expect(refused.ok).toBe(false)
    expect(refused.retryAfter).toBe(60)
  })

  it('opens a fresh window once the old one expires', () => {
    const now = 1_000_000
    for (let i = 0; i < 4; i += 1) check('k', options, now)
    expect(check('k', options, now + 60_001)).toMatchObject({ ok: true, remaining: 2 })
  })

  it('counts each key on its own', () => {
    const now = 1_000_000
    for (let i = 0; i < 4; i += 1) check('a', options, now)
    expect(check('b', options, now).ok).toBe(true)
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
  it('buckets per route and per address', () => {
    const one = new Headers({ 'x-forwarded-for': '203.0.113.7' })
    const two = new Headers({ 'x-forwarded-for': '203.0.113.8' })

    for (let i = 0; i < 3; i += 1) rateLimitRequest('founders', one, options)
    expect(rateLimitRequest('founders', one, options).ok).toBe(false)
    expect(rateLimitRequest('founders', two, options).ok).toBe(true)
    expect(rateLimitRequest('founders-seats', one, options).ok).toBe(true)
  })
})
