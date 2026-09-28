'use client'

import { useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { getBand, getJobStatus, getTender, readSearch, screeningHref } from '@/lib/radar/client'
import type { TenderDetail, TenderResponse } from '@/lib/radar/contract'
import type { PriceBand } from '@/lib/radar/price-band'
import { apiErrorText, NETWORK_ERROR } from '@/lib/radar/error-text'
import { waitForData } from '@/lib/radar/poll'
import { PriceView, type PriceStatus } from './price-view'

/**
 * Canvas 05 needs one thing the browser does not already have: the tender's
 * items, for the estimated unit price. That is `GET /api/tenders/:id`, read
 * exactly the way the Opportunity screen reads it — same envelope, same poll.
 *
 * Nothing here asks for a screening: reaching the price block must never spend
 * one of the visitor's two.
 */

type Data = { tender: TenderDetail | null; status: PriceStatus }

const INITIAL: Data = { tender: null, status: { kind: 'analyzing' } }

function aborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

export function PriceScreen({ id }: { id: string }) {
  const params = useSearchParams()
  const [attempt, setAttempt] = useState(0)
  const [data, setData] = useState<Data>(INITIAL)

  const itemParam = Number(params.get('item'))
  const item = Number.isInteger(itemParam) && itemParam > 0 ? itemParam : null

  // "Voltar" goes back to the screening, keeping the Radar filters but not the
  // item: they belong to different screens. `readSearch` takes exactly the four
  // that travel, so `?item=` is left behind by construction rather than deleted.
  const search = readSearch(params)
  const backHref = screeningHref(id, search)

  useEffect(() => {
    const controller = new AbortController()
    const signal = controller.signal

    async function load() {
      setData(INITIAL)
      const { value, timedOut } = await waitForData<TenderResponse>({
        read: () => getTender(id, signal),
        analyzing: (answer) => (answer.state === 'analyzing' ? answer.job : null),
        pollJob: (jobId) => getJobStatus(jobId, signal),
        signal,
      })

      if (value.state === 'error') {
        setData({
          tender: null,
          status:
            value.error === 'not_found' || value.error === 'validation'
              ? { kind: 'notFound' }
              : { kind: 'error', code: value.error, text: apiErrorText(value) },
        })
        return
      }
      if (timedOut || value.state === 'analyzing') {
        setData({ tender: null, status: { kind: 'notFound' } })
        return
      }
      setData({ tender: value.tender, status: { kind: 'ready' } })
    }

    load().catch((error: unknown) => {
      if (aborted(error) || signal.aborted) return
      setData({
        tender: null,
        status: { kind: 'error', code: 'server_error', text: NETWORK_ERROR },
      })
    })

    return () => controller.abort()
  }, [id, attempt])

  /**
   * The band, fetched separately and **allowed to fail silently**.
   *
   * Its own request because it costs a trigram join the Opportunity screen
   * never needs, and its own effect because it depends on `item` — changing
   * the item chip must refetch the band without refetching the tender.
   *
   * On any failure the band stays `null`, which renders the same "no winner
   * data yet" card as a genuinely empty result. That is deliberate: the price
   * screen's job is the estimated price and the item list, and neither depends
   * on this. A banner apologising for a missing band would be louder than the
   * thing it is apologising for.
   */
  /**
   * Stored **with the item it belongs to**, and filtered at render rather than
   * cleared in the effect.
   *
   * Clearing it eagerly was the first version and it was wrong twice: it calls
   * `setState` synchronously inside an effect, and between the two renders it
   * left the previous item's band on screen — a real price, attached to the
   * wrong item, which is precisely the failure this whole card is built to
   * avoid. Keeping the item alongside the band makes a stale one unrenderable
   * by construction instead of by timing.
   */
  const [loaded, setLoaded] = useState<{ item: number; band: PriceBand | null } | null>(null)

  useEffect(() => {
    if (item === null) return
    const controller = new AbortController()
    getBand(id, item, controller.signal)
      .then((answer) => {
        if (answer.state === 'ready') setLoaded({ item, band: answer.band })
      })
      .catch(() => {
        // Aborted, offline, or a 500. The screen is complete without it.
      })
    return () => controller.abort()
  }, [id, item, attempt])

  const band = loaded !== null && loaded.item === item ? loaded.band : null

  const onRetry = useCallback(() => setAttempt((value) => value + 1), [])

  return (
    <PriceView
      tenderId={id}
      tender={data.tender}
      item={item}
      status={data.status}
      backHref={backHref}
      search={search}
      band={band}
      onRetry={onRetry}
    />
  )
}
