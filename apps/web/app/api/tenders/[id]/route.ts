import { NextResponse } from 'next/server'
import { PRIVATE_NO_STORE } from '@/lib/cache'
import { db } from '@/lib/db'
import { recordEventSafely } from '@/lib/events'
import { readCompany } from '@/lib/radar/company'
import type { TenderResponse } from '@/lib/radar/contract'
import { tenderOrRefresh } from '@/lib/radar/tender'
import { loadVisitor } from '@/lib/radar/visitor'
import { rateLimitRequest } from '@/lib/rate-limit'

/**
 * `GET /api/tenders/:id` (spec §8) — the Opportunity screen.
 *
 * > Header + items; files only with an account
 *
 * The locked block is enforced here, not in the UI: with no account the query
 * for `tender_files` is not run at all, so no response can carry an edital URL
 * to someone who has not signed up. `files: null` is what the design system
 * draws the locked block from; `files: []` would mean the agency published
 * nothing, which is a different thing to tell a user.
 *
 * Accounts arrive with task U1. Until then every request is a visitor and
 * `files` is always `null`; when U1 lands, the one line below that decides
 * `withFiles` is where the session is read.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RATE_LIMIT = { limit: 120, windowMs: 60_000 }

/** PNCP's `numeroControlePNCP`: `<14 digits>-<1 digit>-<6 digits>/<year>`. */
const TENDER_ID_RE = /^\d{14}-\d-\d{6}\/\d{4}$/

function fail(body: TenderResponse, status: number, headers?: HeadersInit) {
  return NextResponse.json(body, {
    status,
    headers: { 'cache-control': PRIVATE_NO_STORE, ...headers },
  })
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse<TenderResponse>> {
  const decision = rateLimitRequest('tender-detail', request.headers, RATE_LIMIT)
  if (!decision.ok) {
    return fail({ state: 'error', error: 'rate_limited' }, 429, {
      'retry-after': String(decision.retryAfter),
    })
  }

  const { id } = await context.params
  if (!TENDER_ID_RE.test(id)) {
    return fail({ state: 'error', error: 'validation', fields: { id: 'tenderIdInvalid' } }, 400)
  }

  try {
    // Read only: a GET never mints an identity (see `loadVisitor`).
    const visitor = await loadVisitor(request.headers.get('cookie'))
    const headers: Record<string, string> = { 'cache-control': PRIVATE_NO_STORE }

    const executor = db()
    const company = visitor?.cnpj ? await readCompany(visitor.cnpj, executor) : null

    const cached = await tenderOrRefresh(id, {
      // Task U1 replaces this with "the request has a session".
      withFiles: false,
      fits: company?.data.company.segments ?? [],
      executor,
    })

    const tender = cached.data
    if (!tender) {
      // `sync_items` cannot invent a header, so there is nothing to wait for:
      // an id we hold no row for is a 404, never an "analyzing" promise.
      return fail({ state: 'error', error: 'not_found' }, 404, headers)
    }

    await recordEventSafely({
      name: 'tender_opened',
      visitorId: visitor?.id ?? null,
      props: { tender_id: id, cache: cached.state },
    })

    return NextResponse.json(
      {
        state: 'ready' as const,
        tender,
        freshness: {
          state: cached.state === 'fresh' ? ('fresh' as const) : ('stale' as const),
          updatedAt: cached.updatedAt?.toISOString() ?? null,
          ageSeconds: cached.ageSeconds,
        },
      },
      { status: 200, headers },
    )
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'unknown'
    console.error(`GET /api/tenders/:id failed (${code})`)
    return fail({ state: 'error', error: 'server_error' }, 500)
  }
}
