'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { getJobStatus, getTenders, postCnpj } from '@/lib/radar/client'
import type {
  CnpjResponse,
  CompanyView,
  Freshness,
  TenderCard,
  TenderGroup,
  VisitorView,
} from '@/lib/radar/contract'
import { TENDER_GROUPS } from '@/lib/radar/contract'
import { apiErrorText, NETWORK_ERROR } from '@/lib/radar/error-text'
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
}

const INITIAL: Data = {
  company: null,
  visitor: null,
  counts: EMPTY_COUNTS,
  tenders: [],
  nextCursor: null,
  loadingMore: false,
  freshness: null,
  status: { kind: 'analyzing', what: 'company' },
}

function aborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

function readGroup(value: string | null): TenderGroup {
  return (TENDER_GROUPS as readonly string[]).includes(value ?? '')
    ? (value as TenderGroup)
    : 'compatible'
}

export function RadarScreen() {
  const router = useRouter()
  const params = useSearchParams()
  const [attempt, setAttempt] = useState(0)
  const [data, setData] = useState<Data>(INITIAL)
  /**
   * Aborts the page in flight when the filters change under it, so a slow
   * page 4 for `SP` can never append itself to a freshly loaded list for `RJ`.
   * A ref rather than state: nothing renders differently because of it.
   */
  const moreRequest = useRef<AbortController | null>(null)

  const cnpj = (params.get('cnpj') ?? '').replace(/\D+/g, '') || null
  const state = normaliseUf(params.get('uf'))
  const q = (params.get('q') ?? '').trim() || null
  const group = readGroup(params.get('group'))

  const query: RadarQuery = { cnpj, state, q, group }

  useEffect(() => {
    const controller = new AbortController()
    const signal = controller.signal

    // A new query means the previous "Ver mais" is answering a question nobody
    // is asking any more.
    moreRequest.current?.abort()
    moreRequest.current = null

    async function load() {
      if (!cnpj && !q) {
        setData({ ...INITIAL, status: { kind: 'needCnpj' } })
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
        const { value, timedOut } = await waitForData<CnpjResponse>({
          read: () => postCnpj(cnpj, signal),
          analyzing: (answer) => (answer.state === 'analyzing' ? answer.job : null),
          pollJob: (id) => getJobStatus(id, signal),
          signal,
        })

        if (value.state === 'error') {
          setData({ ...INITIAL, status: { kind: 'error', code: value.error, text: apiErrorText(value) } })
          return
        }
        if (timedOut || value.state === 'analyzing') {
          setData({ ...INITIAL, status: { kind: 'timeout' } })
          return
        }
        company = value.company
        visitor = value.visitor
        manualCnae = value.manualCnae
      }

      setData((previous) => ({
        ...previous,
        company,
        visitor,
        status: { kind: 'analyzing', what: 'list' },
      }))

      const answer = await getTenders({ group, cnpj, state, q }, signal)

      if (answer.state === 'error') {
        setData((previous) => ({
          ...previous,
          tenders: [],
          status: { kind: 'error', code: answer.error, text: apiErrorText(answer) },
        }))
        return
      }
      if (answer.state === 'analyzing') {
        setData((previous) => ({ ...previous, tenders: [], status: { kind: 'timeout' } }))
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
        nextCursor: answer.nextCursor,
        loadingMore: false,
        freshness: answer.freshness,
        status,
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
  }, [cnpj, state, q, group, attempt])

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

    getTenders({ group, cnpj, state, q, cursor }, controller.signal)
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
  }, [data.nextCursor, data.loadingMore, group, cnpj, state, q])

  const onNavigate = useCallback(
    (href: string) => {
      router.push(href, { scroll: false })
    },
    [router],
  )

  const onRetry = useCallback(() => setAttempt((value) => value + 1), [])

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
