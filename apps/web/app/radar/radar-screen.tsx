'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { getJobStatus, getTenders, postCnpj } from '@/lib/radar/client'
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
import { bestGroup, readGroup } from '@/lib/radar/group'
import {
  forgetList,
  listKey,
  readCompany,
  refreshTenders,
  rememberScroll,
  restoreList,
  saveCompany,
  saveList,
  type ListSnapshot,
  type SnapshotStatus,
} from '@/lib/radar/list-cache'
import { appendTenders } from '@/lib/radar/pagination'
import { waitForData } from '@/lib/radar/poll'
import { RadarView, type RadarQuery, type RadarStatus } from './radar-view'
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
}

const INITIAL: Data = {
  company: null,
  visitor: null,
  counts: EMPTY_COUNTS,
  tenders: [],
  group: 'compatible',
  nextCursor: null,
  loadingMore: false,
  freshness: null,
  status: { kind: 'analyzing', what: 'company' },
  readAt: 0,
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

function fromSnapshot(snapshot: ListSnapshot): Data {
  return {
    company: snapshot.company,
    visitor: snapshot.visitor,
    counts: snapshot.counts,
    tenders: snapshot.tenders,
    group: snapshot.group,
    nextCursor: snapshot.nextCursor,
    loadingMore: false,
    freshness: snapshot.freshness,
    status: STATUS_FROM_SNAPSHOT[snapshot.status],
    readAt: snapshot.savedAt,
  }
}

export function RadarScreen() {
  const router = useRouter()
  const params = useSearchParams()
  const [attempt, setAttempt] = useState(0)

  const cnpj = (params.get('cnpj') ?? '').replace(/\D+/g, '') || null
  const state = normaliseUf(params.get('uf'))
  const q = (params.get('q') ?? '').trim() || null
  const chosenGroup = readGroup(params.get('group'))
  const key = listKey({ cnpj, state, q, group: chosenGroup })

  /**
   * The snapshot is read here, in the initializer, and not in the effect: the
   * first render is then already the restored list, so nothing flashes and the
   * scroll can be put back before the paint. It is safe against hydration
   * because the cache only ever holds anything after a client-side navigation,
   * and those mounts have no server-rendered HTML to disagree with.
   */
  const [data, setData] = useState<Data>(() => {
    const restored = restoreList({ cnpj, state, q, group: chosenGroup })
    return restored ? fromSnapshot(restored.snapshot) : INITIAL
  })

  /**
   * The rows on screen, for the effect below to recognise. Identity is the
   * whole test: `fromSnapshot` hands the state the snapshot's own `tenders`
   * array, so "this list is already the snapshot" is one `===` and needs no
   * flag written during render.
   */
  const shown = useRef<TenderCard[]>(data.tenders)
  useEffect(() => {
    shown.current = data.tenders
  })

  /**
   * Aborts the page in flight when the filters change under it, so a slow
   * page 4 for `SP` can never append itself to a freshly loaded list for `RJ`.
   * A ref rather than state: nothing renders differently because of it.
   */
  const moreRequest = useRef<AbortController | null>(null)

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
    group: data.group,
    groupChosen: chosenGroup !== null,
  }

  /**
   * The whole view model, written to the cache whenever it is worth keeping.
   * An empty list is not: re-running the two reads for it costs nothing the
   * user can see, and caching "nothing found" would outlive the sweep that is
   * about to find something.
   */
  useEffect(() => {
    const status = snapshotStatus(data.status)
    if (!status || data.tenders.length === 0 || data.readAt === 0) return
    saveList(key, {
      group: data.group,
      company: data.company,
      visitor: data.visitor,
      counts: data.counts,
      tenders: data.tenders,
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
    const restored = restoreList({ cnpj, state, q, group: chosenGroup })
    if (restored && restored.snapshot.scrollY > 0) window.scrollTo(0, restored.snapshot.scrollY)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const signal = controller.signal

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

      const list = await getTenders({ group: previous.group, cnpj, state, q }, signal)
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

      const restored = restoreList({ cnpj, state, q, group: chosenGroup })
      if (restored) {
        // The mount initializer may already have rendered this exact snapshot;
        // setting it again would replace an identical view model and re-render
        // for nothing.
        if (shown.current !== restored.snapshot.tenders) setData(fromSnapshot(restored.snapshot))
        if (restored.use === 'revalidate') {
          // Its own `catch`: a refresh that fails behind a list which is on
          // screen and working must not turn that screen into an error card.
          await revalidate(restored.snapshot).catch(() => {})
        }
        return
      }

      setData((previous) => ({
        ...previous,
        tenders: [],
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
      let answer: TenderListResponse = await getTenders({ group: asked, cnpj, state, q }, signal)
      let group = asked

      if (answer.state === 'ready' && chosenGroup === null) {
        const best = bestGroup(answer.counts)
        if (best !== asked) {
          // The one extra request this costs happens only in the case that was
          // broken before it: nothing in the tab we would have opened on.
          const second = await getTenders({ group: best, cnpj, state, q }, signal)
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
          group,
          status: { kind: 'error', code: answer.error, text: apiErrorText(answer) },
        }))
        return
      }
      if (answer.state === 'analyzing') {
        setData((previous) => ({ ...previous, tenders: [], group, status: { kind: 'timeout' } }))
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
        group,
        nextCursor: answer.nextCursor,
        loadingMore: false,
        freshness: answer.freshness,
        status,
        readAt: Date.now(),
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
  }, [cnpj, state, q, chosenGroup, key, attempt])

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

    getTenders({ group: data.group, cnpj, state, q, cursor }, controller.signal)
      .then((answer) => {
        settle()
        if (controller.signal.aborted) return
        setData((previous) =>
          answer.state === 'ready'
            ? {
                ...previous,
                tenders: appendTenders(previous.tenders, answer.tenders),
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
  }, [data.nextCursor, data.loadingMore, data.group, cnpj, state, q])

  const onNavigate = useCallback(
    (href: string) => {
      rememberScroll(key, scrollY.current)
      router.push(href, { scroll: false })
    },
    [router, key],
  )

  /** Retry means "ask again", so the snapshot must not answer for the route. */
  const onRetry = useCallback(() => {
    forgetList(key)
    setAttempt((value) => value + 1)
  }, [key])

  return (
    <RadarView
      query={query}
      status={data.status}
      company={data.company}
      visitor={data.visitor}
      counts={data.counts}
      tenders={data.tenders}
      nextCursor={data.nextCursor}
      loadingMore={data.loadingMore}
      freshness={data.freshness}
      onNavigate={onNavigate}
      onRetry={onRetry}
      onLoadMore={onLoadMore}
    />
  )
}
