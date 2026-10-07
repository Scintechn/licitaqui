import type { TenderListResponse } from '@/lib/radar/contract'
import type { RadarStatus } from './radar-view'

/**
 * D55 — what a bare `/radar` may conclude on its own, and what only the route
 * can tell it.
 *
 * `radar-screen.tsx` used to answer the question itself: no `?cnpj=` and no
 * `?q=` meant `needCnpj`, decided **before any request left**. `/radar` carries
 * neither — and it is the address the shell rail, the drawer, the signed-in
 * landing, both `/fundadores` CTAs, `/conta` and the 404 all point at. So the
 * commonest way into the product asked a returning visitor for a CNPJ that
 * `GET /api/radar/tenders` would have resolved out of `visitors.cnpj`, because
 * the cookie carrying it is `httpOnly` and no browser code can read it. That is
 * D19's defect one layer up: the client deciding from the URL what only the
 * route knows.
 *
 * The three decisions are here, as functions of their inputs, because
 * `vitest.config.mts` is `environment: 'node'` and runs no effects
 * (CLAUDE.md §4c): this file is what a unit test can hold. The **result** — a
 * cookie, a mount and a response — lives in `e2e/journeys/radar-bare.spec.ts`.
 */

/**
 * What the screen holds while the first list request is in flight.
 *
 * Never `needCnpj`. A bare `/radar` that drew *"Comece pelo CNPJ da sua
 * empresa"* and replaced it with that company's list one response later would
 * be a refusal the product immediately contradicts — D24's "correct for exactly
 * one frame", in the other direction.
 *
 * `what` names the read that is outstanding, and the two are not
 * interchangeable: `POST /api/radar/cnpj` only happens when the URL carries a
 * CNPJ, so without one the only thing being waited on is the list, and
 * *"Consultando o CNPJ…"* would name a request nobody made. It is also the
 * **first, server-rendered frame** of this page, which is `force-dynamic`.
 */
export function loadingStatus(cnpj: string | null): RadarStatus {
  return { kind: 'analyzing', what: cnpj ? 'company' : 'list' }
}

/**
 * The route could resolve no CNPJ at all — not from `?cnpj=`, not from the
 * cookie — and said so: `400 validation` with `fields.cnpj = 'cnpjRequired'`
 * (`app/api/radar/tenders/route.ts`). This answer, and nothing else, is what
 * `needCnpj` means now.
 *
 * Deliberately narrow on all three fields. `cnpjInvalid` is the *same*
 * `validation` code about a CNPJ that was given and is malformed, and meeting
 * it with "informe um CNPJ" would hide the reader's own typo behind an empty
 * state; `server_error`, `rate_limited` and `not_found` are statements about us
 * rather than about what the reader is missing, and they keep the retry card
 * they have always had.
 */
export function isCnpjRequired(answer: TenderListResponse): boolean {
  return (
    answer.state === 'error' &&
    answer.error === 'validation' &&
    answer.fields?.cnpj === 'cnpjRequired'
  )
}

/**
 * **The whole of this list is the cookie's**, so it is not cached — neither
 * saved nor restored.
 *
 * `listKey` is every parameter that changes what the route returns, and for a
 * bare `/radar` the deciding one is `visitors.cnpj` — `httpOnly`, and
 * deliberately kept out of `GroupedBy` so that it never reaches page JavaScript
 * or `sessionStorage` (D19, spec §12). The key for this shape therefore
 * constrains **nothing**: its rows, its groups and its header all come from a
 * fact it does not contain, which is what `listKey`'s own docstring calls "a
 * list restored under another list's name". And `list-cache.ts` trusts a direct
 * key hit: inside `REVALIDATE_AFTER_MS` it is served with **no request at
 * all**.
 *
 * Both ages are wrong, in different ways. Under a minute: search company B,
 * press *Radar* in the rail, and company A's editais come back under A's name
 * while the device is on B — right-looking and stale. Over a minute is worse,
 * because `revalidate` merges page 1 **by id** (`refreshTenders`), so the fresh
 * answer swaps the header to B and leaves A's rows under it — D19's own defect,
 * recreated by D19's own fix.
 *
 * ## Why `?q=` is *not* in here, although it is also partly the cookie's
 *
 * The name of this function is exact and the boundary is narrower than
 * "anything the cookie decides". `GET /api/radar/tenders` resolves the cookie
 * **before** it checks for a keyword, so `/radar?q=expediente` with a cookie
 * CNPJ is grouped by that company too: its `groupedBy`, its `counts` and which
 * tab each row lands in are all the cookie's, and only the row set is the
 * keyword's. That snapshot is mis-keyed in exactly the same way, one degree
 * less badly — the key at least constrains which editais can appear.
 *
 * It is left alone here for two reasons, and neither is that it is fine.
 * It **predates D55** — a keyword list has been saved under an identity-less
 * key since the cache was written — and switching it off would take the
 * snapshot away from every keyword search, including the journey D19 ships,
 * which is a product cost rather than a correction. **D60** carries both
 * shapes, and its fix (a discriminator the route reports, rejected on mismatch)
 * covers them without that cost. What this function must not do is pretend the
 * line it draws is the whole of the problem.
 *
 * What the bare shape costs meanwhile is the way back from an edital opened
 * here: one list request, and the scroll position.
 */
export function wholeListFromCookie(cnpj: string | null, q: string | null): boolean {
  return !cnpj && !q
}
