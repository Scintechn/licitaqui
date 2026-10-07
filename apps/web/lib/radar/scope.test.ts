import { describe, expect, it } from 'vitest'
import { SESSION_COOKIE, SESSION_COOKIE_SECURE } from '@/lib/auth/config'
import {
  CNPJ_SCOPE_COOKIE,
  cnpjScopeCookie,
  cnpjTag,
  cnpjTagFromCookies,
  listScope,
  SCOPE_INPUT_COOKIES,
  type ScopeEnv,
} from './scope'
import { VISITOR_COOKIE } from './visitor'

/**
 * D58 and D60 — the **mechanism**: the discriminator's construction.
 *
 * `environment: 'node'` cannot see what this is for (CLAUDE.md §4c): the defect
 * is a snapshot restored across a sign-out or a change of company, which needs a
 * browser, two page loads and `sessionStorage`. That is
 * `e2e/journeys/radar-snapshot-identity.spec.ts`. What is held here is every
 * property the digest has to have for that journey to be possible at all —
 * including the two that are **not** about caching:
 *
 *  * nothing a reader could decode into a CNPJ, an e-mail or a user id (§12);
 *  * no session token recoverable from a value that reaches page JavaScript.
 *
 * The companion file is `list-cache-scope.test.ts`, which asserts what the
 * digest does once it is inside `listKey`.
 */

const SECRET: ScopeEnv = { AUTH_SECRET: 'x'.repeat(32) }
const OTHER: ScopeEnv = { AUTH_SECRET: 'y'.repeat(32) }

const CNPJ = '11222333000181'
const OTHER_CNPJ = '33444555000163'
const VISITOR = '6f7e8d9c-0a1b-4c2d-8e3f-4a5b6c7d8e9f'
const OTHER_VISITOR = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
const TOKEN = 'b6a1f0c2-3d4e-4f5a-9b8c-7d6e5f4a3b2c'
const OTHER_TOKEN = 'c7b2a1d3-4e5f-4a6b-8c9d-0e1f2a3b4c5e'

/** A cookie header, written the way a browser sends one. */
function jar(entries: Record<string, string>): string {
  return Object.entries(entries)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

describe('listScope', () => {
  it('is the same for the same caller and different for every input that changes the answer', () => {
    const base = jar({
      [SESSION_COOKIE]: TOKEN,
      [VISITOR_COOKIE]: VISITOR,
      [CNPJ_SCOPE_COOKIE]: cnpjTag(CNPJ, SECRET),
    })
    const scope = listScope(base, SECRET)

    // Stable: a second render of the same request must restore, not re-read.
    expect(listScope(base, SECRET)).toBe(scope)

    /*
     * D58 — the viewer. Both directions, because both were wrong: after a
     * sign-out the stars drawn were the previous identity's, and after a sign-in
     * they came back empty for an account that has marks on another device.
     */
    expect(listScope(jar({ [VISITOR_COOKIE]: VISITOR }), SECRET)).not.toBe(scope)
    expect(
      listScope(jar({ [SESSION_COOKIE]: OTHER_TOKEN, [VISITOR_COOKIE]: VISITOR }), SECRET),
    ).not.toBe(scope)

    /*
     * D60 — the company the route grouped by. `visitors.cnpj` is `httpOnly` and
     * D19 kept it out of `GroupedBy`, so the only thing the key can carry is the
     * generation `POST /api/radar/cnpj` stamped.
     */
    expect(
      listScope(
        jar({
          [SESSION_COOKIE]: TOKEN,
          [VISITOR_COOKIE]: VISITOR,
          [CNPJ_SCOPE_COOKIE]: cnpjTag(OTHER_CNPJ, SECRET),
        }),
        SECRET,
      ),
    ).not.toBe(scope)

    // A different device is a different `visitors` row, so a different CNPJ and
    // a different quota.
    expect(
      listScope(
        jar({
          [SESSION_COOKIE]: TOKEN,
          [VISITOR_COOKIE]: OTHER_VISITOR,
          [CNPJ_SCOPE_COOKIE]: cnpjTag(CNPJ, SECRET),
        }),
        SECRET,
      ),
    ).not.toBe(scope)
  })

  it('names every cookie it reads, and each one of them moves it', () => {
    /*
     * `SCOPE_INPUT_COOKIES` is the file's own statement of what it depends on,
     * and a statement nothing checks is how `radar.list.changeCompany` happened.
     * So each name in it is set, alone, over an empty jar, and must produce a
     * different digest from the empty one: a cookie listed there but not read
     * fails here.
     */
    const empty = listScope('', SECRET)
    /*
     * A value each cookie's own reader accepts. `lq_visitor` is validated
     * against the UUID shape, and the first draft of this test used a
     * placeholder for all four and reported that the visitor cookie did not
     * move the digest — which was the test being wrong and the code being
     * right: a junk visitor cookie names no row, so the route resolves nothing
     * for it and the scope must indeed equal the empty jar's.
     */
    const sample: Record<string, string> = {
      [SESSION_COOKIE]: TOKEN,
      [SESSION_COOKIE_SECURE]: TOKEN,
      [VISITOR_COOKIE]: VISITOR,
      [CNPJ_SCOPE_COOKIE]: cnpjTag(CNPJ, SECRET),
    }
    for (const name of SCOPE_INPUT_COOKIES) {
      expect(listScope(jar({ [name]: sample[name] }), SECRET), name).not.toBe(empty)
    }
    // And the one input that is checked before it is used: a `lq_visitor` that
    // is not a UUID names no `visitors` row, so it must read as no device at
    // all rather than as a device of its own.
    expect(listScope(jar({ [VISITOR_COOKIE]: 'not-a-uuid' }), SECRET)).toBe(empty)
    // And the secure spelling of the session cookie wins over the plain one, so
    // production and localhost cannot disagree about who is asking.
    expect(
      listScope(jar({ [SESSION_COOKIE]: TOKEN, [SESSION_COOKIE_SECURE]: OTHER_TOKEN }), SECRET),
    ).toBe(listScope(jar({ [SESSION_COOKIE_SECURE]: OTHER_TOKEN }), SECRET))
  })

  it('cannot be read back into a CNPJ, a session token or a visitor id (§12)', () => {
    const header = jar({
      [SESSION_COOKIE]: TOKEN,
      [VISITOR_COOKIE]: VISITOR,
      [CNPJ_SCOPE_COOKIE]: cnpjTag(CNPJ, SECRET),
    })
    const scope = listScope(header, SECRET)

    // This value is what goes into `sessionStorage`. Nothing identifying may be
    // inside it — not the CNPJ, not the token, not the device id, and no
    // separator that would let any of them be sliced back out.
    expect(scope).not.toContain(CNPJ)
    expect(scope).not.toContain(TOKEN)
    expect(scope).not.toContain(VISITOR)
    expect(scope).toMatch(/^[A-Za-z0-9_-]{22}$/)

    // Keyed, not merely hashed: the same jar under another deployment's secret
    // is another digest, so a value cannot be recomputed by anybody who holds a
    // guess at the inputs but not the key.
    expect(listScope(header, OTHER)).not.toBe(scope)
  })

  it('still works with no AUTH_SECRET, because its inputs are not a dictionary', () => {
    /*
     * A local tree with an empty `.env` must not silently lose the Radar's
     * cache. It is safe to fall back here precisely because every input is an
     * opaque high-entropy token — unlike `visitor.ts`'s `hash()` of an IP
     * address, whose own comment says a salt would be better.
     */
    const header = jar({ [VISITOR_COOKIE]: VISITOR })
    expect(listScope(header, {})).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(listScope(header, {})).toBe(listScope(header, {}))
    expect(listScope(header, {})).not.toBe(listScope(jar({ [VISITOR_COOKIE]: OTHER_VISITOR }), {}))
  })
})

describe('the cookie that carries the CNPJ generation', () => {
  it('is a keyed digest of the CNPJ and not the CNPJ', () => {
    const tag = cnpjTag(CNPJ, SECRET)
    expect(tag).not.toContain(CNPJ)
    expect(tag).toMatch(/^[A-Za-z0-9_-]{22}$/)
    // Deterministic, which is why the route can stamp it without reading the
    // row first and why a cleared jar heals to the same value.
    expect(cnpjTag(CNPJ, SECRET)).toBe(tag)
    expect(cnpjTag(OTHER_CNPJ, SECRET)).not.toBe(tag)
    // A different key label from `listScope`'s, so the two digests of the same
    // bytes can never be each other.
    expect(listScope(jar({ [CNPJ_SCOPE_COOKIE]: tag }), SECRET)).not.toBe(tag)
  })

  it('is set `HttpOnly`, because nothing in the browser reads it', () => {
    const cookie = cnpjScopeCookie(CNPJ, { secure: true, env: SECRET })
    expect(cookie).toContain(`${CNPJ_SCOPE_COOKIE}=${cnpjTag(CNPJ, SECRET)}`)
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('Path=/')
    // The CNPJ itself never appears in a header we send.
    expect(cookie).not.toContain(CNPJ)
    // `Secure` is conditional, the way `visitorCookie`'s is: localhost is http.
    expect(cnpjScopeCookie(CNPJ, { secure: false, env: SECRET })).not.toContain('Secure')
  })

  it('reads its own value back and is unmoved by a neighbour that will not decode', () => {
    const tag = cnpjTag(CNPJ, SECRET)
    expect(cnpjTagFromCookies(jar({ [CNPJ_SCOPE_COOKIE]: tag }))).toBe(tag)
    expect(cnpjTagFromCookies(jar({ other: 'x' }))).toBeNull()
    expect(cnpjTagFromCookies(null)).toBeNull()
    /*
     * One malformed cookie anywhere in the jar must not throw. `session.ts`
     * decoded every value it walked past before checking the name, and a lone
     * `%` in an unrelated cookie signed a paying subscriber out — a 500 on a
     * request that was perfectly valid.
     */
    expect(cnpjTagFromCookies(jar({ junk: '%', [CNPJ_SCOPE_COOKIE]: tag }))).toBe(tag)
    expect(listScope(jar({ junk: '%', [VISITOR_COOKIE]: VISITOR }), SECRET)).toBe(
      listScope(jar({ [VISITOR_COOKIE]: VISITOR }), SECRET),
    )
  })
})
