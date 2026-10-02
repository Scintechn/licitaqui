'use client'

import { useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { getBand, getJobStatus, getTender, readSearch, screeningHref } from '@/lib/radar/client'
import type { BandResponse, TenderDetail, TenderResponse } from '@/lib/radar/contract'
import type { LockedEvidence, PriceBand, PriceEvidence } from '@/lib/radar/price-band'
import { apiErrorText, NETWORK_ERROR } from '@/lib/radar/error-text'
import { waitForData } from '@/lib/radar/poll'
import { chooseItem, PriceView, type PriceStatus } from './price-view'

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

/**
 * What the screen holds after one band answer. Exported for its test.
 *
 * `evidence` (E22) rides beside the band rather than inside it, because the two
 * answer different questions and are independently present: an item can have
 * evidence and no band (the common case — 11.17% against 0.67%, measured
 * 2026-10-01), or a band the reader may not see *and* the evidence under it.
 */
export type BandState =
  // **A union, so the two rungs cannot be confused.** `locked` carries
  // `LockedEvidence` — the count and what was matched, no prices — because at
  // five editais the sampled prices rebuild the band the state exists to
  // withhold (Sci, 2026-10-02). One object with `evidence: PriceEvidence | null`
  // beside a boolean would let a price reach the locked branch by an ordinary
  // mistake; this refuses it at compile time.
  | { band: PriceBand | null; locked: false; evidence: PriceEvidence | null }
  | { band: null; locked: true; evidence: LockedEvidence | null }

/**
 * A `BandResponse` as the screen stores it.
 *
 * Pulled out of the effect so that it can be tested at all. `vitest.config.mts`
 * sets `environment: 'node'`, so no `useEffect` in this repo ever runs under
 * test — and this mapping is where both of E9's worst defects lived.
 *
 * It answers only what the *band display* needs — the band, and whether a
 * number exists that this plan may not see. It deliberately says nothing
 * about entitlement: that arrives as a prop from the server, so it cannot be
 * missing, stale, or 412 ms late. An earlier version read `entitled` off this
 * response, which meant `getBand`'s `envelope<BandResponse>(...)` **cast**
 * decided whether a paying subscriber was shown an advertisement for their own
 * plan — a body without the field type-checked and read as "not entitled".
 */
export function bandStateFrom(answer: BandResponse): BandState {
  if (answer.state === 'ready') {
    return { band: answer.band, locked: false, evidence: answer.evidence }
  }
  if (answer.state === 'locked') {
    // **The evidence survives the lock, in its narrowed form.** Dropping it
    // here is the client-side version of the defect the route's own comment
    // describes — the ladder would go backwards at five editais, showing a
    // visitor an empty card the moment the data got good enough to sell. What
    // survives is the count and the matched descriptions; the route removed the
    // prices, and `LockedEvidence` is why this line cannot put them back.
    return { band: null, locked: true, evidence: answer.evidence }
  }
  // `envelope()` does not throw on a non-2xx — it parses the body — so a 429
  // or a 500 arrives here as `state: 'error'`. Falling through left `loaded`
  // null, and `bandLocked` then defaulted to **true**: an Essencial subscriber
  // whose request failed was shown the locked bar labelled "valor disponível
  // no plano Essencial" and a "Ver plano Essencial" button, permanently, with
  // no retry on this path. A failure must degrade to the honest empty card,
  // never to an advertisement for the plan they already bought.
  //
  return { band: null, locked: false, evidence: null }
}

export function PriceScreen({ id, entitled }: { id: string; entitled: boolean }) {
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
  // `& BandState` rather than a hand-written copy of its fields: the spread at
  // `setLoaded` below is exempt from excess-property checking, so when E22 added
  // `evidence` to `BandState` it arrived here at runtime and was invisible to
  // the type — `bandStateFrom`'s tested contract was not the contract this
  // component stored, and nothing could read the new field.
  const [loaded, setLoaded] = useState<({ id: string; item: number } & BandState) | null>(null)

  /**
   * **The item actually on screen, which is not the one in the URL.**
   *
   * `screening-view.tsx` links here with `priceHref(tenderId, search)` and no
   * item, so `?item=` is absent on every entry into this screen; `PriceView`
   * then falls back to the first item. The first version of this effect
   * returned early on `item === null`, so it asked for nothing, and the screen
   * showed "ainda sem dados de vencedores" for an item that may well have a
   * band. On a single-item tender there is no chip to set `?item=` at all, so
   * the band was unreachable **forever** — and a large share of pregões are
   * single-item.
   *
   * The tests missed it because they passed a band alongside `item: null`, a
   * combination the client cannot produce. Resolving the same item the view
   * resolves is what makes the request match the screen.
   */
  const chosen = data.tender ? chooseItem(data.tender.items, item)?.number ?? null : null

  useEffect(() => {
    if (chosen === null) return
    const controller = new AbortController()
    getBand(id, chosen, controller.signal)
      .then((answer) => {
        setLoaded({ id, item: chosen, ...bandStateFrom(answer) })
      })
      .catch(() => {
        // Aborted, offline, or a network error: the same rule as the error
        // branch of `bandStateFrom`, and spelled the same way on purpose.
        if (!controller.signal.aborted) {
          setLoaded({ id, item: chosen, band: null, locked: false, evidence: null })
        }
      })
    return () => controller.abort()
  }, [id, chosen, attempt])

  // Keyed on the tender as well as the item: the App Router preserves client
  // state across a same-route navigation, so without `id` a band could render
  // under a different edital until the new response landed.
  const current = loaded !== null && loaded.id === id && loaded.item === chosen ? loaded : null
  const band = current?.band ?? null
  /**
   * Defaults to **locked while the answer is in flight**, and never as the
   * result of a failure.
   *
   * Before the answer arrives the two wrong guesses are not equal: showing the
   * locked bar and then revealing a band is an upgrade the reader watches
   * happen, while showing "ainda sem dados" and then replacing it with a price
   * tells them something false first.
   *
   * After a failure they are not equal either, in the other direction — see
   * the error branches above. A request that errored sets `locked: false`, so
   * the screen falls back to the honest empty card.
   */
  const bandLocked = current === null || current.locked
  /**
   * **One question, one source.** Entitlement does not depend on the item, the
   * band or the tender, so it is read on the server before anything renders
   * and arrives as a prop. Driving this off the band answer instead is what
   * made the CTA appear a second late, flicker on every item chip, and never
   * appear at all on a tender with no items — see `entitlement.ts`.
   */
  const showPlanCta = !entitled

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
      bandLocked={bandLocked}
      evidence={current?.evidence ?? null}
      showPlanCta={showPlanCta}
      onRetry={onRetry}
    />
  )
}
