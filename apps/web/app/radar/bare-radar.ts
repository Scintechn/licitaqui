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
 * **Two** decisions are here, as functions of their inputs, because
 * `vitest.config.mts` is `environment: 'node'` and runs no effects
 * (CLAUDE.md §4c): this file is what a unit test can hold. The **result** — a
 * cookie, a mount and a response — lives in `e2e/journeys/radar-bare.spec.ts`.
 *
 * **D60 removed `wholeListFromCookie`, which used to be the third decision in
 * this file**, and the note is kept because the shape it named is still the one
 * everything here is about.
 *
 * It answered "is the whole of this list the cookie's" — `!cnpj && !q` — and
 * three call sites in `radar-screen.tsx` used it to switch the snapshot cache
 * **off**, because `listKey` could not see `visitors.cnpj`: `httpOnly`, and kept
 * out of `GroupedBy` so that no identifier reaches `sessionStorage` (D19,
 * spec §12). A key that constrains nothing is a list filed under another list's
 * name, and inside `REVALIDATE_AFTER_MS` `list-cache.ts` serves a direct hit with
 * no request at all.
 *
 * Its last assertion recorded that `/radar?q=…` answering `false` was a decision
 * and not an oversight: the route resolves the cookie **before** it looks for a
 * keyword, so that list is grouped by the cookie's company too and was mis-keyed
 * in the same way, one degree less badly. Switching *that* off would have taken
 * the cache from every keyword search, which is a product cost rather than a
 * correction.
 *
 * Both shapes are fixed, and neither by disabling anything: `listKey` now opens
 * with an opaque `scope` the server computes from the request's cookies
 * (`lib/radar/scope.ts`), so the key names what the route resolved without the
 * browser ever being told what it is. There is nothing left for a predicate here
 * to be narrow about — which is why the function is gone rather than left
 * unused with a comment.
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
