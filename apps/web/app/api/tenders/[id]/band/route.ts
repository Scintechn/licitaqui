import { NextResponse } from 'next/server'
import { planOf, readViewer } from '@/lib/auth/viewer'
import { PRIVATE_NO_STORE } from '@/lib/cache'
import { db } from '@/lib/db'
import { catalogBandForItem, catalogEvidenceForItem } from '@/lib/radar/catalog-band'
import type { BandResponse } from '@/lib/radar/contract'
import { fallbackEvidenceForItem } from '@/lib/radar/fallback-evidence'
import { withoutPrices } from '@/lib/radar/price-band'
import { hasPriceBand } from '@/lib/radar/quota'
import { rateLimitRequest } from '@/lib/rate-limit'

/**
 * `GET /api/tenders/:id/band?item=N` (E9) — the price band for one item.
 *
 * ## Why this is its own route
 *
 * `GET /api/tenders/:id` is the Opportunity screen's read, and the price
 * screen is not the only caller. The original reason was cost — folding the
 * band in made every opportunity view pay for a trigram join to compute a
 * number that screen never shows — and **since B35 that reason is gone**: both
 * rungs are primary-key reads now. What remains is shape: the band is *per
 * item*, the Opportunity read is *per tender*, and a tender carries hundreds of
 * items. One item, one request, only when the price block is open.
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
    // The cost is a trigram query for every caller on an item the catalogue
    // misses, which is most of them. B35 had briefly made this cheap — two
    // primary-key reads — and **D40 gave the cost back deliberately**, because
    // the thing it bought was blank screens. The claim is unchanged either way:
    // what is computed before the plan is consulted is whether a number exists.
    // **The band is still two primary-key reads** (B35).
    //
    // They were one read when both came from the same trigram join. They are
    // separate now because the band is *stored per catalogue code* while the
    // evidence is *the rows it was computed from*, and the rung exists
    // precisely where the band does not: 947 of 1 028 codes are refused for
    // `spread_too_wide` — the purchases exist and disagree with each other —
    // and a reader should see what we found on every one of those items.
    //
    // Neither statement uses `similarity()` and neither calls an API, which is
    // B35's acceptance criterion — and that criterion is about **the band**,
    // which is why it still holds below.
    const reading = await catalogBandForItem(id, item, executor)
    const band = reading === null ? null : reading.band
    const catalogue = await catalogEvidenceForItem(id, item, executor)

    /**
     * **The fallback rung, and the one line that makes a band over it
     * impossible** (D40).
     *
     * Sci, 2026-10-05: *"the application should present the data from previous
     * won tenders, for Services or Product."* The catalogue reaches an item
     * only through `rule = 'exact'` **and** `kind = 'M'`, and most open items
     * fail one of those — every service, because `refresh_catalog_prices`
     * gives services no budget and `catalog_prices` holds no `kind = 'S'` row
     * at all, plus the 143 506 `no_match` and 156 013 `prefix` materials. All
     * of them showed past winners before B35 and nothing after it.
     * `fallback-evidence.ts` carries the measurement and the reasoning.
     *
     * **`band === null` is the guard, and it is the whole guarantee.** The
     * fallback is only consulted where the catalogue produced neither a band
     * nor prices, so there is no state in which the band on the wire was
     * computed from one corpus and the results under it came from another —
     * which is the failure a reader could not possibly detect, because the
     * screen would be drawing a catalogue band over trigram evidence and
     * calling it the same number. `fallbackEvidenceForItem` returns a type
     * with no band field and never calls `priceBand`, so it cannot create one
     * either; this line stops it from ever standing beside one.
     *
     * The cost is `comparablesForItem` back on the request path — median
     * 412 ms, worst 2 715 ms, measured 2026-09-28 — for the large majority of
     * items, and still before the plan is consulted, because evidence is free
     * at every rung. **B21** (the trigram index and the caching decision) is
     * load-bearing again rather than an optimisation.
     */
    const evidence =
      band === null && catalogue === null
        ? await fallbackEvidenceForItem(id, item, executor)
        : catalogue

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
        //
        // **`catalogue`, not `evidence`** (D40). This branch is reached only
        // where a band exists, and `evidence` is `catalogue` there by the guard
        // above — so the two are equal today and naming the narrower one keeps
        // them equal. `LockedEvidence` drops `source`, so a fallback rung
        // reaching here would arrive labelled as nothing and read as the
        // identity claim this card exists to stop.
        { state: 'locked', evidence: catalogue === null ? null : withoutPrices(catalogue) },
        { status: 200, headers: { 'cache-control': PRIVATE_NO_STORE } },
      )
    }

    // No `entitled` on the wire: the screen reads entitlement on the server
    // before it renders (`readPriceBandEntitlement`), so carrying it here
    // would be a second source of truth for the same question. It was also the
    // slower of the two when this answer sat behind a trigram join; B35 made it
    // two index reads, so only the one-source-of-truth reason is left. The gate
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
