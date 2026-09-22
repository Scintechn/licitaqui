import type {
  CnpjResponse,
  JobResponse,
  ScreeningReadResponse,
  ScreeningResponse,
  TenderGroup,
  TenderListResponse,
  TenderResponse,
} from './contract'
import { readGroup } from './group'
import type { JobStatus } from './poll'
import { normaliseUf } from './ufs'

/**
 * The browser's side of the Radar routes (spec §8).
 *
 * Four thin typed wrappers around `fetch`. They exist so the screens never
 * build a URL or read `response.status` themselves: **the envelope is the
 * contract**, and every route answers `ready` / `analyzing` / `error` with the
 * status code agreeing with it (§3.1). A screen that switched on
 * `response.ok` would treat the `202` "analyzing" as a success with missing
 * data, which is the bug this shape exists to make impossible.
 *
 * A transport failure — the phone lost signal, the tab is offline — is the one
 * thing not in the envelope, so it is thrown and the screen shows
 * `messages.errors.network`. Everything the server had an opinion about comes
 * back as data.
 */

/**
 * A PNCP id contains a slash (`51885242000140-1-000744/2026`), and the two
 * routes that take one are shaped differently — so it is encoded twice over,
 * differently, and neither spelling works in the other's place.
 *
 * | route | segment | encoding |
 * |---|---|---|
 * | `/radar/edital/[...id]` | catch-all | the slash stays a separator |
 * | `/api/tenders/[id]` | one segment | the slash becomes `%2F` |
 *
 * Sending the page's spelling to the API answers 404 — the route does not
 * match two segments — which is exactly the mistake these two functions exist
 * to make impossible to write by hand.
 */
export function tenderPath(id: string): string {
  return id.split('/').map(encodeURIComponent).join('/')
}

/** The single-segment spelling `/api/tenders/[id]` matches. */
export function tenderApiPath(id: string): string {
  return encodeURIComponent(id)
}

/**
 * The search a Radar screen is carrying: the four things that decide which
 * list the user came from, spelled the way the Radar itself reads them (`uf`,
 * not `state`).
 *
 * It is the same four fields `lib/radar/list-cache.ts` keys a snapshot on, and
 * that is not a coincidence — a link that drops one of them lands on a
 * different key and the restore misses, which to a user is indistinguishable
 * from having lost the search.
 */
export type RadarSearch = {
  cnpj?: string | null
  state?: string | null
  q?: string | null
  group?: TenderGroup | null
}

/**
 * Every address out of a Radar screen carries the search. **Required, on
 * purpose** — see the note on `screeningHref` below.
 */
function searchParams(search: RadarSearch): URLSearchParams {
  const params = new URLSearchParams()
  if (search.cnpj) params.set('cnpj', search.cnpj)
  if (search.state) params.set('uf', search.state)
  if (search.q) params.set('q', search.q)
  if (search.group) params.set('group', search.group)
  return params
}

function withParams(base: string, params: URLSearchParams): string {
  const query = params.toString()
  return query ? `${base}?${query}` : base
}

/** The Radar's own path for a tender. A catch-all route, so the slash survives. */
function editalPath(id: string): string {
  return `/radar/edital/${tenderPath(id)}`
}

/**
 * The tender's page on the Radar, carrying the search that found it.
 *
 * `opportunity-screen.tsx` builds its "Voltar" link out of `cnpj`, `uf`, `q`
 * and `group` read from its own query string — and the Radar's cards linked to
 * a bare `/radar/edital/…`, so those parameters were never there and the link
 * went to a bare `/radar`: no CNPJ, no keyword, no tab. Sci's "I move back to
 * the list of editais, I lost the search" is that link.
 */
export function tenderHref(id: string, search: RadarSearch): string {
  return withParams(editalPath(id), searchParams(search))
}

/**
 * The Radar's URL for a tender's AI screening — canvas 04.
 *
 * ## Why `search` is a required argument here, and on every function above
 *
 * The first cure for the bug above added a *second* function next to the bare
 * one and converted a single call site. The bare form stayed the shortest
 * thing to type and the default thing to reach for, so the same bug was still
 * there one screen further along: the triagem link, the preço link, and the
 * two "Criar conta" links all dropped the search, and back-navigation out of
 * the triagem landed on a stripped list. Sci found it the same evening.
 *
 * So there is no bare form any more. A Radar screen has exactly one `search`
 * and every address it draws is built from it; omitting it is a type error
 * rather than a link that looks fine until someone presses Voltar twice. A
 * caller that genuinely has nothing to carry writes `{}`, which is visible in
 * review and in a grep — and `client.test.ts` pins that no screen builds one
 * of these URLs by hand instead.
 */
export function screeningHref(id: string, search: RadarSearch): string {
  return withParams(`${editalPath(id)}/triagem`, searchParams(search))
}

/** …and the locked price block behind it — canvas 05. */
export function priceHref(id: string, search: RadarSearch, item?: number | null): string {
  const params = searchParams(search)
  if (item) params.set('item', String(item))
  return withParams(`${editalPath(id)}/preco`, params)
}

/**
 * `/radar?cnpj=…&uf=…&q=…&group=…`, with the empty parameters left out.
 *
 * Here rather than in the Radar's own files because the Landing form builds it
 * too, and the Landing must not pull the whole Radar view into its bundle.
 *
 * ## Why `group=compatible` is now written out
 *
 * It used to be left implicit, which made a URL unable to say the one thing
 * the Radar has to know: whether the user *chose* a tab. Absent and
 * "compatible" were the same address, so a search whose hits are all in
 * Palavras opened on an empty Compatíveis and could not be helped without also
 * overriding someone who had pressed Compatíveis on purpose. A caller that
 * passes a group now always gets it in the URL; a caller that passes none —
 * the Landing's form — still gets a URL with no `group` at all, which is what
 * "I have not chosen" looks like.
 */
export function radarHref(search: RadarSearch): string {
  return withParams('/radar', searchParams(search))
}

/**
 * The search a screen was opened with, read back out of its own query string.
 *
 * One reader for all three tender screens, so "which parameters travel" is
 * decided once. `group` is `null` when the user has not chosen a tab
 * (`readGroup`), which is a different address from `group=compatible` and must
 * stay one; `restoreList` already bridges the two when it looks for a snapshot.
 */
export function readSearch(params: { get(name: string): string | null }): RadarSearch {
  return {
    cnpj: (params.get('cnpj') ?? '').replace(/\D+/g, '') || null,
    state: normaliseUf(params.get('uf')),
    q: (params.get('q') ?? '').trim() || null,
    group: readGroup(params.get('group')),
  }
}

async function envelope<T>(response: Response): Promise<T> {
  // Every route answers JSON, including its errors. A body that is not JSON is
  // an infrastructure failure (a proxy error page), not an application state.
  return (await response.json()) as T
}

export async function postCnpj(cnpj: string, signal?: AbortSignal): Promise<CnpjResponse> {
  const response = await fetch('/api/radar/cnpj', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cnpj }),
    signal,
  })
  return envelope<CnpjResponse>(response)
}

export type TenderQuery = {
  group: TenderGroup
  cnpj?: string | null
  state?: string | null
  q?: string | null
  limit?: number
  cursor?: string | null
}

export function tendersUrl(query: TenderQuery): string {
  const params = new URLSearchParams({ group: query.group })
  if (query.cnpj) params.set('cnpj', query.cnpj)
  if (query.state) params.set('state', query.state)
  if (query.q) params.set('q', query.q)
  if (query.limit) params.set('limit', String(query.limit))
  if (query.cursor) params.set('cursor', query.cursor)
  return `/api/radar/tenders?${params.toString()}`
}

export async function getTenders(
  query: TenderQuery,
  signal?: AbortSignal,
): Promise<TenderListResponse> {
  return envelope<TenderListResponse>(await fetch(tendersUrl(query), { signal }))
}

export async function getTender(id: string, signal?: AbortSignal): Promise<TenderResponse> {
  return envelope<TenderResponse>(await fetch(`/api/tenders/${tenderApiPath(id)}`, { signal }))
}

/**
 * `GET /api/jobs/:id` reduced to the one word `waitForData` needs. A 404 is
 * `gone`, not a failure: the job may have been collected after finishing, and
 * the row it wrote is still there to be read.
 */
export async function getJobStatus(id: number, signal?: AbortSignal): Promise<JobStatus> {
  const response = await fetch(`/api/jobs/${id}`, { signal })
  if (response.status === 404) return 'gone'
  const body = await envelope<JobResponse>(response)
  return body.state === 'ready' ? body.job.status : 'gone'
}

/**
 * `POST /api/tenders/:id/screening` — **ask** for the triagem.
 *
 * This is the call that spends a screening, so the screen makes it once per
 * visit and then polls `getScreening`. Asking again for the same tender is
 * free (`quota.spend` de-duplicates on the tender id), which is what makes a
 * retry button safe.
 */
export async function postScreening(id: string, signal?: AbortSignal): Promise<ScreeningResponse> {
  const response = await fetch(`/api/tenders/${tenderApiPath(id)}/screening`, {
    method: 'POST',
    signal,
  })
  return envelope<ScreeningResponse>(response)
}

/**
 * `GET /api/tenders/:id/screening` — **read** it, for a caller who already
 * asked. Never spends and never enqueues, so it is the one the 3-second poll
 * hits; it answers `pending` while the worker is still reading.
 */
export async function getScreening(
  id: string,
  signal?: AbortSignal,
): Promise<ScreeningReadResponse> {
  const response = await fetch(`/api/tenders/${tenderApiPath(id)}/screening`, { signal })
  return envelope<ScreeningReadResponse>(response)
}
