'use client'

import { useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { getBand, getJobStatus, getTender, readSearch, screeningHref } from '@/lib/radar/client'
import type { BandResponse, TenderDetail, TenderResponse } from '@/lib/radar/contract'
import type { PriceBand } from '@/lib/radar/price-band'
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

/** What the screen holds after one band answer. Exported for its test. */
export type BandState = { band: PriceBand | null; locked: boolean; entitled: boolean }

/**
 * A `BandResponse` as the screen stores it.
 *
 * Pulled out of the effect so that it can be tested at all. `vitest.config.mts`
 * sets `environment: 'node'`, so no `useEffect` in this repo ever runs under
 * test — and this mapping is where both of E9's worst defects lived.
 *
 * `answer.entitled === true` rather than `answer.entitled` is deliberate.
 * `getBand` is `envelope<BandResponse>(...)`, which **casts** the body rather
 * than parsing it, so a `ready` payload without the field — a new bundle
 * against an old server mid-rollout, a cached chunk — would leave `entitled`
 * as `undefined`, make `!entitled` true, and print "Ver plano Essencial" to a
 * subscriber beside the band they had just been shown: the exact defect this
 * code exists to remove, with TypeScript satisfied throughout. Coercing here
 * fails in the safe direction.
 */
export function bandStateFrom(answer: BandResponse): BandState {
  if (answer.state === 'ready') {
    return { band: answer.band, locked: false, entitled: answer.entitled === true }
  }
  if (answer.state === 'locked') {
    return { band: null, locked: true, entitled: false }
  }
  // `envelope()` does not throw on a non-2xx — it parses the body — so a 429
  // or a 500 arrives here as `state: 'error'`. Falling through left `loaded`
  // null, and `bandLocked` then defaulted to **true**: an Essencial subscriber
  // whose request failed was shown the locked bar labelled "valor disponível
  // no plano Essencial" and a "Ver plano Essencial" button, permanently, with
  // no retry on this path. A failure must degrade to the honest empty card,
  // never to an advertisement for the plan they already bought.
  //
  // `entitled: true` here is not a claim about the plan — it is the choice to
  // sell nothing when we do not know. A wrong "buy this" is worse than a
  // missing one, in both directions: to a subscriber it is an insult, and to
  // a visitor it is a promise made on no evidence.
  return { band: null, locked: false, entitled: true }
}

/**
 * Whether to offer the plan. **Not the same question as `bandLocked`.**
 *
 * An unentitled visitor on an item with no band gets `ready` with `band: null`
 * — indistinguishable from a subscriber's empty item unless the route says so.
 * Hiding the CTA on `!bandLocked` alone removed the upsell from exactly the
 * people it is for.
 *
 * `null` is "in flight, or the tender has no item to ask about", and offers
 * nothing, by the same rule as the error branch above.
 */
export function planOffer(current: BandState | null): boolean {
  return current === null ? false : current.locked || !current.entitled
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
  const [loaded, setLoaded] = useState<{
    id: string
    item: number
    band: PriceBand | null
    locked: boolean
    entitled: boolean
  } | null>(null)

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
          setLoaded({ id, item: chosen, band: null, locked: false, entitled: true })
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
  const showPlanCta = planOffer(current)

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
      showPlanCta={showPlanCta}
      onRetry={onRetry}
    />
  )
}
