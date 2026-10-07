import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { POST as postCnpj } from '@/app/api/radar/cnpj/route'
import { closeDb, pool } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import { resetRateLimits } from '@/lib/rate-limit'
import { CNPJ_SCOPE_COOKIE, cnpjTag, listScopes } from './scope'
import { VISITOR_COOKIE } from './visitor'

/**
 * D60 — **the one writer, against the real route and the real row.**
 *
 * `listScope` turns the request's cookies into the discriminator the Radar's
 * snapshot cache keys by, and one of its three inputs is `lq_scope`: the
 * generation of the CNPJ this device remembers. Nothing in the browser can
 * compute that — `visitors.cnpj` is behind an `httpOnly` cookie, which is the
 * whole reason D19, D55 and D60 exist — so it is stamped by the response that
 * writes the row.
 *
 * ## Why this suite has to exist, and why no other one covers it
 *
 * `scope.test.ts` asserts the digest's shape and the cookie's attributes: the
 * **unit**. `e2e/journeys/radar-snapshot-identity.spec.ts` asserts what the
 * browser does when the cookie changes — but the journeys never let a request
 * reach a route handler (`playwright.config.ts`: no `DATABASE_URL`), so the
 * fixture sets that cookie itself. If the route stopped stamping it tomorrow,
 * both of those suites would stay green while the guard silently stopped firing
 * on every change of company. This is the seam between them: the real handler,
 * the real `visitors` row, and the header it actually sends.
 *
 * ## Isolation
 *
 * Own `RUN_ID`, generated per Vitest process and never a per-task constant
 * (CLAUDE.md): the two CNPJs below are unique to this run and `cleanup()`
 * deletes exactly the rows reachable from them. Nothing here reads a row it did
 * not write, and no predicate looks at an age.
 */

const url = testDatabaseUrl('TEST_DATABASE_URL_D3') ?? testDatabaseUrl()
const suite = url ? describe : describe.skip
if (url) process.env.DATABASE_URL = url

const RUN_ID = randomUUID().replace(/-/g, '').slice(0, 6)

/**
 * Two CNPJs this run owns, with real check digits.
 *
 * `normaliseCnpj` verifies mod-11 and the route answers `400 cnpjInvalid`
 * otherwise, so an invented fourteen digits will not do — the first draft of
 * this file used one and all three tests failed on the status before reaching
 * the cookie. The twelve-digit root is the run id, which no other run can be
 * searching, and `withCheckDigits` finishes it the way the real validator will
 * read it.
 */
function withCheckDigits(root: string): string {
  const digit = (slice: string): number => {
    let weight = slice.length - 7
    let sum = 0
    for (const character of slice) {
      sum += Number(character) * weight
      weight -= 1
      if (weight < 2) weight = 9
    }
    const rest = sum % 11
    return rest < 2 ? 0 : 11 - rest
  }
  const twelve = root.slice(0, 12)
  const thirteen = `${twelve}${digit(twelve)}`
  return `${thirteen}${digit(thirteen)}`
}

/** The run id, as digits: enough entropy that no other run shares the root. */
const ROOT = `${BigInt(`0x${RUN_ID}`).toString().padStart(10, '0').slice(0, 10)}`

const FIRST = withCheckDigits(`${ROOT}01`)
const SECOND = withCheckDigits(`${ROOT}02`)

function request(cookies: Record<string, string>, cnpj: string): Request {
  const cookie = Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ')
  return new Request('https://licitaqui.test/api/radar/cnpj', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
      'user-agent': `scope-db-${RUN_ID}`,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ cnpj }),
  })
}

/** Every `Set-Cookie` the route sent, which is more than one now. */
function cookiesFrom(response: Response): string[] {
  return response.headers.getSetCookie()
}

function valueOf(cookies: string[], name: string): string | null {
  for (const cookie of cookies) {
    const match = new RegExp(`(?:^|; )${name}=([^;]*)`).exec(cookie)
    if (match) return match[1]
  }
  return null
}

async function cleanup() {
  const client = pool()
  const cnpjs = [FIRST, SECOND]
  await client.query(
    `delete from events where visitor_id in (select id from visitors where cnpj = any($1::bpchar[]))`,
    [cnpjs],
  )
  await client.query('delete from visitors where cnpj = any($1::bpchar[])', [cnpjs])
  await client.query('delete from jobs where key like any($1::text[])', [
    cnpjs.map((cnpj) => `%${cnpj}%`),
  ])
  await client.query('delete from companies where cnpj = any($1::bpchar[])', [cnpjs])
}

suite('the CNPJ generation cookie (database)', () => {
  beforeAll(cleanup)
  beforeEach(() => {
    resetRateLimits()
  })
  afterAll(async () => {
    await cleanup()
    await closeDb()
  })

  it('is stamped beside the visitor cookie by the response that writes the row', async () => {
    const response = await postCnpj(request({}, FIRST))
    // No `companies` row for a CNPJ this run invented, so this is the `202`
    // branch — and that is the stronger case: `attachCnpj` has already written
    // the row, so the cookie must be sent before the company is known rather
    // than only on the happy path.
    expect(response.status).toBe(202)

    const cookies = cookiesFrom(response)
    const visitorId = valueOf(cookies, VISITOR_COOKIE)
    const tag = valueOf(cookies, CNPJ_SCOPE_COOKIE)

    expect(visitorId, 'the device identity').toBeTruthy()
    expect(tag, 'the generation of what it remembers').toBe(cnpjTag(FIRST))

    // The row the cookie describes. The whole point of the cookie is that the
    // next request can know this without reading it.
    const row = await pool().query<{ cnpj: string }>('select cnpj from visitors where id = $1', [
      visitorId,
    ])
    expect(row.rows[0]?.cnpj.trim()).toBe(FIRST)

    // §12: the CNPJ is in the row and nowhere in the header.
    expect(cookies.join(' ')).not.toContain(FIRST)
    expect(cookies.some((cookie) => cookie.startsWith(`${CNPJ_SCOPE_COOKIE}=`))).toBe(true)
  })

  it('moves when the device searches another company, and the scope with it', async () => {
    const first = await postCnpj(request({}, FIRST))
    const visitorId = valueOf(cookiesFrom(first), VISITOR_COOKIE)!
    const firstTag = valueOf(cookiesFrom(first), CNPJ_SCOPE_COOKIE)!

    resetRateLimits()
    const second = await postCnpj(
      request({ [VISITOR_COOKIE]: visitorId, [CNPJ_SCOPE_COOKIE]: firstTag }, SECOND),
    )
    const secondTag = valueOf(cookiesFrom(second), CNPJ_SCOPE_COOKIE)
    // Same device, same `visitors` row, new CNPJ — and `listKey` has no CNPJ in
    // it for a bare `/radar`, so this cookie is the only thing that can tell
    // the two lists apart.
    expect(valueOf(cookiesFrom(second), VISITOR_COOKIE)).toBeNull()
    expect(secondTag).not.toBe(firstTag)
    expect(secondTag).toBe(cnpjTag(SECOND))

    const row = await pool().query<{ cnpj: string }>('select cnpj from visitors where id = $1', [
      visitorId,
    ])
    expect(row.rows[0]?.cnpj.trim(), 'the row the route resolves from').toBe(SECOND)

    /*
     * And the thing that actually guards the cache: the scope the Radar's page
     * will compute for the two jars. This is the assertion the whole chain
     * exists for — a changed company is a changed key, so the snapshot of the
     * previous company is not found rather than merged into.
     */
    const before = listScopes(`${VISITOR_COOKIE}=${visitorId}; ${CNPJ_SCOPE_COOKIE}=${firstTag}`)
    const after = listScopes(`${VISITOR_COOKIE}=${visitorId}; ${CNPJ_SCOPE_COOKIE}=${secondTag}`)
    expect(after.device, 'the scope a bare /radar keys by').not.toBe(before.device)
    /*
     * And the **viewer** scope is unmoved, which is the other half of the fix
     * this cookie's ordering forced (see `listScopes`): the document that posts
     * the CNPJ is the document this response changes the jar of, so a list keyed
     * by `?cnpj=` must not depend on it or every snapshot that document writes is
     * filed under a digest that has already stopped being current.
     */
    expect(after.viewer, 'and a list whose CNPJ is in the URL does not key by it').toBe(
      before.viewer,
    )
  })

  it('re-stamps the same value when the same company is searched again', async () => {
    const first = await postCnpj(request({}, FIRST))
    const visitorId = valueOf(cookiesFrom(first), VISITOR_COOKIE)!

    resetRateLimits()
    // A jar that lost the cookie — cleared site data, or a deploy that added it
    // after this device's last search. It heals rather than staying wrong,
    // which is why the value is a digest of the CNPJ and not a nonce.
    const again = await postCnpj(request({ [VISITOR_COOKIE]: visitorId }, FIRST))
    expect(valueOf(cookiesFrom(again), CNPJ_SCOPE_COOKIE)).toBe(cnpjTag(FIRST))
  })
})
