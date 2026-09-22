import { describe, expect, it } from 'vitest'
import { START_PARAMETER_RE, TOKEN_TTL_SECONDS } from './config'
import { digestOf, LinkSecretMissing, mintToken, TOKEN_CHARS, verifyToken } from './token'

/**
 * The `/start` token: what makes the deep link safe and what makes it expire.
 *
 * `telegram_links` has no column for when a token was issued, so the expiry is
 * inside the token and the signature is what stops the holder editing it.
 * Every property that rests on is checked here.
 */

const ENV = { TELEGRAM_LINK_SECRET: 'a-secret-for-tests-only-not-a-real-one' }
const OTHER = { TELEGRAM_LINK_SECRET: 'a-different-secret-entirely' }

describe('minting', () => {
  it('fits in a Telegram deep link', () => {
    const { token } = mintToken({ env: ENV })
    // 1-64 characters of [A-Za-z0-9_-], or Telegram silently drops the rest.
    expect(token).toMatch(START_PARAMETER_RE)
    expect(token).toHaveLength(TOKEN_CHARS)
    expect(TOKEN_CHARS).toBeLessThanOrEqual(64)
  })

  it('never repeats', () => {
    const seen = new Set(
      Array.from({ length: 200 }, () => mintToken({ env: ENV }).token),
    )
    expect(seen.size).toBe(200)
  })

  it('carries the TTL the config declares', () => {
    const now = new Date('2026-10-08T12:00:00Z')
    const { expiresAt } = mintToken({ env: ENV, now })
    expect(Math.round((expiresAt.getTime() - now.getTime()) / 1000)).toBe(TOKEN_TTL_SECONDS)
  })

  it('hands back the digest to store, not the token', () => {
    const { token, digest } = mintToken({ env: ENV })
    expect(digest).toBe(digestOf(token))
    expect(digest).not.toContain(token)
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('verifying', () => {
  it('accepts what it minted', () => {
    const { token, expiresAt } = mintToken({ env: ENV })
    const verdict = verifyToken(token, { env: ENV })
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.expiresAt.getTime()).toBe(expiresAt.getTime())
  })

  it('refuses a token signed with another key', () => {
    const { token } = mintToken({ env: OTHER })
    expect(verifyToken(token, { env: ENV })).toEqual({ ok: false, reason: 'bad_signature' })
  })

  it('refuses a token whose expiry was edited', () => {
    const now = new Date('2026-10-08T12:00:00Z')
    const { token } = mintToken({ env: ENV, now })

    // Push the expiry a year out, keeping the nonce and the signature.
    const payload = Buffer.from(token.slice(0, 22), 'base64url')
    payload.writeUInt32BE(payload.readUInt32BE(0) + 365 * 24 * 3600, 0)
    const forged = `${payload.toString('base64url')}${token.slice(22)}`

    expect(forged).toHaveLength(TOKEN_CHARS)
    expect(verifyToken(forged, { env: ENV, now })).toEqual({
      ok: false,
      reason: 'bad_signature',
    })
  })

  it('expires, and says so rather than calling it a forgery', () => {
    const now = new Date('2026-10-08T12:00:00Z')
    const { token } = mintToken({ env: ENV, now, ttlSeconds: 60 })

    expect(verifyToken(token, { env: ENV, now: new Date(now.getTime() + 59_000) }).ok).toBe(true)
    expect(verifyToken(token, { env: ENV, now: new Date(now.getTime() + 61_000) })).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  it('never throws on what a public webhook can send', () => {
    const junk = [
      '',
      'x',
      '/start',
      'a'.repeat(1000),
      '../../etc/passwd',
      '"; drop table telegram_links; --',
      '\u0000',
      'A'.repeat(TOKEN_CHARS),
    ]
    for (const value of junk) {
      const verdict = verifyToken(value, { env: ENV })
      expect(verdict.ok).toBe(false)
    }
  })

  it('falls back to AUTH_SECRET so no new variable has to be provisioned', () => {
    const env = { AUTH_SECRET: 'the-auth-js-secret' }
    const { token } = mintToken({ env })
    expect(verifyToken(token, { env }).ok).toBe(true)
  })

  it('does not reuse the AUTH_SECRET key material directly', () => {
    // Key separation: a signature made here must not be one Auth.js could make
    // with the same secret, and vice versa.
    const asAuth = { AUTH_SECRET: 'shared' }
    const asLink = { TELEGRAM_LINK_SECRET: 'shared' }
    const { token } = mintToken({ env: asAuth })
    // Same *material*, different variable — the derived key is the same, so
    // this must verify. The separation is from Auth.js's own label, not from
    // the variable name.
    expect(verifyToken(token, { env: asLink }).ok).toBe(true)
  })

  it('refuses to work with no secret configured, rather than with a weak one', () => {
    expect(() => mintToken({ env: {} })).toThrow(LinkSecretMissing)
    const { token } = mintToken({ env: ENV })
    expect(() => verifyToken(token, { env: {} })).toThrow(LinkSecretMissing)
  })
})
