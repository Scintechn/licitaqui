'use client'

import { useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { getJobStatus, getTender, radarHref, readSearch, TAB_PARAM } from '@/lib/radar/client'
import type {
  Freshness,
  ScreeningAvailability,
  TenderDetail,
  TenderResponse,
} from '@/lib/radar/contract'
import { apiErrorText, NETWORK_ERROR } from '@/lib/radar/error-text'
import { waitForData } from '@/lib/radar/poll'
import { OpportunityView, type OpportunityStatus, type OpportunityTab } from './opportunity-view'
import { ITEMS_PAGE } from './tender-items'

/**
 * `GET /api/tenders/:id` for one tender, and the back link that remembers
 * where the user came from.
 *
 * The route answers `ready` or an error and never `202`: `sync_items` cannot
 * invent a header the sweep has not written, so an unknown id is a 404 rather
 * than a promise to analyse something (see `tenderOrRefresh`). It is still
 * read through `waitForData`, because the envelope allows `analyzing` and a
 * screen that could not render it would be wrong the day the route can.
 */

type Data = {
  tender: TenderDetail | null
  freshness: Freshness | null
  /** Whether a reading exists and whether this caller has paid for it. */
  screening: ScreeningAvailability | null
  status: OpportunityStatus
}

const INITIAL: Data = {
  tender: null,
  freshness: null,
  screening: null,
  status: { kind: 'analyzing' },
}

function aborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function OpportunityScreen({ id }: { id: string }) {
  const params = useSearchParams()
  const [attempt, setAttempt] = useState(0)
  const [data, setData] = useState<Data>(INITIAL)
  // The record's tab and how far the Itens list has been unrolled live here,
  // the way the screening screen's tab does, so `opportunity-view.tsx` stays a
  // pure function of props and every page of the table renders in a test.
  /**
   * `?tab=files` opens on Documentos.
   *
   * The screening screen's own "Documentos" tab links here, because the files
   * live on this screen and never lived on that one. Without this the reader
   * clicked Documentos and arrived at **Itens** — which is barely better than
   * the padlock that link used to carry.
   *
   * Read once, as the initial value, rather than kept in sync with the URL:
   * changing tabs afterwards is a local gesture and pushing history entries
   * for it would make Back mean "previous tab" instead of "previous page".
   */
  const [tab, setTab] = useState<OpportunityTab>(
    params.get(TAB_PARAM) === 'files' ? 'files' : 'items',
  )
  const [itemsVisible, setItemsVisible] = useState(ITEMS_PAGE)

  /**
   * The tender the open tab belongs to.
   *
   * The loader below resets the tab, because a different tender is a different
   * table. It also runs **on mount**, where there is no previous tender — and
   * that reset landed one render after the initial value above, so `?tab=files`
   * was read, applied, and then thrown away before anybody saw it. Sci clicked
   * *Documentos* and arrived at *Itens*: the exact defect the parameter was
   * added to fix, restored by the reset that was already there.
   *
   * No test could see it. `vitest.config.mts` runs `environment: 'node'`, so
   * `useEffect` never fires in the suite: a unit test reads the initial state
   * and sees `'files'`, which is true for one render and false by the time the
   * browser paints. The guard for this is `e2e/journeys/documentos.spec.ts`,
   * which walks the link rather than rendering either end of it.
   */
  const tabOwner = useRef(id)

  /**
   * The search this screen is carrying — read once and used for every address
   * it draws, both the "Voltar" below and the triagem link the view puts at
   * the bottom of the page. Two readings of the same query string were how the
   * back link kept the search and the forward link dropped it.
   */
  const search = readSearch(params)
  const backHref = radarHref(search)

  useEffect(() => {
    const controller = new AbortController()
    const signal = controller.signal

    async function load() {
      setData(INITIAL)
      // A different tender is a different table: keep neither the open tab nor
      // how far the last one had been scrolled. **Only when it really is a
      // different one** — this also runs on mount and on retry, where the
      // reset would discard the tab `?tab=files` had just chosen.
      if (tabOwner.current !== id) {
        tabOwner.current = id
        setTab('items')
      }
      setItemsVisible(ITEMS_PAGE)
      const { value, timedOut } = await waitForData<TenderResponse>({
        read: () => getTender(id, signal),
        analyzing: (answer) => (answer.state === 'analyzing' ? answer.job : null),
        pollJob: (jobId) => getJobStatus(jobId, signal),
        signal,
      })

      if (value.state === 'error') {
        setData({
          tender: null,
          freshness: null,
          screening: null,
          status:
            value.error === 'not_found' || value.error === 'validation'
              ? { kind: 'notFound' }
              : { kind: 'error', code: value.error, text: apiErrorText(value) },
        })
        return
      }
      if (timedOut || value.state === 'analyzing') {
        setData({ tender: null, freshness: null, screening: null, status: { kind: 'notFound' } })
        return
      }

      setData({
        tender: value.tender,
        freshness: value.freshness,
        screening: value.screening,
        status: { kind: 'ready' },
      })
    }

    load().catch((error: unknown) => {
      if (aborted(error) || signal.aborted) return
      setData({
        tender: null,
        freshness: null,
        screening: null,
        status: { kind: 'error', code: 'server_error', text: NETWORK_ERROR },
      })
    })

    return () => controller.abort()
  }, [id, attempt])

  const onRetry = useCallback(() => setAttempt((value) => value + 1), [])
  const onShowMoreItems = useCallback(
    () => setItemsVisible((value) => value + ITEMS_PAGE),
    [],
  )

  return (
    <OpportunityView
      tender={data.tender}
      freshness={data.freshness}
      status={data.status}
      backHref={backHref}
      search={search}
      screening={data.screening}
      onRetry={onRetry}
      tab={tab}
      onSelectTab={setTab}
      itemsVisible={itemsVisible}
      onShowMoreItems={onShowMoreItems}
      /* The cost of the button directly above it. `screeningCost` and
         `screeningCostReady` were written, approved and tested, and then never
         passed: the prop defaults to `false` and this was its only call site,
         so a visitor spent one of her two triagens by tapping a button that
         said nothing about spending anything — and learnt the rule only when
         the second one went the same way and the wall appeared.

         `screeningCostReady` is the half that matters most: a tender somebody
         else already had read still costs her one, and nothing else on the
         screen says so. */
      showScreeningCost
    />
  )
}
