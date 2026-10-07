import { createHmac } from 'node:crypto'
import { SESSION_COOKIE, SESSION_COOKIE_SECURE } from '@/lib/auth/config'
import { sessionTokenFromCookies } from '@/lib/auth/session'
import { visitorIdFromCookies, VISITOR_COOKIE, VISITOR_COOKIE_MAX_AGE_SECONDS } from './visitor'

/**
 * **Who the Radar's answer belongs to, as one opaque string the client may key
 * a cache by** — cards D58 and D60.
 *
 * ## The defect, in both its shapes
 *
 * `lib/radar/list-cache.ts` files a list under `listKey`, which its own
 * docstring defines as "every thing that changes what the route returns". Two
 * such things were missing, and both are facts about the *caller* rather than
 * about the search:
 *
 *  * **The viewer (D58).** Since D23 the snapshot carries `favourites`, which
 *    belongs to a person. Sign out in the same tab, return to the same search
 *    inside `REVALIDATE_AFTER_MS`, and the restore is `fresh` — **no request is
 *    made at all** — so the stars drawn are the previous identity's. The other
 *    direction is the same bug: sign *in* and the stars come back empty for an
 *    account that has marks.
 *  * **The CNPJ the route resolved (D60).** `GET /api/radar/tenders` groups by
 *    `?cnpj= ?? visitors.cnpj`, and the second one is behind an `httpOnly`
 *    cookie. D19 deliberately kept it out of `GroupedBy` so that no identifier
 *    reaches `sessionStorage` (§12), which left bare `/radar` — the address the
 *    rail, the drawer, the signed-in landing, both `/fundadores` CTAs, `/conta`
 *    and the 404 all point at — with a key that constrains **nothing**. D55
 *    could only switch the cache off for it.
 *
 * ## What this is, and why it can be in a key
 *
 * A keyed digest of three **opaque** values this request already carries in its
 * cookie header:
 *
 * | input | what changing it means |
 * |---|---|
 * | the Auth.js session token | signed in, signed out, or a different account |
 * | `lq_visitor` | a different device identity, including the first one ever minted |
 * | `lq_scope` | this device's remembered CNPJ changed — see `cnpjScopeCookie` |
 *
 * §12 allows neither a CNPJ nor a user id in client storage, and none of the
 * three is either of those: two are random tokens and the third is itself a
 * keyed digest. What the client receives, and the only thing that reaches
 * `sessionStorage`, is 22 characters of HMAC over them. It cannot be read
 * backwards into any of its inputs — which matters most for the session token,
 * a bearer credential that is `httpOnly` precisely so page scripts cannot have
 * it.
 *
 * **It is two digests and not one** — `RadarScopes` — and the reason is the one
 * thing a single value could not do: be correct *while the document that uses it
 * is changing the jar*. That story is at `listScopes`.
 *
 * ## No database read, which is the whole reason it works
 *
 * The restore decision is made in `RadarScreen`'s `useState` initializer,
 * before the first paint and **before any request** — that is what makes a
 * `fresh` restore free, and it is why a value the client has to fetch could
 * never guard it. So the scope has to be computable from the request alone.
 * It is: `app/radar/page.tsx` is `force-dynamic`, so every document and every
 * RSC render of `/radar` passes through it with the cookie header in hand, and
 * this function costs one HMAC. Resolving `visitors.cnpj` there instead would
 * have cost a query on every `/radar`, and — worse — would have been a second
 * implementation of the route's own resolution, which is D29's shape.
 *
 * `lq_scope` is what replaces that query: the one place that writes
 * `visitors.cnpj` stamps a cookie in the same response, so the cookie header
 * already states the generation of what the route will resolve.
 *
 * **The cost of being a prop is that it is only as fresh as the last render of
 * that page**, and a browser back/forward reuses a page segment without
 * re-rendering it. That is **D70**, and `regrouped` in `list-cache.ts` is the
 * guard for the half of it that an answer can reach.
 *
 * ## Over-invalidating is the safe direction, and it happens
 *
 * Two sessions of the same account are two tokens and therefore two scopes, so
 * signing out and back in costs one list request for a list that was in fact
 * still correct. That is the right way round: the cost of a scope that changed
 * when it needed not have is one request, and the cost of one that did not
 * change when it should have is the defect above.
 */

/**
 * Domain separation, as `lib/telegram/token.ts` does it: `AUTH_SECRET` signs
 * Auth.js's own artefacts, so the key used here is derived from it with this
 * label and is not the same key.
 *
 * Two labels, because there are two scopes and they must never be each other —
 * see `RadarScopes`.
 */
const DEVICE_KEY_LABEL = 'licitaqui.radar.list-scope.v1'
const VIEWER_KEY_LABEL = 'licitaqui.radar.viewer-scope.v1'

/** The same, for the cookie below, so the two digests cannot be each other. */
const CNPJ_KEY_LABEL = 'licitaqui.radar.cnpj-scope.v1'

/**
 * The first 22 characters of the base64url of a 32-byte HMAC — **132 bits**, not
 * 128: the truncation is of the encoded string, which carries six bits a
 * character, and stating the wrong arithmetic in a comment about a digest is the
 * kind of number this repo has been wrong about before.
 *
 * The value is only ever compared with another produced the same way, so the bar
 * is "two different callers must not collide", and 132 bits is far past it. Short
 * because it is joined into a `sessionStorage` key.
 */
const DIGEST_CHARS = 22

/** The same shape `lib/telegram/config.ts` takes, so `process.env` fits. */
export type ScopeEnv = Record<string, string | undefined>

/**
 * `lq_scope` — **the generation of the CNPJ this device remembers**, and not
 * the CNPJ.
 *
 * `visitors.cnpj` has exactly one writer, `attachCnpj`, called from exactly one
 * place: `POST /api/radar/cnpj`, in the branch where the caller is a visitor.
 * That response stamps this cookie with a keyed digest of the CNPJ it stored,
 * so the value changes when, and only when, the thing the list route will
 * resolve changes. A re-search of the same CNPJ writes the same digest, which
 * is why it is a digest and not a nonce: nothing has to be read before it is
 * written, and a lost cookie heals to the same value on the next search.
 *
 * `httpOnly`, because nothing in the browser needs it — the server reads it to
 * build `listScope`, and the client only ever sees that digest. 30 days and
 * `SameSite=Lax`, matching `lq_visitor`, whose row it describes; losing one
 * without the other costs a list request and nothing else.
 */
export const CNPJ_SCOPE_COOKIE = 'lq_scope'

function key(label: string, env: ScopeEnv): Buffer {
  /*
   * An absent `AUTH_SECRET` is **not** a special case here, deliberately.
   *
   * Every input to `listScope` is already a high-entropy opaque token, so an
   * unkeyed digest of them is not a dictionary to be looked up — unlike
   * `visitor.ts`'s `hash()` of an IP address, whose own comment says a salt
   * would be better. The secret adds per-deployment separation where it exists;
   * where it does not (a local tree with an empty `.env`), the Radar's cache
   * keeps working rather than silently switching itself off.
   *
   * `cnpjTag` *does* digest a CNPJ, which is a dictionary — 10^14 before the
   * check digits, and the list of real ones is public. It is keyed with the
   * same material, and what protects it when there is no secret is that the
   * value never leaves an `httpOnly` cookie: it reaches no page script, no
   * `sessionStorage` and no response body.
   */
  return createHmac('sha256', env.AUTH_SECRET ?? label).update(label).digest()
}

function digest(label: string, parts: readonly (string | null)[], env: ScopeEnv): string {
  return createHmac('sha256', key(label, env))
    .update(parts.map((part) => part ?? '').join('\u0000'))
    .digest('base64url')
    .slice(0, DIGEST_CHARS)
}

/** What `CNPJ_SCOPE_COOKIE` carries. Opaque, stable, and never sent to a client. */
export function cnpjTag(cnpj: string, env: ScopeEnv = process.env): string {
  return digest(CNPJ_KEY_LABEL, [cnpj], env)
}

export function cnpjTagFromCookies(header: string | null): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const equals = trimmed.indexOf('=')
    if (equals <= 0) continue
    if (trimmed.slice(0, equals) !== CNPJ_SCOPE_COOKIE) continue
    // Our own value is base64url, so it never needs decoding; anything that
    // does is not ours and is compared as it arrived rather than thrown over.
    // `session.ts` learned that the hard way — one unrelated `%` in the jar
    // signed a paying subscriber out.
    return trimmed.slice(equals + 1) || null
  }
  return null
}

/** The `Set-Cookie` for a CNPJ this request just attached to a `visitors` row. */
export function cnpjScopeCookie(
  cnpj: string,
  options: { secure?: boolean; env?: ScopeEnv } = {},
): string {
  const env = options.env ?? process.env
  // From the `env` this function was handed, not from `process.env` behind its
  // back: the whole point of the parameter is that it is injectable.
  const secure = options.secure ?? env.NODE_ENV === 'production'
  const parts = [
    `${CNPJ_SCOPE_COOKIE}=${cnpjTag(cnpj, env)}`,
    'Path=/',
    `Max-Age=${VISITOR_COOKIE_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * The scope of every answer `GET /api/radar/tenders` would give this request.
 *
 * Pure, synchronous, no database, no `next/headers`: it takes the raw `Cookie`
 * header, so a route handler, a server component and a test can all ask it the
 * same question. The raw header and not `cookies().getAll()`, for the reason
 * `lib/account/server-summary.ts` records — those values come back already
 * percent-decoded.
 */
export type RadarScopes = {
  /**
   * **The caller, for a list whose CNPJ is in the URL.** The session token and
   * nothing else.
   *
   * `GET /api/radar/tenders` uses `params.cnpj` when it is given and never
   * reaches the cookie fallback, so for those addresses the cookie-derived half
   * cannot change the answer: the rows, the groups and the header all come from
   * a CNPJ `listKey` already carries, and the only caller fact left is whose
   * stars they are. Narrower, and therefore stable.
   */
  viewer: string
  /**
   * **The caller, for a list the cookie decides** — a bare `/radar`, or
   * `/radar?q=…`, where the route resolves `visitors.cnpj`. The session token,
   * the device identity and the generation of the CNPJ that device remembers.
   */
  device: string
}

/**
 * The scopes of the answers `GET /api/radar/tenders` would give this request —
 * **two of them, and the split is a correctness fix, not an optimisation.**
 *
 * ## Why one value was wrong, and the first version of this file shipped it
 *
 * D58's argument for a single digest was that the snapshot is one object filled
 * by one response, so the finest useful granularity is "could this response have
 * differed". That is right about the *response* and wrong about **when the
 * client can know the digest**, which is the thing that actually has to hold.
 *
 * The scope is computed once per render of `app/radar/page.tsx`. Our own
 * `POST /api/radar/cnpj` then stamps `lq_scope` — and, on a device that has
 * never searched, mints `lq_visitor` — **after** that render, from a request the
 * screen itself makes. So on the first search of a device, and on every change
 * of company, a single digest went stale *inside the document that was writing
 * snapshots with it*: everything saved was filed under a scope that no longer
 * existed, and the next document load missed it. The journey that broke is the
 * one `list-cache.ts` was written for — `?cnpj=B`, three *Ver mais editais*, open
 * an edital, **Voltar** — which went from 60 cards and 3 000 px of scroll back to
 * 20 and zero. A regression on `main`, found by a review of this diff and by no
 * test, because `e2e/fixtures/radar-api.ts` used to stamp the cookie before the
 * first navigation and so only ever modelled the steady state.
 *
 * ## The split, and why it is exactly the right line
 *
 * `postCnpj` runs **only** inside `if (cnpj)` in `radar-screen.tsx`, where `cnpj`
 * is the *URL's*. So the documents whose jar changes under us are precisely the
 * documents whose answer the jar cannot influence, and the other way round:
 *
 * | the URL | what decides the answer | which scope | can the jar change mid-document? |
 * |---|---|---|---|
 * | names a CNPJ | `params.cnpj`, already in `listKey` | `viewer` | yes — and it does not matter |
 * | names none | `visitors.cnpj`, which nothing here can read | `device` | **no**: with no `?cnpj=` nothing is posted |
 *
 * The client picks, in `RadarScreen`, because it is the one place that has
 * already normalised `?cnpj=` — asking the page to decide would be a second copy
 * of that decision, which is D29's shape.
 *
 * What `viewer` gives up is the visitor banner's numbers, which ride in the
 * snapshot and are per-device: two anonymous devices searching the same CNPJ
 * share a `viewer` scope. They do not share a browser, so they do not share a
 * `sessionStorage`, and within one browser the visitor identity changes only by
 * being minted — which is the transition this split exists to survive.
 *
 * ## Why the mint cannot poison the `device` scope either, which is not obvious
 *
 * The split keeps the mint out of the key for an address that names a CNPJ. The
 * reader's next question is the one the first version of this file left
 * unanswered: a brand-new device's mint also changes `device`, so what about a
 * snapshot written *before* it?
 *
 * **There cannot be one.** `device` only ever keys an address with no `?cnpj=`,
 * and before the mint such a device has no `lq_visitor`, so
 * `GET /api/radar/tenders` resolves no CNPJ from either place and answers
 * `400 cnpjRequired` — which `radar-screen.tsx` turns into `INITIAL` with
 * `key: ''`, and the save effect returns on an empty list and on `readAt === 0`
 * regardless. So the pre-mint `device` scope names nothing that was ever stored,
 * and the first list that *can* be cached under it is read after the mint.
 *
 * It is written down because it is load-bearing and no test drives it: a journey
 * would have to mint the cookie mid-flight on an address that cannot produce a
 * cacheable list, which is a path with no observable difference to assert.
 */
export function listScopes(cookieHeader: string | null, env: ScopeEnv = process.env): RadarScopes {
  const session = sessionTokenFromCookies(cookieHeader)
  return {
    viewer: digest(VIEWER_KEY_LABEL, [session], env),
    device: digest(
      DEVICE_KEY_LABEL,
      [session, visitorIdFromCookies(cookieHeader), cnpjTagFromCookies(cookieHeader)],
      env,
    ),
  }
}

/** Re-exported so a reader of this file can see the whole cookie jar it reads. */
export const SCOPE_INPUT_COOKIES = [
  SESSION_COOKIE,
  SESSION_COOKIE_SECURE,
  VISITOR_COOKIE,
  CNPJ_SCOPE_COOKIE,
] as const
