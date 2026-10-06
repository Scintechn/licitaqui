'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  getJobStatus,
  getTenders,
  ME_EPP_PARAM,
  MODALITY_PARAM,
  postCnpj,
} from '@/lib/radar/client'
import type {
  CnpjResponse,
  CompanyView,
  Freshness,
  TenderCard,
  TenderGroup,
  TenderListResponse,
  VisitorView,
} from '@/lib/radar/contract'
import { apiErrorText, NETWORK_ERROR } from '@/lib/radar/error-text'
import { readMeEpp, readModality } from '@/lib/radar/filters'
import { bestGroup, readGroup } from '@/lib/radar/group'
import { readSort } from '@/lib/radar/sort'
import {
  forgetList,
  listKey,
  readCompany,
  refreshFavourites,
  refreshTenders,
  rememberScroll,
  restoreList,
  saveCompany,
  saveList,
  withFavourite,
  type ListSnapshot,
  type SnapshotStatus,
} from '@/lib/radar/list-cache'
import { appendTenders } from '@/lib/radar/pagination'
import { waitForData } from '@/lib/radar/poll'
import { useAppMenu } from '@/components/app-shell'
import { RadarView, type RadarQuery, type RadarStatus } from './radar-view'

/** The drawer's accessible name lives on the menu's own hidden heading. */
import { normaliseUf } from '@/lib/radar/ufs'

/**
 * The Radar's only stateful part: read the URL, talk to the three routes of
 * §8, and hand `RadarView` a view model.
 *
 * ## Two reads, in this order
 *
 * 1. `POST /api/radar/cnpj` — identifies the device and resolves the company.
 *    The first time anyone searches a CNPJ this answers `202` with a job
 *    (§3.1 step 4), which is what `waitForData` waits on: three seconds a
 *    tick, sixty seconds at most, polling `GET /api/jobs/:id` rather than
 *    hammering the read.
 * 2. `GET /api/radar/tenders` — the list. It never answers "analyzing": the
 *    30-minute sweep owns that data and the route reports its age instead
 *    (`listFreshness`), so a stale list is served and labelled, never hidden.
 *
 * A third read exists and is not part of that sequence: `onLoadMore` asks the
 * same list route for the next keyset page and **appends** it. It is deliberately
 * not in the effect — pressing "Ver mais editais" must not re-post the CNPJ, and
 * the cursor must not enter the URL, because `/radar?cursor=…` would be a
 * shareable address that opens on page 3 with pages 1 and 2 missing.
 *
 * ## …and a fourth that is none of the above: coming back
 *
 * Everything above describes *searching*. Returning to a list you were reading
 * a minute ago is a different act, and running the sequence again for it is the
 * bug `lib/radar/list-cache.ts` documents: it threw away every loaded page, the
 * scroll position and the analysed company, and looked to the user exactly like
 * losing the search. So a mount now starts by asking the cache, and only falls
 * through to the sequence when there is nothing to restore. §3.1 is the model:
 * show what we have, refresh behind it.
 *
 * ## Which tab it opens on
 *
 * `?group=` absent means *unchosen*, not "compatible" (`lib/radar/group.ts`).
 * The list route counts all three groups under the same filters whichever one
 * it is asked for, so the first answer is enough to elect a populated tab and
 * ask for it. A group the user actually clicked is never second-guessed.
 *
 * ## Why the CNPJ is posted here and not on the Landing
 *
 * It is one round trip either way, and putting it here means the "analyzing"
 * state has a screen to live on — the Radar, with its heading, tabs and state
 * card — instead of a button that spins on a page the user is about to leave.
 * It also makes `/radar?cnpj=…` a real, shareable, reloadable address.
 */

const EMPTY_COUNTS = null

type Data = {
  company: CompanyView | null
  visitor: VisitorView | null
  counts: Record<TenderGroup, number> | null
  tenders: TenderCard[]
  /**
   * The ids of `tenders` this reader has marked — D23's stars.
   *
   * Here, and not inside each star, because the set has to outlive the cards:
   * the snapshot carries it (`list-cache.ts`), so pressing Back restores the
   * list *with* its stars, and a mark made on page 3 is still a mark after a
   * background refresh of page 1.
   */
  favourites: string[]
  /** The tab on screen: the chosen one, or the one `bestGroup()` elected. */
  group: TenderGroup
  /** From the envelope. `null` is the end of the list. */
  nextCursor: string | null
  /**
   * A "Ver mais editais" page is in flight. Part of `Data` rather than its own
   * `useState` so that every reset of the list resets it in the same update —
   * a separate flag would have to be cleared from inside the effect body,
   * which is a synchronous setState and a cascading render.
   */
  loadingMore: boolean
  freshness: Freshness | null
  status: RadarStatus
  /**
   * When these rows were read from the route — not when they were last
   * rendered. Restoring a snapshot carries its original timestamp forward, so
   * a list that keeps being restored still expires thirty minutes after it was
   * fetched instead of renewing its own lease every time it is shown.
   */
  readAt: number
  /**
   * The `listKey` these rows were read **for**, carried in the state rather
   * than derived from the URL at the point of use.
   *
   * The two disagree for exactly one render, and that render is the whole of
   * the 2026-09-23 defect: a client-side navigation re-renders with the new
   * `key` while `data` is still the list read for the previous one. Anything
   * that writes to the cache has to be able to tell that render apart from a
   * settled one, and the URL alone cannot — by then it is already the new
   * search.
   */
  key: string
}

/**
 * Nothing read yet. The key is `''`, which `listKey` can never produce — it
 * always joins its fields with a NUL separator — so this state matches no
 * search and is never written to the cache.
 */
const INITIAL: Data = {
  company: null,
  visitor: null,
  counts: EMPTY_COUNTS,
  tenders: [],
  favourites: [],
  group: 'compatible',
  nextCursor: null,
  loadingMore: false,
  freshness: null,
  status: { kind: 'analyzing', what: 'company' },
  readAt: 0,
  key: '',
}

function aborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/**
 * Restoration runs before the browser paints, so the list is on screen at the
 * scroll position it was left at rather than appearing after a frame of
 * spinner. `useLayoutEffect` does not exist on the server — this page is
 * `force-dynamic` and is server-rendered — so the effect that scrolls is
 * chosen once, per environment, which keeps the hook order constant.
 */
const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect

const STATUS_FROM_SNAPSHOT: Record<SnapshotStatus, RadarStatus> = {
  ready: { kind: 'ready' },
  manualCnae: { kind: 'manualCnae' },
  noSegments: { kind: 'noSegments' },
}

function snapshotStatus(status: RadarStatus): SnapshotStatus | null {
  if (status.kind === 'ready' || status.kind === 'manualCnae' || status.kind === 'noSegments') {
    return status.kind
  }
  return null
}

/**
 * `key` is the key the snapshot was **read for**, which is not always the one
 * it was saved under: `restoreList` matches an `auto` snapshot sideways when
 * the way back spells the group out. Stamping the state with the key now on
 * screen is what lets the next save put it where this URL will look for it.
 */
function fromSnapshot(snapshot: ListSnapshot, key: string): Data {
  return {
    company: snapshot.company,
    visitor: snapshot.visitor,
    counts: snapshot.counts,
    tenders: snapshot.tenders,
    favourites: snapshot.favourites,
    group: snapshot.group,
    nextCursor: snapshot.nextCursor,
    loadingMore: false,
    freshness: snapshot.freshness,
    status: STATUS_FROM_SNAPSHOT[snapshot.status],
    readAt: snapshot.savedAt,
    key,
  }
}

export function RadarScreen() {
  const router = useRouter()
  const params = useSearchParams()
  const [attempt, setAttempt] = useState(0)

  const cnpj = (params.get('cnpj') ?? '').replace(/\D+/g, '') || null
  const state = normaliseUf(params.get('uf'))
  const q = (params.get('q') ?? '').trim() || null
  /**
   * D52's two filters, read here and threaded into **every** read below.
   *
   * They have to reach four places or they do nothing: the list route, the
   * cache key, the snapshot restore and the effect's dependency array. A
   * parameter missing from the last one is a URL that changes and a list that
   * does not — which is how the Radar's whole navigation silently did nothing
   * on 2026-09-23 (see the snapshot-writing effect below).
   */
  const modality = readModality(params.get(MODALITY_PARAM))
  const meEpp = readMeEpp(params.get(ME_EPP_PARAM))
  const chosenGroup = readGroup(params.get('group'))
  // Never `null`: an absent `?sort=` is the deadline order, which is the order
  // this list has always come back in (D51).
  const sort = readSort(params.get('sort'))
  const key = listKey({ cnpj, state, q, modality, meEpp, group: chosenGroup, sort })

  /**
   * The snapshot is read here, in the initializer, and not in the effect: the
   * first render is then already the restored list, so nothing flashes and the
   * scroll can be put back before the paint. It is safe against hydration
   * because the cache only ever holds anything after a client-side navigation,
   * and those mounts have no server-rendered HTML to disagree with.
   */
  const [data, setData] = useState<Data>(() => {
    const restored = restoreList({ cnpj, state, q, modality, meEpp, group: chosenGroup, sort })
    return restored ? fromSnapshot(restored.snapshot, key) : INITIAL
  })

  /**
   * What is on screen, for the effect below to recognise: the rows, and the
   * key they are being shown under.
   *
   * Identity is the whole test on the rows — `fromSnapshot` hands the state
   * the snapshot's own `tenders` array, so "this list is already the snapshot"
   * is one `===` and needs no flag written during render.
   *
   * The key rides along because the same rows under a different key are not
   * the same state. A sideways match (`auto` → an explicit group, which is the
   * address the way back is built from) restores rows that are already on
   * screen under a key nothing was ever saved under; if that is mistaken for
   * "nothing to do", the snapshot is never re-saved where this URL looks for
   * it and `rememberScroll` writes to a key that does not exist — the list
   * comes back on the way back, at the top of the page.
   */
  const shown = useRef<{ key: string; tenders: TenderCard[] }>({
    key: data.key,
    tenders: data.tenders,
  })
  useEffect(() => {
    shown.current = { key: data.key, tenders: data.tenders }
  })

  /**
   * Aborts the page in flight when the filters change under it, so a slow
   * page 4 for `SP` can never append itself to a freshly loaded list for `RJ`.
   * A ref rather than state: nothing renders differently because of it.
   */
  const moreRequest = useRef<AbortController | null>(null)

  /**
   * The tenders whose star this reader has pressed since the list was last read
   * from the route — D23.
   *
   * `revalidate()`'s answer is a picture of the server from the moment its
   * request left, and a star can be pressed while it is in flight: that `POST`
   * confirms a newer fact than the refresh is carrying, so letting the refresh
   * win would empty a star the reader had just filled. `refreshFavourites` takes
   * this set and leaves those ids alone.
   *
   * A ref, because nothing renders differently because of it.
   *
   * **It is emptied where the refresh reads it, not only when the search
   * changes.** With one refresh per search those two are the same moment, and
   * resting on that would make this correct by an accident of structure: a second
   * refresh — a `visibilitychange` refetch, polling, a manual *Atualizar* — and
   * the set becomes a permanent per-search override in which the server can never
   * correct a star the reader has touched, quietly falsifying
   * `refreshFavourites`'s own promise that a tender unmarked in another tab loses
   * its star here too. So `revalidate` takes what is in it and clears it in the
   * same breath, and protects that batch **plus** anything pressed while its own
   * request was open. The reset at the top of the loading effect stays, to bound
   * the set when a search is replaced rather than refreshed.
   */
  const pressed = useRef<Set<string>>(new Set())

  /**
   * Where the window is, kept current by a passive listener rather than read
   * when the screen unmounts: by then the router may already have scrolled the
   * incoming page to the top, and the number we want is the one from before
   * the click.
   */
  const scrollY = useRef(0)
  useEffect(() => {
    const onScroll = () => {
      scrollY.current = window.scrollY
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const query: RadarQuery = {
    cnpj,
    state,
    q,
    modality,
    meEpp,
    group: data.group,
    groupChosen: chosenGroup !== null,
    sort,
  }

  /**
   * The whole view model, written to the cache whenever it is worth keeping.
   * An empty list is not: re-running the two reads for it costs nothing the
   * user can see, and caching "nothing found" would outlive the sweep that is
   * about to find something.
   */
  useEffect(() => {
    /**
     * A snapshot is only ever written under the key it was read for.
     *
     * Without this line the Radar's whole navigation silently did nothing
     * (2026-09-23). A client-side navigation — every chip, every "Aplicar
     * filtros" — re-renders with the new `key` while `data` is still the list
     * read for the old one, and this effect is declared **before** the one
     * that loads, so it ran first and stamped the previous list under the new
     * search's key. `restoreList` then found a direct hit for a search nobody
     * had ever run, returned it, and the loader never asked the route for
     * anything: the address changed, the list did not, and no request left.
     *
     * Ordering the two effects the other way round would also have worked
     * today and would have gone on being a trap, because it would make the
     * correctness of the cache depend on the order two `useEffect` calls
     * happen to be written in. This states the rule instead.
     */
    if (data.key !== key) return
    const status = snapshotStatus(data.status)
    if (!status || data.tenders.length === 0 || data.readAt === 0) return
    saveList(key, {
      group: data.group,
      company: data.company,
      visitor: data.visitor,
      counts: data.counts,
      tenders: data.tenders,
      favourites: data.favourites,
      nextCursor: data.nextCursor,
      freshness: data.freshness,
      status,
      savedAt: data.readAt,
      scrollY: scrollY.current,
    })
  }, [key, data])

  /**
   * Leaving: remember where they were, so coming back can put them there.
   *
   * Twice over, because there are two ways out and only one of them unmounts
   * anything. A tender card is a plain `<a>` — the whole card is one link, one
   * keyboard stop — so opening a tender **unloads the document** and React
   * cleanups never run. `pagehide` is the event that does fire, on desktop and
   * on iOS where `beforeunload` does not.
   */
  useEffect(() => {
    const remember = () => rememberScroll(key, scrollY.current)
    window.addEventListener('pagehide', remember)
    return () => {
      window.removeEventListener('pagehide', remember)
      remember()
    }
  }, [key])

  /**
   * Put the window back where it was, before the first paint. Mount only: an
   * empty `data.tenders` here means nothing was restored, and a later render
   * must never move a scroll position the reader now owns.
   */
  useBeforePaint(() => {
    if (data.tenders.length === 0) return
    const restored = restoreList({ cnpj, state, q, modality, meEpp, group: chosenGroup, sort })
    if (restored && restored.snapshot.scrollY > 0) window.scrollTo(0, restored.snapshot.scrollY)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const signal = controller.signal

    // Whatever was pressed belongs to the list that is about to be replaced.
    pressed.current = new Set()

    // A new query means the previous "Ver mais" is answering a question nobody
    // is asking any more.
    moreRequest.current?.abort()
    moreRequest.current = null

    /**
     * §3.1 behind the screen: the same two reads, with nothing on screen
     * changing state. A failure here is not an error the user has to see —
     * they are looking at a list that works — so everything falls back to
     * keeping what is already rendered.
     */
    async function revalidate(previous: ListSnapshot) {
      let company = previous.company
      let visitor = previous.visitor

      // Taken and cleared together: these are the presses this refresh must not
      // speak for, and leaving them in the live set would make every *later*
      // refresh unable to speak for them either.
      const touchedBefore = pressed.current
      pressed.current = new Set()

      if (cnpj) {
        const answer = await postCnpj(cnpj, signal)
        if (answer.state === 'ready') {
          company = answer.company
          visitor = answer.visitor
          saveCompany(cnpj, {
            company: answer.company,
            visitor: answer.visitor,
            manualCnae: answer.manualCnae,
            savedAt: Date.now(),
          })
        }
        // `analyzing` is not waited on and `error` is not shown: this refresh
        // is not the reason the screen exists.
      }

      const list = await getTenders(
        { group: previous.group, cnpj, state, q, modality, meEpp, sort },
        signal,
      )
      if (signal.aborted) return

      setData((current) => ({
        ...current,
        company,
        visitor,
        ...(list.state === 'ready'
          ? {
              counts: list.counts,
              freshness: list.freshness,
              tenders: refreshTenders(current.tenders, list.tenders),
              // Page 1's answer about page 1's rows, and silence about the
              // pages below it — the same rule `refreshTenders` follows.
              // Pressed before the request left — its `POST` may not have
              // reached the database before this read did — and pressed while it
              // was open. Both are newer than the answer.
              favourites: refreshFavourites(
                current.favourites,
                list.tenders,
                list.favourites,
                new Set([...touchedBefore, ...pressed.current]),
              ),
              readAt: Date.now(),
            }
          : {}),
      }))
    }

    async function load() {
      if (!cnpj && !q) {
        setData({ ...INITIAL, status: { kind: 'needCnpj' } })
        return
      }

      const restored = restoreList({ cnpj, state, q, modality, meEpp, group: chosenGroup, sort })
      if (restored) {
        // The mount initializer may already have rendered this exact snapshot;
        // setting it again would replace an identical view model and re-render
        // for nothing. "Exact" is the rows **and** the key: a sideways match
        // arrives here with the rows already on screen under the key they were
        // saved under rather than the one this URL will look for.
        if (shown.current.tenders !== restored.snapshot.tenders || shown.current.key !== key) {
          setData(fromSnapshot(restored.snapshot, key))
        }
        if (restored.use === 'revalidate') {
          // Its own `catch`: a refresh that fails behind a list which is on
          // screen and working must not turn that screen into an error card.
          await revalidate(restored.snapshot).catch(() => {})
        }
        return
      }

      setData((previous) => ({
        ...previous,
        key,
        tenders: [],
        favourites: [],
        nextCursor: null,
        loadingMore: false,
        status: { kind: 'analyzing', what: cnpj ? 'company' : 'list' },
      }))

      let company: CompanyView | null = null
      let visitor: VisitorView | null = null
      let manualCnae = false

      if (cnpj) {
        const cached = readCompany(cnpj)
        if (cached) {
          company = cached.company
          visitor = cached.visitor
          manualCnae = cached.manualCnae
        } else {
          const { value, timedOut } = await waitForData<CnpjResponse>({
            read: () => postCnpj(cnpj, signal),
            analyzing: (answer) => (answer.state === 'analyzing' ? answer.job : null),
            pollJob: (id) => getJobStatus(id, signal),
            signal,
          })

          if (value.state === 'error') {
            setData({
              ...INITIAL,
              status: { kind: 'error', code: value.error, text: apiErrorText(value) },
            })
            return
          }
          if (timedOut || value.state === 'analyzing') {
            setData({ ...INITIAL, status: { kind: 'timeout' } })
            return
          }
          company = value.company
          visitor = value.visitor
          manualCnae = value.manualCnae
          saveCompany(cnpj, { company, visitor, manualCnae, savedAt: Date.now() })
        }
      }

      setData((previous) => ({
        ...previous,
        company,
        visitor,
        status: { kind: 'analyzing', what: 'list' },
      }))

      // An unchosen tab is asked for as `compatible`, because the counts come
      // back whichever group is requested and `compatible` is the one the
      // answer usually belongs to.
      const asked = chosenGroup ?? 'compatible'
      let answer: TenderListResponse = await getTenders(
        { group: asked, cnpj, state, q, modality, meEpp, sort },
        signal,
      )
      let group = asked

      if (answer.state === 'ready' && chosenGroup === null) {
        const best = bestGroup(answer.counts)
        if (best !== asked) {
          // The one extra request this costs happens only in the case that was
          // broken before it: nothing in the tab we would have opened on.
          const second = await getTenders({ group: best, cnpj, state, q, modality, meEpp, sort }, signal)
          if (second.state === 'ready') {
            answer = second
            group = best
          }
        }
      }

      if (answer.state === 'error') {
        setData((previous) => ({
          ...previous,
          tenders: [],
          favourites: [],
          group,
          status: { kind: 'error', code: answer.error, text: apiErrorText(answer) },
        }))
        return
      }
      if (answer.state === 'analyzing') {
        setData((previous) => ({
          ...previous,
          tenders: [],
          favourites: [],
          group,
          status: { kind: 'timeout' },
        }))
        return
      }

      // The two honest "we could not match you" outcomes, both of which the
      // list route reports as a perfectly successful empty page. They only
      // apply when the CNPJ is what we searched by: with a keyword, the words
      // found what the CNAEs could not, and that is a normal result.
      const status: RadarStatus = manualCnae
        ? { kind: 'manualCnae' }
        : company && company.segments.length === 0 && !q
          ? { kind: 'noSegments' }
          : { kind: 'ready' }

      setData({
        company,
        visitor,
        counts: answer.counts,
        tenders: answer.tenders,
        favourites: answer.favourites,
        group,
        nextCursor: answer.nextCursor,
        loadingMore: false,
        freshness: answer.freshness,
        status,
        readAt: Date.now(),
        key,
      })
    }

    load().catch((error: unknown) => {
      if (aborted(error) || signal.aborted) return
      setData({ ...INITIAL, status: { kind: 'error', code: 'server_error', text: NETWORK_ERROR } })
    })

    return () => {
      controller.abort()
      moreRequest.current?.abort()
    }
  }, [cnpj, state, q, modality, meEpp, chosenGroup, sort, key, attempt])

  /**
   * "Ver mais editais" — the next keyset page, appended.
   *
   * Everything below the button already existed: the cursor in `tenders.ts`,
   * `nextCursor` in the envelope, `?cursor=` in `tendersUrl`. What this adds is
   * the one rule the list route cannot enforce — that a second page is *added*
   * to the first rather than replacing it.
   *
   * `counts` is deliberately not touched: it is the total under these filters
   * and paging does not change it. A failed page leaves the button exactly as
   * it was, so pressing it again is the retry; a Radar that has 59 unreachable
   * tenders must not also lose the 20 it has when the network blinks.
   */
  const onLoadMore = useCallback(() => {
    const cursor = data.nextCursor
    if (!cursor || data.loadingMore) return

    const controller = new AbortController()
    moreRequest.current = controller
    setData((previous) => ({ ...previous, loadingMore: true }))

    const settle = () => {
      if (moreRequest.current === controller) moreRequest.current = null
    }

    getTenders(
      { group: data.group, cnpj, state, q, modality, meEpp, sort, cursor },
      controller.signal,
    )
      .then((answer) => {
        settle()
        if (controller.signal.aborted) return
        setData((previous) =>
          answer.state === 'ready'
            ? {
                ...previous,
                tenders: appendTenders(previous.tenders, answer.tenders),
                // The new page's marked ids join the set. `appendTenders`
                // de-duplicates the rows; this de-duplicates the ids, because a
                // page boundary can repeat a tender when the sweep inserts one.
                favourites: refreshFavourites(
                  previous.favourites,
                  answer.tenders,
                  answer.favourites,
                ),
                nextCursor: answer.nextCursor,
                loadingMore: false,
              }
            : { ...previous, loadingMore: false },
        )
      })
      .catch(() => {
        settle()
        if (controller.signal.aborted) return
        setData((previous) => ({ ...previous, loadingMore: false }))
      })
  }, [data.nextCursor, data.loadingMore, data.group, cnpj, state, q, modality, meEpp, sort])

  const onNavigate = useCallback(
    (href: string) => {
      rememberScroll(key, scrollY.current)
      router.push(href, { scroll: false })
    },
    [router, key],
  )

  /**
   * The drawer, its state and its summary all moved to `AppShell` (D20).
   *
   * This screen used to own them, which is exactly why `/conta` had no menu
   * at all: the navigation was a detail of one screen rather than of the
   * application. It also fetched `/api/conta/resumo` on every open — correct
   * for a drawer that only exists while open, and wrong for a rail that is the
   * first thing painted, so the layout now reads it on the server.
   *
   * What is left here is the trigger, and it is `undefined` outside a shell:
   * the Landing renders `RadarView` in an example panel with no shell around
   * it, and `radar-view.tsx` already declines to draw a button that opens
   * nothing.
   */
  const menu = useAppMenu()

  const onRetry = useCallback(() => {
    forgetList(key)
    setAttempt((value) => value + 1)
  }, [key])

  /**
   * D23's stars. The view wants a `Set` — it asks once per card — and the state
   * holds an array, because that is what `sessionStorage` can carry.
   */
  const favourites = useMemo(() => new Set(data.favourites), [data.favourites])

  /**
   * One card's star changed, and this is the only writer of `data.favourites`.
   *
   * `FavouriteStar` calls it twice per press: optimistically, then with what the
   * route said. `withFavourite` returns the same array when the two agree, so the
   * second call costs no render and no re-write of the snapshot — and the save
   * effect below picks the change up on its own, which is why the snapshot keeps
   * the mark across a Back without anything here mentioning storage.
   */
  const onFavourite = useCallback((tenderId: string, marked: boolean) => {
    // Recorded before the state changes, so a refresh already in flight cannot
    // speak for this tender any more.
    pressed.current.add(tenderId)
    setData((previous) => {
      // `previous.tenders` is the fourth argument because a `POST` can resolve
      // after the reader has moved to another search: `withFavourite` drops an id
      // no card on screen can match, rather than filing it under a list it has
      // nothing to do with.
      const next = withFavourite(previous.favourites, tenderId, marked, previous.tenders)
      return next === previous.favourites ? previous : { ...previous, favourites: next }
    })
  }, [])

  return (
    <>
    <RadarView
      query={query}
      status={data.status}
      company={data.company}
      visitor={data.visitor}
      counts={data.counts}
      tenders={data.tenders}
      favourites={favourites}
      onFavourite={onFavourite}
      nextCursor={data.nextCursor}
      loadingMore={data.loadingMore}
      freshness={data.freshness}
      onNavigate={onNavigate}
      onRetry={onRetry}
      onLoadMore={onLoadMore}
      onOpenMenu={menu?.open}
    />
    </>
  )
}
