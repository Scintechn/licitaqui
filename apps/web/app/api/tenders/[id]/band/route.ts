import { NextResponse } from 'next/server'
import { PRIVATE_NO_STORE } from '@/lib/cache'
import { db } from '@/lib/db'
import { comparablesForItem } from '@/lib/radar/comparables'
import type { BandResponse } from '@/lib/radar/contract'
import { priceBand } from '@/lib/radar/price-band'
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
 * ## It spends nothing and reveals nothing
 *
 * Read-only, no viewer, no screening, no account check. The band is computed
 * from `awards`, which is public procurement history — PNCP publishes every
 * winner. Nothing here is gated on a plan, so no identity is read and no
 * cookie is touched.
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
    const comparables = await comparablesForItem(id, item, db())
    return NextResponse.json(
      { state: 'ready', band: priceBand(comparables) },
      { status: 200, headers: { 'cache-control': PRIVATE_NO_STORE } },
    )
  } catch (error) {
    const code = (error as { code?: string })?.code ?? 'unknown'
    console.error(`GET /api/tenders/:id/band failed (${code})`)
    return fail({ state: 'error', error: 'server_error' }, 500)
  }
}
