import { NextResponse } from 'next/server'
import { planOf, readViewer } from '@/lib/auth/viewer'
import { PRIVATE_NO_STORE } from '@/lib/cache'
import { db } from '@/lib/db'
import { comparablesForItem } from '@/lib/radar/comparables'
import type { BandResponse } from '@/lib/radar/contract'
import { priceBand, priceEvidence, withoutPrices } from '@/lib/radar/price-band'
import { hasPriceBand } from '@/lib/radar/quota'
import { rateLimitRequest } from '@/lib/rate-limit'

/**
 * `GET /api/tenders/:id/band?item=N` (E9) — the price band for one item.
 *
 * ## Why this is its own route
 *
 * `GET /api/tenders/:id` is the Opportunity screen's read, and the price
 * screen is not the only caller. Folding the band into it would make every
 * opportunity view pay for a trigram join across `tender_items` — a scan today,
 * since no `gin (description gin_trgm_ops)` index exists yet — to compute a
 * number that screen never shows. One item, one request, only when the price
 * block is open.
 *
 * ## `band: null` is the answer, not an error
 *
 * Most items have no band and that is expected, not a fault: measured
 * 2026-09-28, roughly 1% of open items clear the gate. A 404 or an error state
 * would make the client treat an ordinary outcome as a failure and retry it.
 * The route answers 200 with `band: null`, and the screen says "no winner data
 * yet" rather than drawing a locked bar over a number that does not exist.
 *
 * ## It is an Essencial feature, and the gate is here
 *
 * Sci's decision, 2026-09-28. The first version of this route was deliberately
 * ungated on the reasoning that `awards` is public procurement history — true,
 * and beside the point: `plans.essential.feature3` sells the band as what
 * Essencial is *for*, and E9's own card names the defect as "a paying
 * subscriber sees exactly what an anonymous visitor sees". Leaving it open
 * inverted that rather than resolving it.
 *
 * A plan that does not include it gets `state: 'locked'` — never a band, and
 * never `band: null`, which would tell a visitor no number exists when the
 * truth is that they have not paid for it.
 *
 * It still spends nothing: read-only, no screening, no usage row. `readViewer`
 * never mints an identity on a GET.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RATE_LIMIT = { limit: 120, windowMs: 60_000 }

/** PNCP's `numeroControlePNCP`: `<14 digits>-<1 digit>-<6 digits>/<year>`. */
const TENDER_ID_RE = /^\d{14}-\d-\d{6}\/\d{4}$/

function fail(body: BandResponse, status: number, headers?: HeadersInit) {
  return NextResponse.json(body, {
    status,
    headers: { 'cache-control': PRIVATE_NO_STORE, ...headers },
  })
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse<BandResponse>> {
  const decision = await rateLimitRequest('tender-band', request.headers, RATE_LIMIT)
  if (!decision.ok) {
    return fail({ state: 'error', error: 'rate_limited' }, 429, {
      'retry-after': String(decision.retryAfter),
    })
  }

  const { id } = await context.params
  if (!TENDER_ID_RE.test(id)) {
    return fail({ state: 'error', error: 'validation', fields: { id: 'tenderIdInvalid' } }, 400)
  }

  const item = Number(new URL(request.url).searchParams.get('item'))
  if (!Number.isInteger(item) || item < 1) {
    return fail({ state: 'error', error: 'validation', fields: { item: 'itemInvalid' } }, 400)
  }

  try {
    const executor = db()
    // Read only: a GET never mints an identity (see `readViewer`).
    const viewer = await readViewer(request.headers.get('cookie'), executor)
    const entitled = await hasPriceBand(planOf(viewer), executor)

    // **Computed before the plan is consulted, on purpose** (Sci, 2026-09-28).
    //
    // Returning `locked` without computing was cheaper and said something
    // false: both this contract and the screen define locked as *a number
    // exists and this plan does not include it*, and roughly 99 of every 100
    // items have no number at all. A visitor would be shown a paywall over
    // nothing, pay, and find "ainda sem dados de vencedores" behind it — the
    // exact sentence-that-is-not-true this card exists to stop.
    //
    // The cost is the trigram query for unentitled callers. That is the price
    // of the claim being true, and it is why the rate limit below the gate
    // matters more than it did.
    // One read, both rungs. E22: the comparables that are not enough for a
    // band are still the honest answer for ~10× as many items — measured
    // 2026-10-01, 11.17% of open items have a past winner of the same product
    // and 0.67% have a band — and they cost nothing extra here, because the
    // query that found them has already run.
    const comparables = await comparablesForItem(id, item, executor)
    const band = priceBand(comparables)
    const evidence = priceEvidence(comparables)

    if (band !== null && !entitled) {
      return NextResponse.json(
        // **The count and what was matched ride along; the prices do not.**
        //
        // Sci, 2026-10-01: raw evidence free, computation paid. Then, 2026-10-02,
        // the measurement that narrowed it: where a band exists the four
        // sampled prices *are* the band, so the two halves of that ruling
        // described the same numbers. Above `MIN_SAMPLE` the values are
        // withheld and the count and descriptions are not — the reader can
        // still judge whether we matched the right product, which is the thing
        // they cannot otherwise check.
        //
        // `withoutPrices` narrows the same evidence an entitled caller gets, so
        // there is one computation and one narrowing rather than a second
        // query that could drift from the first.
        { state: 'locked', evidence: evidence === null ? null : withoutPrices(evidence) },
        { status: 200, headers: { 'cache-control': PRIVATE_NO_STORE } },
      )
    }

    // No `entitled` on the wire: the screen reads entitlement on the server
    // before it renders (`readPriceBandEntitlement`), so carrying it here
    // would be a second source of truth for the same question — and the slower
    // of the two, since this answer is 412 ms behind a trigram join. The gate
    // below still applies: an unentitled caller never receives a band.
    return NextResponse.json(
      { state: 'ready', band: entitled ? band : null, evidence },
      { status: 200, headers: { 'cache-control': PRIVATE_NO_STORE } },
    )
  } catch (error) {
    const code = (error as { code?: string })?.code ?? 'unknown'
    console.error(`GET /api/tenders/:id/band failed (${code})`)
    return fail({ state: 'error', error: 'server_error' }, 500)
  }
}
