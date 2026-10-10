import { DEFAULT_SORT } from './contract'
import type {
  CompanyView,
  Freshness,
  GroupedBy,
  TenderCard,
  TenderGroup,
  TenderSort,
  VisitorView,
} from './contract'
import type { MeEppFilter, ModalityFilter } from './filters'

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
/**
 * `cnpjNotFound` is `manualCnae` with both sources answering 404 — kept apart
 * because the two draw different sentences, and a restore must draw the one
 * the reader was shown.
 */
export type SnapshotStatus = 'ready' | 'manualCnae' | 'cnpjNotFound' | 'noSegments'

export type ListSnapshot = {
  /** The group actually on screen — which is not always the one in the URL. */
  group: TenderGroup
  /**
   * The company the list route said it grouped by (D19) — not the one the CNPJ
   * post resolved, which is cached separately below. Restoring a list restores
   * the header that belongs to it, so coming back cannot resurrect the
   * mismatched pair.
   */
  grouping: GroupedBy | null
  visitor: VisitorView | null
  counts: Record<TenderGroup, number> | null
  /** Every page the user had loaded, in the order they were appended. */
  tenders: TenderCard[]
  /**
   * The ids of `tenders` this reader has marked — D23's stars on the cards.
   *
   * Part of the snapshot and not derived on restore, because the whole point of
   * a snapshot is that coming back asks for nothing: inside
   * `REVALIDATE_AFTER_MS` the list is restored and **no request is made at
   * all**, so a set rebuilt from the network would be rebuilt from nothing and
   * every star would come back empty. It also has to survive a mark made after
   * the list was read, which no re-read of the envelope would know about until
   * it happened.
   *
   * Ids rather than a `Set`, because this is `JSON.stringify`d into
   * `sessionStorage` and a `Set` serialises to `{}`.
   */
  favourites: string[]
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
  /** See `CnpjOk.cnpjNotFound`. */
  cnpjNotFound: boolean
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
 *
 * **`favourites` is checked, which discards snapshots written before D23's
 * second half.** That is deliberate: an entry from the previous deploy has no
 * marked ids, so restoring it would draw a list of empty stars over tenders the
 * reader had marked — the exact failure the field exists to prevent, wearing the
 * previous version's clothes. Refusing it costs one request and heals the entry,
 * which is what every other branch here does too.
 */
function valid(value: unknown): value is ListSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const snapshot = value as Partial<ListSnapshot>
  return (
    Array.isArray(snapshot.tenders) &&
    Array.isArray(snapshot.favourites) &&
    typeof snapshot.savedAt === 'number' &&
    Number.isFinite(snapshot.savedAt) &&
    typeof snapshot.group === 'string' &&
    /**
     * The **key**, not the value: `grouping: null` is a legitimate snapshot (a
     * keyword search with no company) and `JSON.stringify` keeps the key for it,
     * while a snapshot written before D19 has no such key at all.
     *
     * Without this line the deploy itself re-creates the defect D19 fixes. An
     * entry written by the previous build carries `company` and no `grouping`;
     * it passes every other test here, restores with `status: 'ready'` and its
     * counts intact, and the screen draws *"Sem empresa informada"* and
     * *"sem CNAE lido para comparar"* above "Compatíveis 13" — with the
     * company's name lost. Inside `REVALIDATE_AFTER_MS` the restore is `fresh`
     * and **no request is made**, so nothing corrects it for that viewing.
     * Rejecting the entry costs one list request and is the whole fix.
     */
    'grouping' in snapshot &&
    (snapshot.status === 'ready' ||
      snapshot.status === 'manualCnae' ||
      snapshot.status === 'cnpjNotFound' ||
      snapshot.status === 'noSegments')
  )
}

/**
 * The identity of a list: every thing that changes what the route returns.
 *
 * `group` is the *chosen* group, so an unchosen one keys as `auto` — the
 * snapshot then carries whichever group `bestGroup()` elected, and coming back
 * to the same unchosen URL restores that same tab rather than re-deciding it.
 *
 * **The order is part of the identity (D51).** The same CNPJ, UF, keyword and
 * tab under *maior valor* is a different list of rows, so without it pressing
 * Back after changing the order would restore the list sorted the other way
 * under the key this URL asks for — and `nextCursor` with it, which is a cursor
 * cut from the wrong key. Absent keys as `DEFAULT_SORT` rather than as its own
 * token, because absent *is* that order everywhere else.
 *
 * **Every filter belongs here too, and D52's two are why this sentence exists.**
 * A parameter the route reads and this key does not is a list restored under
 * another list's name: `?modality=dispensa` and no modality at all would share
 * a key, so pressing Back after changing the filter would hand the reader the
 * other filter's rows, with no request and nothing on screen to say so. The
 * same failure the group guard in `restoreList` was written for, except that
 * `ListSnapshot` carries no filters, so there is no second lock here — only
 * this one.
 *
 * ## `scope` is not a parameter, and it is first (D58, D60)
 *
 * The six fields below are the *search*. `scope` is the **caller**, and two
 * things the route answers are facts about them rather than about the search:
 * `favourites` belongs to a viewer (D23), and `groupedBy`, `counts` and which
 * tab each row lands in come from `?cnpj= ?? visitors.cnpj` — a column behind
 * an `httpOnly` cookie, which D19 kept out of `GroupedBy` so that no identifier
 * reaches `sessionStorage` (§12). Both were therefore outside this key, and the
 * sentence above about "a list restored under another list's name" was true of
 * them too: bare `/radar` had a key that constrained *nothing*, and D55 could
 * only switch the cache off for it.
 *
 * `lib/radar/scope.ts` builds it — an opaque digest of the request's cookies,
 * computed by the server on every render of `/radar` and handed to the screen,
 * because the restore happens before the first request and so can never wait
 * for one.
 *
 * **In the key rather than checked after the hit**, which is what closes D55's
 * documented dead end. A snapshot of another caller's list is not *rejected*
 * here, it is **never found** — so `revalidate` has nothing to merge page 1 by
 * id into, which is what D19's own fix recreated when D55's first attempt tried
 * to make the restore revalidate instead. It also means two callers' lists
 * coexist, so signing out and back in — or working two clients in one
 * afternoon — restores each list rather than each overwriting the other's entry.
 *
 * **That holds while the scope the client holds is current, and it is a prop:**
 * `app/radar/page.tsx` computes it per render, and Next reuses a page segment on
 * a browser back/forward without re-rendering it. So a changed caller *can*
 * reach a hit — see `regrouped` below, which is the guard for the answer when
 * one arrives, and **D70** for the half no guard can reach (inside
 * `REVALIDATE_AFTER_MS` nothing is requested, so there is nothing to compare).
 */
export function listKey(query: {
  /**
   * `lib/radar/scope.ts`. `''` has exactly one caller — `radar-view.tsx`, which
   * wants this string as a React identity for the favourite notices and not as
   * a cache key; nothing is ever stored under it.
   */
  scope: string
  cnpj: string | null
  /** Canonical UFs (`canonicalUfs`); empty is every state. */
  states: readonly string[]
  q: string | null
  modality?: ModalityFilter | null
  meEpp?: MeEppFilter | null
  group: TenderGroup | null
  sort?: TenderSort | null
}): string {
  return [
    query.scope,
    query.cnpj ?? '',
    // Joined in canonical order, so ticking RJ then SP and SP then RJ is one
    // key. One UF joins to exactly what the single-UF key used to hold, so
    // snapshots written before multi-UF are still found under their key.
    query.states.join(','),
    query.q ?? '',
    query.modality ?? '',
    query.meEpp ?? '',
    query.group ?? 'auto',
    query.sort ?? DEFAULT_SORT,
  ].join('\u0000')
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
  /** The caller, opaquely — see `listKey`. */
  scope: string
  cnpj: string | null
  /** Canonical UFs (`canonicalUfs`); empty is every state. */
  states: readonly string[]
  q: string | null
  modality?: ModalityFilter | null
  meEpp?: MeEppFilter | null
  group: TenderGroup | null
  /** Optional, and absent means `DEFAULT_SORT` — see `listKey`. */
  sort?: TenderSort | null
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
 * **Is the list that just came back a different company's?** — D70's guard, and
 * the one half of D70 that can be closed without a contract change.
 *
 * `scope` keeps another caller's snapshot from being *found* (see `listKey`), and
 * that is airtight **only while the scope the client holds is current**. It is a
 * prop, computed by `app/radar/page.tsx`, so it is as fresh as the last render of
 * that server component — and Next reuses a page segment on a browser
 * back/forward without re-rendering it (its own glossary: *"Pages are not cached
 * by default but are reused during browser back/forward navigation"*). So: search
 * company B in the same tab, press **Back**, and the restored `/radar` carries the
 * scope of company A while the route now resolves B.
 *
 * Past `REVALIDATE_AFTER_MS` that produced the worst available outcome.
 * `refreshTenders` merges page 1 **by id**; B's ids match none of A's rows, so
 * nothing merged and A's rows stayed — under B's header and B's counts. That is
 * D19 exactly: the header saying one company over another company's editais, and
 * it is the dead end D55 recorded.
 *
 * This is what the caller asks before merging. When it answers `true` the
 * refresh is not a refresh of this list at all and the whole list is replaced,
 * which is the same rule `restoreList` already applies to the **group**: a
 * snapshot that disagrees with the answer is not this list, whatever key it was
 * filed under.
 *
 * **Compared on what the header renders**, not on a CNPJ — there is no CNPJ here
 * to compare, by design (§12, and `GroupedCompany` exists for that reason). A
 * company re-read from BrasilAPI could legitimately change its `legalName` or its
 * `cnaeCount` between two reads and be reported as regrouped, which costs one
 * full replace and the document's caching. That is the safe direction: the cost
 * of a false `true` is a list the reader already has, re-drawn; the cost of a
 * false `false` is D19.
 *
 * It does **not** close the other half of D70. Inside `REVALIDATE_AFTER_MS` the
 * restore makes no request at all, so there is no answer to compare and nothing
 * here can run. Only a scope the client can read at decision time fixes that.
 */
export function regrouped(previous: GroupedBy | null, incoming: GroupedBy | null): boolean {
  if (previous === null || incoming === null) return previous !== incoming
  if ((previous.company === null) !== (incoming.company === null)) return true
  if (previous.cnaeCount !== incoming.cnaeCount) return true
  return previous.company?.legalName !== incoming.company?.legalName
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

/**
 * The same background refresh, applied to D23's stars.
 *
 * A refresh asks for **page 1** and comes back with page 1's marked ids. Simply
 * taking that array would empty every star below the first page, because those
 * tenders were not in the answer — and after three "Ver mais editais" that is
 * most of the list. So the rule is the one `refreshTenders` already follows: the
 * route is authoritative about the rows it returned, and silent about the rest.
 *
 * `refreshed` are the ids the refresh *asked about* (page 1's tenders) and
 * `marked` the subset it says are marked. For an id in `refreshed` the answer
 * replaces what we had, in both directions — a tender unmarked in another tab
 * loses its star here too. For an id outside it, what we had stands.
 *
 * **`pressed` is the third case, and it is a race rather than a page boundary.**
 * The answer is a picture of the server from the moment its request left, and a
 * reader can press a star while it is in flight: their `POST` then confirms a
 * newer fact than the refresh is carrying, and taking the refresh's word for it
 * would empty a star they had just filled. So an id they have touched since the
 * request went out is theirs, not the refresh's — the one direction in which
 * "the server is authoritative" is the wrong rule.
 */
export function refreshFavourites(
  current: string[],
  refreshed: TenderCard[],
  marked: string[],
  pressed: ReadonlySet<string> = new Set(),
): string[] {
  if (refreshed.length === 0) return current
  const asked = new Set(refreshed.map((tender) => tender.id))
  /** Ids this answer may speak for: on the page it read, and untouched since. */
  const theirs = (id: string) => asked.has(id) && !pressed.has(id)
  const kept = current.filter((id) => !theirs(id))
  const next = [...kept, ...marked.filter(theirs)]
  // Identity matters: `RadarScreen` keeps this in state and a new array every
  // revalidation would re-save the snapshot and rebuild the `Set` for nothing.
  return same(current, next) ? current : next
}

/** Set equality, for arrays whose order carries no meaning. */
function same(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const left = new Set(a)
  return b.every((id) => left.has(id))
}

/**
 * One tender's mark, flipped — what the star on a card calls.
 *
 * Returns the same array when nothing changes, so a second report of a state we
 * already hold (the optimistic update, then the route agreeing with it) does not
 * re-render the list or re-write the snapshot.
 *
 * **`onScreen` is a filter, not a formality.** A `POST` can resolve after the
 * reader has moved to another search, and its answer would otherwise write an id
 * into *that* list's set — where no card can match it, nothing will ever ask
 * about it again, and the save effect puts it in `sessionStorage` for the life of
 * the tab. It belongs here rather than in the caller because this is the only
 * place that can be asserted: `RadarScreen`'s handler is not exported, and the
 * stray id has no visible effect for a browser test to look at.
 */
export function withFavourite(
  current: string[],
  tenderId: string,
  marked: boolean,
  onScreen: TenderCard[],
): string[] {
  if (!onScreen.some((tender) => tender.id === tenderId)) return current
  const has = current.includes(tenderId)
  if (has === marked) return current
  return marked ? [...current, tenderId] : current.filter((id) => id !== tenderId)
}

/** Tests only: the Map outlives a test file otherwise. */
export function clearSnapshots(): void {
  for (const key of lists.keys()) erase(key)
  lists.clear()
  companies.clear()
}
