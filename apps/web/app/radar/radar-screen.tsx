'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
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
  freshness: Freshness | null
  status: RadarStatus
}

const INITIAL: Data = {
  company: null,
  visitor: null,
  counts: EMPTY_COUNTS,
  tenders: [],
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

  const cnpj = (params.get('cnpj') ?? '').replace(/\D+/g, '') || null
  const state = normaliseUf(params.get('uf'))
  const q = (params.get('q') ?? '').trim() || null
  const group = readGroup(params.get('group'))

  const query: RadarQuery = { cnpj, state, q, group }

  useEffect(() => {
    const controller = new AbortController()
    const signal = controller.signal

    async function load() {
      if (!cnpj && !q) {
        setData({ ...INITIAL, status: { kind: 'needCnpj' } })
        return
      }

      setData((previous) => ({
        ...previous,
        tenders: [],
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
        freshness: answer.freshness,
        status,
      })
    }

    load().catch((error: unknown) => {
      if (aborted(error) || signal.aborted) return
      setData({ ...INITIAL, status: { kind: 'error', code: 'server_error', text: NETWORK_ERROR } })
    })

    return () => controller.abort()
  }, [cnpj, state, q, group, attempt])

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
      freshness={data.freshness}
      onNavigate={onNavigate}
      onRetry={onRetry}
    />
  )
}
