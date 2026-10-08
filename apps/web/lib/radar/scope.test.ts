import { describe, expect, it } from 'vitest'
import { SESSION_COOKIE, SESSION_COOKIE_SECURE } from '@/lib/auth/config'
import {
  CNPJ_SCOPE_COOKIE,
  cnpjScopeCookie,
  cnpjTag,
  cnpjTagFromCookies,
  listScopes,
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
/**
 * **Sentences, not UUIDs, and that is the point of them.**
 *
 * Nothing here parses a session token — `sessionTokenFromCookies` returns
 * whatever is in the cookie and the digest hashes it — so the only thing these
 * values have to be is *two strings that differ*. Written as UUIDs they scored
 * high enough entropy for gitleaks to report them as `generic-api-key`, which is
 * exactly what happened to U1's session-cookie fixture: see `.gitleaks.toml`,
 * whose own note says the sentence `session-token-for-the-test` *"is what the
 * test should have said in the first place"*. The repo's answer to this shape is
 * to rename the value, never to allowlist it.
 *
 * `VISITOR` above cannot follow them: `visitorIdFromCookies` checks the UUID
 * shape and a sentence would read as no device at all — which is itself asserted
 * two tests down.
 */
const SESSION = 'the-session-token-for-this-test'
const OTHER_SESSION = 'a-second-session-token-that-must-differ'

/**
 * The scope for an address the **cookie** decides — a bare `/radar`, or
 * `/radar?q=…`. Most of this file is about that one, because it is the one with
 * three inputs; `the two scopes` below holds the other.
 */
function deviceScope(cookieHeader: string | null, env: ScopeEnv = SECRET): string {
  return listScopes(cookieHeader, env).device
}

/** The scope for an address that names its own CNPJ: the session, and no more. */
function viewerScope(cookieHeader: string | null, env: ScopeEnv = SECRET): string {
  return listScopes(cookieHeader, env).viewer
}

/** A cookie header, written the way a browser sends one. */
function jar(entries: Record<string, string>): string {
  return Object.entries(entries)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
}

describe('the device scope', () => {
  it('is the same for the same caller and different for every input that changes the answer', () => {
    const base = jar({
      [SESSION_COOKIE]: SESSION,
      [VISITOR_COOKIE]: VISITOR,
      [CNPJ_SCOPE_COOKIE]: cnpjTag(CNPJ, SECRET),
    })
    const scope = deviceScope(base, SECRET)

    // Stable: a second render of the same request must restore, not re-read.
    expect(deviceScope(base, SECRET)).toBe(scope)

    /*
     * D58 — the viewer. Both directions, because both were wrong: after a
     * sign-out the stars drawn were the previous identity's, and after a sign-in
     * they came back empty for an account that has marks on another device.
     */
    expect(deviceScope(jar({ [VISITOR_COOKIE]: VISITOR }), SECRET)).not.toBe(scope)
    expect(
      deviceScope(jar({ [SESSION_COOKIE]: OTHER_SESSION, [VISITOR_COOKIE]: VISITOR }), SECRET),
    ).not.toBe(scope)

    /*
     * D60 — the company the route grouped by. `visitors.cnpj` is `httpOnly` and
     * D19 kept it out of `GroupedBy`, so the only thing the key can carry is the
     * generation `POST /api/radar/cnpj` stamped.
     */
    expect(
      deviceScope(
        jar({
          [SESSION_COOKIE]: SESSION,
          [VISITOR_COOKIE]: VISITOR,
          [CNPJ_SCOPE_COOKIE]: cnpjTag(OTHER_CNPJ, SECRET),
        }),
        SECRET,
      ),
    ).not.toBe(scope)

    // A different device is a different `visitors` row, so a different CNPJ and
    // a different quota.
    expect(
      deviceScope(
        jar({
          [SESSION_COOKIE]: SESSION,
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
    const empty = deviceScope('', SECRET)
    /*
     * A value each cookie's own reader accepts. `lq_visitor` is validated
     * against the UUID shape, and the first draft of this test used a
     * placeholder for all four and reported that the visitor cookie did not
     * move the digest — which was the test being wrong and the code being
     * right: a junk visitor cookie names no row, so the route resolves nothing
     * for it and the scope must indeed equal the empty jar's.
     */
    const sample: Record<string, string> = {
      [SESSION_COOKIE]: SESSION,
      [SESSION_COOKIE_SECURE]: SESSION,
      [VISITOR_COOKIE]: VISITOR,
      [CNPJ_SCOPE_COOKIE]: cnpjTag(CNPJ, SECRET),
    }
    for (const name of SCOPE_INPUT_COOKIES) {
      expect(deviceScope(jar({ [name]: sample[name] }), SECRET), name).not.toBe(empty)
    }
    // And the one input that is checked before it is used: a `lq_visitor` that
    // is not a UUID names no `visitors` row, so it must read as no device at
    // all rather than as a device of its own.
    expect(deviceScope(jar({ [VISITOR_COOKIE]: 'not-a-uuid' }), SECRET)).toBe(empty)
    // And the secure spelling of the session cookie wins over the plain one, so
    // production and localhost cannot disagree about who is asking.
    expect(
      deviceScope(jar({ [SESSION_COOKIE]: SESSION, [SESSION_COOKIE_SECURE]: OTHER_SESSION }), SECRET),
    ).toBe(deviceScope(jar({ [SESSION_COOKIE_SECURE]: OTHER_SESSION }), SECRET))
  })

  it('cannot be read back into a CNPJ, a session token or a visitor id (§12)', () => {
    const header = jar({
      [SESSION_COOKIE]: SESSION,
      [VISITOR_COOKIE]: VISITOR,
      [CNPJ_SCOPE_COOKIE]: cnpjTag(CNPJ, SECRET),
    })
    const scope = deviceScope(header, SECRET)

    /*
     * This value is what goes into `sessionStorage`, and **the shape is the
     * load-bearing assertion**: 22 characters of base64url, with no separator
     * that could let a composed value be sliced apart. The review of this diff
     * pointed out that `not.toContain(SESSION)` was unfalsifiable — `SESSION` is a
     * 36-character UUID and `scope` is 22 characters, so a 22-char string cannot
     * contain it whatever the implementation does. The regex is what would
     * actually catch a `${visitorId}-${hash}` regression, so it is the one kept,
     * and the CNPJ is checked against the **longest** composition available
     * rather than against the truncated digest.
     */
    expect(scope).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(scope).not.toContain(CNPJ)
    expect(cnpjTag(CNPJ, SECRET) + scope).not.toContain(CNPJ)

    // Keyed, not merely hashed: the same jar under another deployment's secret
    // is another digest, so a value cannot be recomputed by anybody who holds a
    // guess at the inputs but not the key.
    expect(deviceScope(header, OTHER)).not.toBe(scope)
  })

  it('still works with no AUTH_SECRET, because its inputs are not a dictionary', () => {
    /*
     * A local tree with an empty `.env` must not silently lose the Radar's
     * cache. It is safe to fall back here precisely because every input is an
     * opaque high-entropy token — unlike `visitor.ts`'s `hash()` of an IP
     * address, whose own comment says a salt would be better.
     */
    const header = jar({ [VISITOR_COOKIE]: VISITOR })
    expect(deviceScope(header, {})).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(deviceScope(header, {})).toBe(deviceScope(header, {}))
    expect(deviceScope(header, {})).not.toBe(deviceScope(jar({ [VISITOR_COOKIE]: OTHER_VISITOR }), {}))
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
    expect(deviceScope(jar({ [CNPJ_SCOPE_COOKIE]: tag }), SECRET)).not.toBe(tag)
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
    /*
     * **And the default, which is the branch production takes and no test
     * covered** — found by the review of this diff. It is read from the `env`
     * this function was handed rather than from `process.env` behind its back,
     * which is the whole point of the parameter being injectable.
     */
    expect(cnpjScopeCookie(CNPJ, { env: { ...SECRET, NODE_ENV: 'production' } })).toContain(
      'Secure',
    )
    expect(cnpjScopeCookie(CNPJ, { env: { ...SECRET, NODE_ENV: 'development' } })).not.toContain(
      'Secure',
    )
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
    expect(deviceScope(jar({ junk: '%', [VISITOR_COOKIE]: VISITOR }), SECRET)).toBe(
      deviceScope(jar({ [VISITOR_COOKIE]: VISITOR }), SECRET),
    )
    /*
     * **And the dangerous case, which the line above does not cover.** A
     * malformed *unrelated* cookie is skipped by name before anything decodes
     * it; a malformed `lq_visitor` is decoded, and `visitorIdFromCookies` did it
     * unguarded. Before D58 that was a 500 on one route; D58 put this function
     * on the path of `app/radar/page.tsx`, where it would have failed the render
     * of the whole screen, with no `error.tsx` under `app/radar/` to catch it.
     * Found by the review of this diff, not by this suite's first version.
     */
    expect(() => deviceScope(jar({ [VISITOR_COOKIE]: '%' }), SECRET)).not.toThrow()
    expect(deviceScope(jar({ [VISITOR_COOKIE]: '%' }), SECRET)).toBe(deviceScope('', SECRET))
    /*
     * **A forward guard, not coverage** — said plainly so a later reader does
     * not mistake it for either. `cnpjTagFromCookies` has no `decodeURIComponent`
     * at all, so this line passes under every mutation of the code it is about.
     * It is here to fail the day somebody adds one, which is exactly what
     * happened to `visitorIdFromCookies` two functions away.
     */
    expect(() => deviceScope(jar({ [CNPJ_SCOPE_COOKIE]: '%E0%A4%A' }), SECRET)).not.toThrow()
  })
})

describe('the two scopes, and why there are two', () => {
  /*
   * **The regression a single digest caused, as a unit test.**
   *
   * `app/radar/page.tsx` computes the scope once per render. Our own
   * `POST /api/radar/cnpj` then stamps `lq_scope` — and on a device that has
   * never searched, mints `lq_visitor` — from a request the screen makes *after*
   * that render. With one digest covering all three cookies, every snapshot
   * written during that document was filed under a scope that no longer existed,
   * and the next document load missed it: `?cnpj=B`, three *Ver mais editais*,
   * open an edital, **Voltar** — 60 cards and 3 000 px became 20 and zero, which
   * is the production failure `list-cache.ts` was written to prevent.
   *
   * The two tests below are that transition, from both ends.
   */
  const before = jar({})
  const after = jar({
    [VISITOR_COOKIE]: VISITOR,
    [CNPJ_SCOPE_COOKIE]: cnpjTag(CNPJ, SECRET),
  })

  it('keeps the viewer scope still across the jar our own POST changes', () => {
    // A device searching its first CNPJ: the page renders with an empty jar and
    // the response fills it. The viewer scope — the one an address with
    // `?cnpj=` keys by — must not notice.
    expect(viewerScope(after)).toBe(viewerScope(before))

    // Signing in is the one thing that must move it, and it cannot happen
    // mid-document: it is a navigation either way.
    expect(viewerScope(jar({ [SESSION_COOKIE]: SESSION }))).not.toBe(viewerScope(before))
  })

  it('moves the device scope across exactly that jar, because that list is the cookie’s', () => {
    // The other half: for a bare `/radar` the cookie is the only thing that
    // names the list, and nothing posts a CNPJ on that address, so it is stable
    // for the document and safe to key by.
    expect(deviceScope(after)).not.toBe(deviceScope(before))
  })

  it('are never each other', () => {
    const header = jar({
      [SESSION_COOKIE]: SESSION,
      [VISITOR_COOKIE]: VISITOR,
      [CNPJ_SCOPE_COOKIE]: cnpjTag(CNPJ, SECRET),
    })
    const scopes = listScopes(header, SECRET)
    expect(scopes.viewer).not.toBe(scopes.device)
    // Two labels, so even a jar with only a session token cannot collide them.
    const sessionOnly = listScopes(jar({ [SESSION_COOKIE]: SESSION }), SECRET)
    expect(sessionOnly.viewer).not.toBe(sessionOnly.device)
    for (const value of [scopes.viewer, scopes.device]) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{22}$/)
    }
  })
})
