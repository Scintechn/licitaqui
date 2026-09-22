'use client'

import { useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import {
  getJobStatus,
  getScreening,
  getTender,
  postScreening,
  readSearch,
  tenderHref,
} from '@/lib/radar/client'
import type {
  QuotaView,
  ScreeningReadResponse,
  TenderDetail,
  VisitorView,
} from '@/lib/radar/contract'
import { apiErrorText, NETWORK_ERROR } from '@/lib/radar/error-text'
import { waitThenWatch, type JobStatus } from '@/lib/radar/poll'
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
 *
 * ## …and why 60 s is not where the waiting stops
 *
 * §3.1's sixty seconds is the deadline for a read whose job writes a row in
 * one hop. An `ai_screening` is not that: it is `sync_files`, a PDF download
 * (§7.2 allows 120 s), `extract_text`, then the lite model (90 s). The two
 * budgets never agreed, so the poll was structurally certain to give up first.
 *
 * Measured on production, 2026-09-22, CNPJ 36955612000185 on
 * `13654405000195-1-000033/2026`: the screen showed "está demorando" at 60 s
 * and made no further request; `GET /api/tenders/:id/screening` answered
 * `ready` at **≈178 s**, to a probe, while the screen that had asked for it
 * sat on the timeout card. Pressing Voltar and opening the triagem again
 * showed the analysis at once — Sci's report, exactly.
 *
 * So the deadline is no longer where the reading stops. When it passes, the
 * screen says so — the honest card, with its retry — and **keeps reading
 * behind it** every ten seconds, which is §3.1's own shape ("respond with what
 * we have, refresh behind it") applied to a screen instead of a route. The
 * result replaces the card the moment it lands, with no second navigation and
 * no second request. Nothing is persisted for this: a completed screening is a
 * row in `ai_analyses`, so a document that *does* unload re-reads it on the
 * way back (the `POST` answers `200 ready` from cache and charges nothing —
 * `quota.spend` de-duplicates on the tender id).
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

  // The search this screen is carrying, read once. "Voltar" goes back to the
  // Opportunity screen with it, so the *second* "Voltar" still lands on the
  // list the user came from; the view builds its own outbound links from it.
  const search = readSearch(params)
  const backHref = tenderHref(id, search)

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
      const tender = await header
      setData({
        tender,
        model: null,
        quota: asked.quota,
        visitor: asked.visitor ?? null,
        status: { kind: 'analyzing' },
      })

      const job = asked.job
      let lastStatus: JobStatus | null = null

      const { value, timedOut, watched } = await waitThenWatch<ScreeningReadResponse>({
        read: () => getScreening(id, signal),
        analyzing: (answer) => (answer.state === 'pending' && lastStatus !== 'failed' ? job : null),
        pollJob: async (jobId) => {
          lastStatus = await getJobStatus(jobId, signal)
          return lastStatus
        },
        // §3.1's sixty seconds are up and the job is still running: say so, and
        // go on reading behind the card rather than stopping on it.
        onTimeout: (answer) => {
          if (answer.state !== 'pending') return
          setData({
            tender,
            model: null,
            quota: answer.quota,
            visitor: answer.visitor ?? null,
            status: { kind: 'timeout' },
          })
        },
        signal,
      })

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
        // The watch ran its five minutes and the card it put on screen is
        // still the right one: re-setting it would re-render for nothing.
        if (watched && timedOut) return
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

  /**
   * Coming back to a screen that was left waiting.
   *
   * The watch above covers the case where the tab stays in front. It does not
   * cover a phone: a backgrounded tab has its timers throttled to roughly one
   * a minute, and a user who left for longer than the watch comes back to a
   * card about a screening that finished while they were away. So returning is
   * itself a reason to re-read — one `GET`, which never spends and never
   * enqueues — and the answer takes the card's place.
   *
   * `pageshow` as well as `visibilitychange`, because a bfcache restore (the
   * browser's own Back, on iOS especially) puts this component back on screen
   * with its state intact and fires neither an effect nor a visibility change.
   */
  const waiting = data.status.kind === 'analyzing' || data.status.kind === 'timeout'
  useEffect(() => {
    if (!waiting) return
    const controller = new AbortController()
    const reread = () => {
      if (document.visibilityState !== 'visible') return
      getScreening(id, controller.signal)
        .then((answer) => {
          if (answer.state !== 'ready') return
          const model = parseScreening(answer.result, answer.citationCheck, answer.rules)
          setData((previous) => ({
            ...previous,
            model,
            quota: answer.quota,
            visitor: answer.visitor ?? previous.visitor,
            status: readyStatus(answer.status, model),
          }))
        })
        // A refresh that fails behind a card which is on screen and honest
        // must not turn that card into an error.
        .catch(() => {})
    }
    document.addEventListener('visibilitychange', reread)
    window.addEventListener('pageshow', reread)
    return () => {
      controller.abort()
      document.removeEventListener('visibilitychange', reread)
      window.removeEventListener('pageshow', reread)
    }
  }, [id, waiting])

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
      search={search}
      onRetry={onRetry}
    />
  )
}
