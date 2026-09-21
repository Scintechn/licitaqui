'use client'

import { useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { getJobStatus, getTender, screeningHref } from '@/lib/radar/client'
import type { TenderDetail, TenderResponse } from '@/lib/radar/contract'
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
  // item: they belong to different screens.
  const carried = new URLSearchParams(params.toString())
  carried.delete('item')
  const query = carried.toString()
  const backHref = `${screeningHref(id)}${query ? `?${query}` : ''}`

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

  const onRetry = useCallback(() => setAttempt((value) => value + 1), [])

  return (
    <PriceView
      tenderId={id}
      tender={data.tender}
      item={item}
      status={data.status}
      backHref={backHref}
      onRetry={onRetry}
    />
  )
}
