'use client'

import { useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
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
      // **No `setTab('items')` here.** There used to be one, to stop a new
      // tender inheriting the previous one's open tab, and it is what broke
      // `?tab=files`: this effect also runs on **mount**, where there is no
      // previous tender, so the tab chosen one line above was read, applied
      // and discarded a render later. Sci clicked *Documentos* and got *Itens*.
      //
      // It is not needed, and a narrower guard around it would have been dead
      // code wearing a comment. `id` comes from the `[...id]` catch-all, and
      // the App Router keys each segment's subtree by a cache key that
      // *contains the segment value* (`create-router-cache-key.js`, used as
      // the React key at `layout-router.js:673`). A different tender is a
      // different subtree: this component **remounts**, with a fresh `useState`
      // that re-reads the new URL. The router already does the resetting.
      //
      // What removing it changes, and the only thing it changes: `attempt`
      // also re-runs this effect, so a retry no longer throws the reader off
      // Documentos.
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
