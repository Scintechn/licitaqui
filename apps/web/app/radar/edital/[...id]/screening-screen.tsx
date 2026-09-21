'use client'

import { useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { getJobStatus, getScreening, getTender, postScreening, tenderHref } from '@/lib/radar/client'
import type {
  QuotaView,
  ScreeningReadResponse,
  TenderDetail,
  VisitorView,
} from '@/lib/radar/contract'
import { apiErrorText, NETWORK_ERROR } from '@/lib/radar/error-text'
import { waitForData, type JobStatus } from '@/lib/radar/poll'
import { parseScreening, type ScreeningModel } from '@/lib/radar/screening-result'
import { ScreeningView, type ScreeningStatus, type ScreeningTab } from './screening-view'

/**
 * Asking for the triagem and waiting for it (spec §3.1, §8).
 *
 * ## One `POST`, then a `GET` every three seconds
 *
 * The `POST` is the request: it checks the quota, charges it and enqueues a
 * priority-1 job. The `GET` is the poll, and it is a different route on
 * purpose — polling the `POST` twenty times a minute would run into its own
 * rate limit (twelve) the moment `enqueueJob` de-duplicates and hands back a
 * `null` job id, which is exactly when the client has nothing to poll and
 * re-reads on every tick.
 *
 * ## Why the job status is watched as well as the row
 *
 * `waitForData` stops on a deadline, never on nothing. But a job that *fails*
 * writes no usable row, so waiting for one would burn the whole 60 s and end in
 * "está demorando" when the truthful answer is "não conseguimos ler". So the
 * last status `GET /api/jobs/:id` reported is kept, and a `failed` ends the
 * wait immediately with the state that says so.
 *
 * Three ways out, and the screen has a different sentence for each: the row
 * arrives (`ready` / `noText`), the job failed (`failed`), or 60 s went by and
 * it is still running (`timeout`, which offers a retry rather than spinning).
 */

type Data = {
  tender: TenderDetail | null
  model: ScreeningModel | null
  quota: QuotaView | null
  visitor: VisitorView | null
  status: ScreeningStatus
}

const INITIAL: Data = {
  tender: null,
  model: null,
  quota: null,
  visitor: null,
  status: { kind: 'analyzing' },
}

function aborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** A finished row → the screen's state. `no_text` is an answer, not a failure. */
function readyStatus(status: 'ok' | 'no_text', model: ScreeningModel | null): ScreeningStatus {
  if (status === 'no_text') return { kind: 'noText' }
  return model ? { kind: 'ready' } : { kind: 'failed' }
}

export function ScreeningScreen({ id }: { id: string }) {
  const params = useSearchParams()
  const [attempt, setAttempt] = useState(0)
  const [tab, setTab] = useState<ScreeningTab>('summary')
  const [data, setData] = useState<Data>(INITIAL)

  // Back to the Opportunity screen, carrying the Radar filters through so the
  // second "Voltar" still lands on the list the user came from.
  const query = params.toString()
  const backHref = `${tenderHref(id)}${query ? `?${query}` : ''}`

  useEffect(() => {
    const controller = new AbortController()
    const signal = controller.signal

    async function load() {
      setData(INITIAL)

      // The header and the analysis are independent: a tender route that fails
      // must not hide an analysis we already hold, so it is read separately and
      // its failure only costs the title.
      const header = getTender(id, signal)
        .then((answer) => (answer.state === 'ready' ? answer.tender : null))
        .catch(() => null)

      const asked = await postScreening(id, signal)

      if (asked.state === 'error') {
        const tender = await header
        setData({
          tender,
          model: null,
          quota: asked.quota ?? null,
          visitor: null,
          status:
            asked.error === 'quota_exceeded'
              ? { kind: 'quota' }
              : asked.error === 'not_found' || asked.error === 'validation'
                ? { kind: 'notFound' }
                : { kind: 'error', code: asked.error, text: apiErrorText(asked) },
        })
        return
      }

      if (asked.state === 'ready') {
        const model = parseScreening(asked.result, asked.citationCheck, asked.rules)
        setData({
          tender: await header,
          model,
          quota: asked.quota,
          visitor: asked.visitor ?? null,
          status: readyStatus(asked.status, model),
        })
        return
      }

      // 202: queued. Show the spinner immediately, then poll the read route.
      setData({
        tender: await header,
        model: null,
        quota: asked.quota,
        visitor: asked.visitor ?? null,
        status: { kind: 'analyzing' },
      })

      const job = asked.job
      let lastStatus: JobStatus | null = null

      const { value, timedOut } = await waitForData<ScreeningReadResponse>({
        read: () => getScreening(id, signal),
        analyzing: (answer) =>
          answer.state === 'pending' && lastStatus !== 'failed' ? job : null,
        pollJob: async (jobId) => {
          lastStatus = await getJobStatus(jobId, signal)
          return lastStatus
        },
        signal,
      })

      const tender = await header

      if (value.state === 'error') {
        setData({
          tender,
          model: null,
          quota: value.quota ?? null,
          visitor: null,
          status:
            value.error === 'quota_exceeded'
              ? { kind: 'quota' }
              : { kind: 'error', code: value.error, text: apiErrorText(value) },
        })
        return
      }

      if (value.state === 'pending') {
        setData({
          tender,
          model: null,
          quota: value.quota,
          visitor: value.visitor ?? null,
          status: timedOut ? { kind: 'timeout' } : { kind: 'failed' },
        })
        return
      }

      const model = parseScreening(value.result, value.citationCheck, value.rules)
      setData({
        tender,
        model,
        quota: value.quota,
        visitor: value.visitor ?? null,
        status: readyStatus(value.status, model),
      })
    }

    load().catch((error: unknown) => {
      if (aborted(error) || signal.aborted) return
      setData({
        tender: null,
        model: null,
        quota: null,
        visitor: null,
        status: { kind: 'error', code: 'server_error', text: NETWORK_ERROR },
      })
    })

    return () => controller.abort()
  }, [id, attempt])

  const onRetry = useCallback(() => setAttempt((value) => value + 1), [])

  return (
    <ScreeningView
      tenderId={id}
      tender={data.tender}
      model={data.model}
      quota={data.quota}
      visitor={data.visitor}
      status={data.status}
      tab={tab}
      onSelectTab={setTab}
      backHref={backHref}
      onRetry={onRetry}
    />
  )
}
