import type {
  BandResponse,
  CnpjResponse,
  JobResponse,
  ScreeningReadResponse,
  ScreeningResponse,
  TenderGroup,
  TenderListResponse,
  TenderResponse,
  TenderSort,
} from './contract'
import { DEFAULT_SORT } from './contract'
import { readMeEpp, readModality, type MeEppFilter, type ModalityFilter } from './filters'
import { readGroup } from './group'
import { readSort } from './sort'
import type { JobStatus } from './poll'
import { canonicalUfs, readUfs } from './ufs'

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
 * The search a Radar screen is carrying: everything that decides which list
 * the user came from, spelled the way the Radar itself reads them (`uf`, not
 * `state`).
 *
 * It is the same set of fields `lib/radar/list-cache.ts` keys a snapshot on, and
 * that is not a coincidence — a link that drops one of them lands on a
 * different key and the restore misses, which to a user is indistinguishable
 * from having lost the search.
 */
export type RadarSearch = {
  cnpj?: string | null
  /**
   * The UFs, canonical (`canonicalUfs`); empty or absent is *Todo o Brasil*.
   * Written as one `uf=` per state, which is also what the filter form's
   * checkboxes post, so the form works before React has hydrated.
   */
  states?: readonly string[] | null
  q?: string | null
  /** D52's modalidade, by slug. `null` is *Todas* and is left out of the URL. */
  modality?: ModalityFilter | null
  /** D52's ME/EPP choice. `null` is *Todas* and is left out of the URL. */
  meEpp?: MeEppFilter | null
  group?: TenderGroup | null
  /**
   * The order (D51). Carried with the other four because it is part of *the
   * list the reader was looking at*: a "Voltar" that drops it lands on the same
   * search re-sorted, which is the same class of loss as dropping the keyword.
   */
  sort?: TenderSort | null
}

/**
 * D52's two parameters, spelled once.
 *
 * The same names on the Radar's own address and on the route's query string —
 * unlike `uf`/`state`, which are two spellings of one filter and have to be
 * translated at every boundary. The form inside `FilterRow` posts these same
 * two names to `/radar`, so the control works before React has hydrated.
 */
export const MODALITY_PARAM = 'modality'
export const ME_EPP_PARAM = 'meepp'

/**
 * Every address out of a Radar screen carries the search. **Required, on
 * purpose** — see the note on `screeningHref` below.
 */
function searchParams(search: RadarSearch): URLSearchParams {
  const params = new URLSearchParams()
  if (search.cnpj) params.set('cnpj', search.cnpj)
  for (const state of canonicalUfs(search.states ?? [])) params.append('uf', state)
  if (search.q) params.set('q', search.q)
  if (search.modality) params.set(MODALITY_PARAM, search.modality)
  if (search.meEpp) params.set(ME_EPP_PARAM, search.meEpp)
  if (search.group) params.set('group', search.group)
  // **The default is written as its absence**, which is the opposite of
  // `group`'s rule two lines up and for a stated reason: there is no "unchosen
  // order" for the product to resolve, so `?sort=deadline` and no `sort` at all
  // are the same list. Spelling it out would put a parameter into every address
  // the Radar already draws and make `radarHref(readSearch(url))` differ from
  // `url` on every page that has never sorted by value.
  if (search.sort && search.sort !== DEFAULT_SORT) params.set('sort', search.sort)
  return params
}

function withParams(base: string, params: URLSearchParams): string {
  const query = params.toString()
  return query ? `${base}?${query}` : base
}

/**
 * The Radar's own path for a tender. A catch-all route, so the slash survives.
 *
 * Exported for `/conta/favoritos` (D23), which links to a tender **without** a
 * search: that list is not a search result, so carrying a query string would
 * send "Voltar" back to a list the reader never ran.
 */
export function editalPath(id: string): string {
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
export function tenderHref(id: string, search: RadarSearch, tab?: 'files'): string {
  const params = searchParams(search)
  // **`?tab=files` exists so a link can land on Documentos.** The tab is local
  // state on the Opportunity screen, so without this the screening screen's
  // "Documentos" tab sent a reader to the same page's *Itens* — they clicked
  // Documentos and got something else, which is barely better than the
  // padlock it replaced.
  if (tab) params.set(TAB_PARAM, tab)
  return withParams(editalPath(id), params)
}

/** `?tab=files` — the only tab worth addressing from outside the screen. */
export const TAB_PARAM = 'tab'

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
export function readSearch(params: {
  get(name: string): string | null
  getAll(name: string): string[]
}): RadarSearch {
  return {
    cnpj: (params.get('cnpj') ?? '').replace(/\D+/g, '') || null,
    states: readUfs(params),
    q: (params.get('q') ?? '').trim() || null,
    modality: readModality(params.get(MODALITY_PARAM)),
    meEpp: readMeEpp(params.get(ME_EPP_PARAM)),
    group: readGroup(params.get('group')),
    // Never `null`: absent means the deadline order (`readSort`).
    sort: readSort(params.get('sort')),
  }
}

/**
 * `readSearch` for a server page's `searchParams`, a record whose values may be
 * repeated. Here and not in the page so it can be tested: it used to keep only
 * `value[0]`, which read `?uf=SP&uf=RJ` as SP alone, and the edital's
 * server-rendered "Voltar" then dropped every UF but one (multi-UF, 2026-10-09).
 * A single-valued key still reads the same: `readSearch` asks it with `get`.
 */
export function readSearchRecord(query: Record<string, string | string[] | undefined>): RadarSearch {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    for (const one of Array.isArray(value) ? value : [value]) {
      if (typeof one === 'string') params.append(key, one)
    }
  }
  return readSearch(params)
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
  /** Canonical UFs; empty is every state. One `state=` each on the wire. */
  states?: readonly string[] | null
  q?: string | null
  modality?: ModalityFilter | null
  meEpp?: MeEppFilter | null
  limit?: number
  cursor?: string | null
  sort?: TenderSort | null
}

export function tendersUrl(query: TenderQuery): string {
  const params = new URLSearchParams({ group: query.group })
  if (query.cnpj) params.set('cnpj', query.cnpj)
  for (const state of canonicalUfs(query.states ?? [])) params.append('state', state)
  if (query.q) params.set('q', query.q)
  if (query.modality) params.set(MODALITY_PARAM, query.modality)
  if (query.meEpp) params.set(ME_EPP_PARAM, query.meEpp)
  if (query.limit) params.set('limit', String(query.limit))
  if (query.cursor) params.set('cursor', query.cursor)
  // Left out when it is the default, for the same reason `searchParams` leaves
  // it out: the route's own fallback is `DEFAULT_SORT`, so the shortest URL and
  // the explicit one ask for the same page.
  if (query.sort && query.sort !== DEFAULT_SORT) params.set('sort', query.sort)
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
 * `GET /api/tenders/:id/band?item=N` (E9) — the price band for one item.
 *
 * Separate from `getTender` on purpose: the band costs a trigram join, and the
 * Opportunity screen reads the tender without ever showing one.
 */
export async function getBand(
  id: string,
  item: number,
  signal?: AbortSignal,
): Promise<BandResponse> {
  return envelope<BandResponse>(
    await fetch(`/api/tenders/${tenderApiPath(id)}/band?item=${item}`, { signal }),
  )
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
