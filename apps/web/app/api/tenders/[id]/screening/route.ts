import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import { PRIVATE_NO_STORE } from '@/lib/cache'
import { db } from '@/lib/db'
import { recordEventSafely } from '@/lib/events'
import type { ScreeningResponse } from '@/lib/radar/contract'
import { FEATURES, readLimit } from '@/lib/radar/quota'
import { requestScreening } from '@/lib/radar/screening'
import {
  loadOrCreateVisitor,
  visitorCookie,
  visitorView,
  VISITOR_DAYS_FALLBACK,
  VISITOR_PLAN,
  windowStartedAt,
} from '@/lib/radar/visitor'
import { rateLimitRequest } from '@/lib/rate-limit'

/**
 * `POST /api/tenders/:id/screening` (spec §8, §10) — request a triagem.
 *
 * > Checks quota → if an analysis for the current version exists, returns it
 * > and records usage; otherwise priority-1 job → 202
 *
 * Three refusals before anything is spent, in this order:
 *
 * 1. **the tender must exist** — a screening for an id we hold no row for would
 *    queue an `ai_screening` the worker cannot serve;
 * 2. **the visitor's three days must not be up** (§10, decision 5 in §17) —
 *    counted per device *and* per CNPJ, so an incognito window is not a reset;
 * 3. **the quota** — `plan_limits` + `usage`, checked and charged in one
 *    statement so a race cannot spend the same last screening twice.
 *
 * Accounts are task U1. Every caller is a visitor for now, which is the
 * strictest of the plans (2 total, not 5 a month), so nothing here has to be
 * loosened when sessions arrive — only `plan` and `spender` change.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The client polls this route's `GET` sibling, not this one. Twelve is plenty. */
const RATE_LIMIT = { limit: 12, windowMs: 60_000 }

const TENDER_ID_RE = /^\d{14}-\d-\d{6}\/\d{4}$/

function fail(body: ScreeningResponse, status: number, headers?: HeadersInit) {
  return NextResponse.json(body, {
    status,
    headers: { 'cache-control': PRIVATE_NO_STORE, ...headers },
  })
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse<ScreeningResponse>> {
  const decision = rateLimitRequest('screening', request.headers, RATE_LIMIT)
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
    const visitor = await loadOrCreateVisitor({
      cookieHeader: request.headers.get('cookie'),
      ip: request.headers.get('x-forwarded-for'),
      userAgent: request.headers.get('user-agent'),
    })

    const headers: Record<string, string> = { 'cache-control': PRIVATE_NO_STORE }
    if (visitor.isNew) headers['set-cookie'] = visitorCookie(visitor.id)

    const exists = await executor.execute<{ id: string }>(
      sql`select id from tenders where id = ${id}`,
    )
    if (!exists.rows[0]) {
      return fail({ state: 'error', error: 'not_found' }, 404, headers)
    }

    const days = await readLimit(VISITOR_PLAN, FEATURES.days, executor)
    const startedAt = await windowStartedAt(visitor, visitor.cnpj, executor)
    const window = visitorView(startedAt, days.quantity ?? VISITOR_DAYS_FALLBACK, {
      used: 0,
      limit: null,
    })
    if (window.expired) {
      return fail({ state: 'error', error: 'visitor_expired' }, 403, headers)
    }

    const outcome = await requestScreening(id, { visitorId: visitor.id }, VISITOR_PLAN, executor)

    if (outcome.state === 'quota_exceeded') {
      return fail({ state: 'error', error: 'quota_exceeded', quota: outcome.quota }, 402, headers)
    }

    await recordEventSafely({
      name: outcome.state === 'ready' ? 'screening_viewed' : 'screening_requested',
      visitorId: visitor.id,
      props: { tender_id: id, cached: outcome.state === 'ready' },
    })

    if (outcome.state === 'ready') {
      return NextResponse.json({ state: 'ready' as const, ...outcome.body }, { status: 200, headers })
    }

    return NextResponse.json(
      {
        state: 'analyzing' as const,
        job: { id: outcome.job.id, kind: outcome.job.kind },
        quota: outcome.quota,
      },
      { status: 202, headers },
    )
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'unknown'
    console.error(`POST /api/tenders/:id/screening failed (${code})`)
    return fail({ state: 'error', error: 'server_error' }, 500)
  }
}
