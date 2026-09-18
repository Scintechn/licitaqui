import type {
  CnpjResponse,
  JobResponse,
  TenderGroup,
  TenderListResponse,
  TenderResponse,
} from './contract'
import type { JobStatus } from './poll'

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

/** The Radar's own URL for a tender. A catch-all route, so the slash survives. */
export function tenderHref(id: string): string {
  return `/radar/edital/${tenderPath(id)}`
}

/**
 * `/radar?cnpj=…&uf=…&q=…&group=…`, with the empty parameters left out and the
 * default group left implicit.
 *
 * Here rather than in the Radar's own files because the Landing form builds it
 * too, and the Landing must not pull the whole Radar view into its bundle.
 */
export function radarHref(query: {
  cnpj?: string | null
  state?: string | null
  q?: string | null
  group?: TenderGroup
}): string {
  const params = new URLSearchParams()
  if (query.cnpj) params.set('cnpj', query.cnpj)
  if (query.state) params.set('uf', query.state)
  if (query.q) params.set('q', query.q)
  if (query.group && query.group !== 'compatible') params.set('group', query.group)
  const search = params.toString()
  return search ? `/radar?${search}` : '/radar'
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
