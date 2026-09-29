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

/**
 * Deliberately a sentence rather than a UUID: a real-looking opaque token trips
 * the repo's `gitleaks` scan, and because `security.yml` scans every reachable
 * commit, a high-entropy fixture on one branch reddens unrelated PRs. What this
 * file tests is cookie *parsing* — the value only has to be recognisable.
 */
const TOKEN = 'session-token-for-the-test'

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

describe('sessionTokenFromCookies survives a neighbour it cannot decode', () => {
  /**
   * `decodeURIComponent` throws `URIError` on a lone `%`, and the parser
   * decodes every value it walks past *before* it checks the name. So one
   * malformed cookie — from any source, anywhere in the jar — used to throw
   * before the session token was reached. `readViewer` propagated it, and in
   * an API route it surfaced as a 500 on a valid request.
   *
   * Found while fixing a price-screen read that rebuilt the header out of
   * `cookies().getAll()`: those values come back already decoded, so a real
   * `%25` became a bare `%` and was decoded a second time. That call site now
   * uses the raw header, and this makes the parser safe for every other one.
   */
  it('still finds the session token after a lone percent sign', () => {
    expect(sessionTokenFromCookies('junk=100%; __Secure-authjs.session-token=REAL')).toBe('REAL')
  })

  it('still finds it after a truncated escape', () => {
    expect(sessionTokenFromCookies('bad=%E0%A4%A; __Secure-authjs.session-token=REAL')).toBe('REAL')
  })

  it('keeps decoding the values it can', () => {
    // A genuinely encoded token must still come back decoded, or a session
    // whose token contained an escaped character would stop matching.
    expect(sessionTokenFromCookies('__Secure-authjs.session-token=a%2Bb')).toBe('a+b')
  })

  it('returns an undecodable value unchanged rather than dropping it', () => {
    expect(sessionTokenFromCookies('__Secure-authjs.session-token=100%')).toBe('100%')
  })
})
