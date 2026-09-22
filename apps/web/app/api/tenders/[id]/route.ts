import { NextResponse } from 'next/server'
import { cnpjOf, hasAccount, planOf, readViewer, spenderOf } from '@/lib/auth/viewer'
import { PRIVATE_NO_STORE } from '@/lib/cache'
import { db } from '@/lib/db'
import { recordEventSafely } from '@/lib/events'
import { readCompany } from '@/lib/radar/company'
import type { TenderResponse } from '@/lib/radar/contract'
import { FEATURES, readLimit } from '@/lib/radar/quota'
import { screeningAvailability } from '@/lib/radar/screening'
import { tenderOrRefresh } from '@/lib/radar/tender'
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
 * U1 landed and that is exactly what happened: `withFiles` is now
 * `hasAccount(viewer)` and nothing else changed. A visitor still gets `null`
 * and still sees the locked block; a signed-in user on Básico gets the edital
 * and its annexes, which is the row §10 grants "com conta".
 *
 * ## Why the screening state rides along here
 *
 * The screen's call to action has to be right on **first paint** — a button
 * that says "Ver triagem por IA" and then changes its mind under the user's
 * finger is worse than one that is merely wrong. A second request could not
 * promise that, and this route is already the one query the list does not
 * make, so `screeningAvailability` joins it: two small reads on a route that
 * was doing three, against one extra round trip plus a render the user watches
 * change. It is read-only and spends nothing.
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
    const executor = db()
    // Read only: a GET never mints an identity (see `readViewer`).
    const viewer = await readViewer(request.headers.get('cookie'), executor)
    const headers: Record<string, string> = { 'cache-control': PRIVATE_NO_STORE }

    const cnpj = cnpjOf(viewer)
    const company = cnpj ? await readCompany(cnpj, executor) : null

    const cached = await tenderOrRefresh(id, {
      // §8: "files only with an account".
      withFiles: hasAccount(viewer),
      fits: company?.data.company.segments ?? [],
      executor,
    })

    const tender = cached.data
    if (!tender) {
      // `sync_items` cannot invent a header, so there is nothing to wait for:
      // an id we hold no row for is a 404, never an "analyzing" promise.
      return fail({ state: 'error', error: 'not_found' }, 404, headers)
    }

    // What the CTA needs to be honest: whether a reading of *this* edital
    // exists, and whether this caller has already paid for it (§3.2, §10).
    const spender = viewer ? spenderOf(viewer) : null
    const limit = await readLimit(planOf(viewer), FEATURES.screening, executor)
    const screening = await screeningAvailability(id, spender, limit, executor)

    await recordEventSafely({
      name: 'tender_opened',
      userId: viewer?.kind === 'user' ? viewer.user.userId : null,
      visitorId: viewer?.kind === 'visitor' ? viewer.visitor.id : null,
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
        screening,
      },
      { status: 200, headers },
    )
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'unknown'
    console.error(`GET /api/tenders/:id failed (${code})`)
    return fail({ state: 'error', error: 'server_error' }, 500)
  }
}
