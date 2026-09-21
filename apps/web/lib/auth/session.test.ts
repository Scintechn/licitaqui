import { describe, expect, it } from 'vitest'
import { SESSION_COOKIE, SESSION_COOKIE_SECURE } from './config'
import { sessionTokenFromCookies } from './session'

/**
 * Reading the session cookie out of a raw `Cookie` header.
 *
 * This is the half of "who is asking" that runs in an API route, where
 * `next/headers` is not available (see the note in `session.ts`). It sits in
 * front of a database lookup, so getting it wrong does not let anyone in — but
 * getting it wrong *quietly* would log every signed-in user out of the API
 * while leaving them signed in on the pages, which is the sort of bug that
 * takes a day to see.
 */

const TOKEN = 'a5a9f0c6-0c8f-4f2e-9a2f-0f1a2b3c4d5e'

describe('sessionTokenFromCookies', () => {
  it('finds the cookie among the others the site sets', () => {
    const header = `lq_visitor=9f1c; ${SESSION_COOKIE}=${TOKEN}; _vercel_jwt=x`
    expect(sessionTokenFromCookies(header)).toBe(TOKEN)
  })

  it('reads the secure name too — Auth.js uses it over https', () => {
    expect(sessionTokenFromCookies(`${SESSION_COOKIE_SECURE}=${TOKEN}`)).toBe(TOKEN)
  })

  it('prefers the secure cookie when a jar holds both', () => {
    // A browser will not send `__Secure-` over plain http, so when both arrive
    // the secure one is the live session and the other is a leftover.
    const header = `${SESSION_COOKIE}=old; ${SESSION_COOKIE_SECURE}=${TOKEN}`
    expect(sessionTokenFromCookies(header)).toBe(TOKEN)
  })

  it('is null when there is no header, no cookie, or an empty value', () => {
    expect(sessionTokenFromCookies(null)).toBeNull()
    expect(sessionTokenFromCookies('')).toBeNull()
    expect(sessionTokenFromCookies('lq_visitor=9f1c')).toBeNull()
    expect(sessionTokenFromCookies(`${SESSION_COOKIE}=`)).toBeNull()
  })

  it('does not match a cookie whose name merely contains the session one', () => {
    expect(sessionTokenFromCookies(`x-${SESSION_COOKIE}=${TOKEN}`)).toBeNull()
    expect(sessionTokenFromCookies(`${SESSION_COOKIE}-old=${TOKEN}`)).toBeNull()
  })

  it('decodes a percent-encoded value and tolerates stray whitespace', () => {
    expect(sessionTokenFromCookies(`  ${SESSION_COOKIE}=a%2Fb  `)).toBe('a/b')
  })

  it('keeps a value that contains "=" whole — base64 pads with it', () => {
    expect(sessionTokenFromCookies(`${SESSION_COOKIE}=YWJj==`)).toBe('YWJj==')
  })
})
