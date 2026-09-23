import type { CompanyView, Freshness, TenderCard, TenderGroup, VisitorView } from './contract'

/**
 * What the Radar remembers about a list it has already shown, so that coming
 * back to it is not the same as searching for it again.
 *
 * ## The failure
 *
 * `RadarScreen` re-ran its whole pipeline on every mount: `data` back to
 * `INITIAL`, status back to `analyzing`, `postCnpj` + `waitForData`, page 1
 * re-fetched. Returning from a tender therefore meant the CNPJ re-analysed,
 * every "Ver mais editais" page thrown away and the scroll position lost.
 * Reproduced on production before this file existed: three pages loaded (60
 * cards), scrolled to 3000 px, open a tender, press Back — 0 cards, scroll 0,
 * "Consultando o CNPJ…". To a user that is indistinguishable from having lost
 * the search, and it can cost a `company_lookup` job for a list they were
 * reading seconds earlier.
 *
 * ## The rule: §3.1, applied to the client
 *
 * The spec's stale-while-revalidate is written for the routes, but the shape is
 * the same one a screen needs — *respond with what we have, refresh behind it*
 * — so the thresholds are the spec's own and not invented here:
 *
 * | age of the snapshot | what happens |
 * |---|---|
 * | `< 60 s` (`REVALIDATE_AFTER_MS`) | restored, and **nothing is requested**: the sweep that owns this data runs every 30 min (§3.2), so a re-read this soon returns the same rows |
 * | `60 s … 30 min` (`RESTORE_TTL_MS`) | restored immediately, then refreshed in the background — no spinner, no state change, the rows update in place |
 * | `> 30 min` | **discarded.** §3.2 gives open tenders a 30-minute TTL; past it our copy is stale by the spec's own definition, and `proposals_close_at > now()` is evaluated in Postgres, not in this tab. A list from yesterday showing closed tenders is exactly what must not happen |
 *
 * ## A Map, mirrored into `sessionStorage`
 *
 * The Map alone would be enough for the browser's Back button, which keeps the
 * JavaScript context. It is not enough for the way back the product actually
 * draws: the Opportunity screen's "Voltar" is a document navigation, so the
 * Map is gone by the time the Radar mounts, and the list would rebuild itself
 * exactly as it did before. `sessionStorage` survives that and dies with the
 * tab, which is the right lifetime for "the list I was just reading" — and
 * §3.3 already expects the last tender list seen to live on the client.
 *
 * The Map stays as the fast path and the source of truth within one context;
 * storage is a mirror, read only when the Map misses. Every access is wrapped:
 * a private window, a full quota or a corrupted entry must cost the freshness
 * of a list, never the screen.
 *
 * ## The server must never see any of this
 *
 * Module state on a serverless function is shared between requests, and every
 * value here is one visitor's data (§3.3: the Radar is user data and never
 * touches a shared cache). So every function below is a no-op outside the
 * browser. That also keeps the first client render identical to the
 * server-rendered HTML: on a fresh document the cache is empty in both places.
 */

/** §3.2: open tenders live 30 minutes. Older than that, we re-read. */
export const RESTORE_TTL_MS = 30 * 60_000

/** Under a minute old, a re-read cannot tell us anything new. */
export const REVALIDATE_AFTER_MS = 60_000

/** Snapshots kept, newest first. Eight covers three tabs and a few filters. */
export const MAX_SNAPSHOTS = 8

/** The states a restored list can be in; the rest are not worth restoring. */
export type SnapshotStatus = 'ready' | 'manualCnae' | 'noSegments'

export type ListSnapshot = {
  /** The group actually on screen — which is not always the one in the URL. */
  group: TenderGroup
  company: CompanyView | null
  visitor: VisitorView | null
  counts: Record<TenderGroup, number> | null
  /** Every page the user had loaded, in the order they were appended. */
  tenders: TenderCard[]
  nextCursor: string | null
  freshness: Freshness | null
  status: SnapshotStatus
  /** `Date.now()` when the list was written. */
  savedAt: number
  /** Where the window was when they left. */
  scrollY: number
}

export type CompanySnapshot = {
  company: CompanyView | null
  visitor: VisitorView | null
  manualCnae: boolean
  savedAt: number
}

export type SnapshotUse = 'fresh' | 'revalidate'

export type RestoredList = { snapshot: ListSnapshot; use: SnapshotUse }

const lists = new Map<string, ListSnapshot>()
const companies = new Map<string, CompanySnapshot>()

function browser(): boolean {
  return typeof window !== 'undefined'
}

/** `sessionStorage` when there is one and it lets us in, otherwise nothing. */
function store(): Storage | null {
  if (!browser()) return null
  try {
    return window.sessionStorage ?? null
  } catch {
    // Safari in private mode, and any browser with storage blocked, throw on
    // the property itself rather than on the call.
    return null
  }
}

const PREFIX = 'licitaqui.radar.list:'

function write(key: string, snapshot: ListSnapshot): void {
  const storage = store()
  if (!storage) return
  try {
    storage.setItem(PREFIX + key, JSON.stringify(snapshot))
  } catch {
    // Out of quota: the Map still has it for this context, which is the
    // common case anyway. Drop the mirror rather than the list.
  }
}

function read(key: string): ListSnapshot | null {
  const storage = store()
  if (!storage) return null
  try {
    const raw = storage.getItem(PREFIX + key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return valid(parsed) ? parsed : null
  } catch {
    return null
  }
}

function erase(key: string): void {
  try {
    store()?.removeItem(PREFIX + key)
  } catch {
    // Nothing to do: an entry we cannot delete is one we will not trust either.
  }
}

/**
 * Storage is written by a previous page load, so what comes back is input, not
 * state: anything whose shape we would render is checked before it is trusted.
 */
function valid(value: unknown): value is ListSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const snapshot = value as Partial<ListSnapshot>
  return (
    Array.isArray(snapshot.tenders) &&
    typeof snapshot.savedAt === 'number' &&
    Number.isFinite(snapshot.savedAt) &&
    typeof snapshot.group === 'string' &&
    (snapshot.status === 'ready' ||
      snapshot.status === 'manualCnae' ||
      snapshot.status === 'noSegments')
  )
}

/**
 * The identity of a list: the four things that change what the route returns.
 *
 * `group` is the *chosen* group, so an unchosen one keys as `auto` — the
 * snapshot then carries whichever group `bestGroup()` elected, and coming back
 * to the same unchosen URL restores that same tab rather than re-deciding it.
 */
export function listKey(query: {
  cnpj: string | null
  state: string | null
  q: string | null
  group: TenderGroup | null
}): string {
  return [query.cnpj ?? '', query.state ?? '', query.q ?? '', query.group ?? 'auto'].join('\u0000')
}

function evict(): void {
  while (lists.size > MAX_SNAPSHOTS) {
    const oldest = lists.keys().next()
    if (oldest.done) return
    lists.delete(oldest.value)
    erase(oldest.value)
  }
}

export function saveList(key: string, snapshot: ListSnapshot): void {
  if (!browser()) return
  // Delete first so re-insertion moves the key to the end: `Map` iterates in
  // insertion order, which is what makes `evict()` drop the least recent.
  lists.delete(key)
  lists.set(key, snapshot)
  evict()
  write(key, snapshot)
}

/**
 * The snapshot for `key`, and what may be done with it. `null` when there is
 * none or it is past `RESTORE_TTL_MS` — an expired one is dropped rather than
 * left to be found again.
 */
export function readList(key: string, now: number = Date.now()): RestoredList | null {
  if (!browser()) return null
  // The Map first, then the mirror: after a document navigation — which is
  // what the Opportunity screen's "Voltar" is — the Map is empty and storage
  // is the only place the list still exists.
  const snapshot = lists.get(key) ?? read(key)
  if (!snapshot) return null

  const age = now - snapshot.savedAt
  // A clock that moved backwards (a laptop waking up) reads as "from the
  // future": treat it as unusable rather than as infinitely fresh.
  if (age < 0 || age > RESTORE_TTL_MS) {
    forgetList(key)
    return null
  }
  if (!lists.has(key)) {
    lists.set(key, snapshot)
    evict()
  }
  return { snapshot, use: age < REVALIDATE_AFTER_MS ? 'fresh' : 'revalidate' }
}

export type ListQuery = {
  cnpj: string | null
  state: string | null
  q: string | null
  group: TenderGroup | null
}

/**
 * The snapshot for a query — allowing for the one way the key can legitimately
 * differ from the one it was saved under.
 *
 * A list searched without a tab (`/radar?cnpj=…`) is saved under `auto`. The
 * Opportunity screen builds its "Voltar" out of the parameters it was given
 * and always spells the group out, so coming back lands on
 * `/radar?cnpj=…&group=compatible` — a different key for the very same list,
 * and the restore would miss on the exact journey it exists for.
 *
 * So a chosen group also looks at the unchosen key, and accepts what it finds
 * **only when that snapshot is of the same group**. Nothing is guessed: a
 * snapshot of Palavras is never handed to someone who asked for Compatíveis.
 *
 * ## The direct hit is checked too, and did not used to be
 *
 * The same sentence has to hold for a key that matched exactly, and for a
 * while it did not: a direct hit was a key match, and a key match was trusted.
 * On 2026-09-23 that turned a stale write in `radar-screen.tsx` — the
 * Compatíveis list stamped under the Verificar key by a navigation that had
 * not loaded yet — into a list served under another tab's name, with no
 * request and no way for the screen to notice.
 *
 * That write is fixed where it was made; this is the second lock on the same
 * door, and it is the cheaper of the two to be sure of. A snapshot whose
 * `group` disagrees with the group asked for is not this list, whatever key it
 * was filed under. Refusing it costs one request and heals the entry, because
 * what the screen loads next is written back over it.
 *
 * It only guards the group. A snapshot filed under the wrong UF or the wrong
 * keyword is indistinguishable from a right one here — `ListSnapshot` does not
 * carry the filters it was read with — which is why the guard in the writing
 * effect is the fix and this is the defence in depth, not the other way round.
 */
export function restoreList(query: ListQuery, now: number = Date.now()): RestoredList | null {
  const direct = readList(listKey(query), now)
  if (direct) {
    if (query.group === null || direct.snapshot.group === query.group) return direct
    return null
  }
  if (query.group === null) return null
  const auto = readList(listKey({ ...query, group: null }), now)
  return auto && auto.snapshot.group === query.group ? auto : null
}

export function forgetList(key: string): void {
  lists.delete(key)
  erase(key)
}

/** Where the window was, recorded without rewriting the whole snapshot. */
export function rememberScroll(key: string, scrollY: number): void {
  if (!browser()) return
  const snapshot = lists.get(key) ?? read(key)
  if (!snapshot) return
  snapshot.scrollY = Math.max(0, Math.round(scrollY))
  lists.set(key, snapshot)
  write(key, snapshot)
}

/**
 * The company half, kept separately and briefly.
 *
 * Separately, because the company does not depend on the tab or the filters:
 * clicking "Verificar" should not re-post the CNPJ. Briefly — one minute —
 * because `visitor` rides along with it, and the number of triagens left
 * changes on another screen. Past the minute the CNPJ is posted again, which
 * costs a Postgres read and no job: `companies` are fresh for 30 days (§3.2),
 * so nothing is re-analysed.
 */
export function saveCompany(cnpj: string, snapshot: CompanySnapshot): void {
  if (!browser()) return
  companies.set(cnpj, snapshot)
}

export function readCompany(cnpj: string, now: number = Date.now()): CompanySnapshot | null {
  if (!browser()) return null
  const snapshot = companies.get(cnpj)
  if (!snapshot) return null
  const age = now - snapshot.savedAt
  if (age < 0 || age >= REVALIDATE_AFTER_MS) {
    companies.delete(cnpj)
    return null
  }
  return snapshot
}

/**
 * The background refresh, applied.
 *
 * Page 1 comes back; the rows already on screen are replaced by their newer
 * copy **in place**, and nothing else moves. Order, length and scroll position
 * are the user's place in the list, and a refresh they did not ask for must not
 * take it: a tender that has appeared since is not inserted (they will see it
 * on the next search), and one that has closed is not removed — it keeps its
 * card, which prints "encerrado" from its own `proposals_close_at`.
 *
 * Only the first page is refreshed, because that is the one page we can ask
 * for in one request; rows further down keep the values they were loaded with
 * and the "atualizado há X" line above the list states their age.
 */
export function refreshTenders(current: TenderCard[], incoming: TenderCard[]): TenderCard[] {
  if (incoming.length === 0 || current.length === 0) return current
  const fresh = new Map(incoming.map((tender) => [tender.id, tender]))
  let changed = false
  const merged = current.map((tender) => {
    const update = fresh.get(tender.id)
    if (!update || update === tender) return tender
    changed = true
    return update
  })
  return changed ? merged : current
}

/** Tests only: the Map outlives a test file otherwise. */
export function clearSnapshots(): void {
  for (const key of lists.keys()) erase(key)
  lists.clear()
  companies.clear()
}
