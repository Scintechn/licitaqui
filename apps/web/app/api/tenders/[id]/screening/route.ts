import { NextResponse } from 'next/server'
import { sql } from 'drizzle-orm'
import {
  cnpjOf,
  planOf,
  readOrCreateViewer,
  readViewer,
  spenderOf,
  visitorWindow,
  type Viewer,
} from '@/lib/auth/viewer'
import { PRIVATE_NO_STORE } from '@/lib/cache'
import { db, type Executor } from '@/lib/db'
import { recordEventSafely } from '@/lib/events'
import type { ScreeningResponse } from '@/lib/radar/contract'
import type { ScreeningReadResponse } from '@/lib/radar/contract'
import { countUsage, FEATURES, hasSpentOn, quotaView, readLimit } from '@/lib/radar/quota'
import { readScreening, requestScreening } from '@/lib/radar/screening'
import {
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
 * U1 added accounts, and exactly as the note that stood here predicted, only
 * `plan` and `spender` changed: `lib/auth/viewer.ts` answers who is asking, the
 * plan is theirs rather than always `visitor`, and refusal 2 does not apply to
 * someone with an account — §10 gives the three days to "Visitante (sem
 * conta)". Nothing about the anonymous path moved.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The client polls this route's `GET` sibling, not this one. Twelve is plenty. */
const RATE_LIMIT = { limit: 12, windowMs: 60_000 }

/** The poll: §3.1's every-3-seconds for 60 s is twenty, plus room for a reload. */
const READ_RATE_LIMIT = { limit: 40, windowMs: 60_000 }

const TENDER_ID_RE = /^\d{14}-\d-\d{6}\/\d{4}$/

function fail<T extends ScreeningResponse | ScreeningReadResponse>(
  body: T,
  status: number,
  headers?: HeadersInit,
): NextResponse<T> {
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
    const viewer = await readOrCreateViewer(
      {
        cookieHeader: request.headers.get('cookie'),
        ip: request.headers.get('x-forwarded-for'),
        userAgent: request.headers.get('user-agent'),
      },
      executor,
    )

    const headers: Record<string, string> = { 'cache-control': PRIVATE_NO_STORE }
    if (viewer.kind === 'visitor' && viewer.visitor.isNew) {
      headers['set-cookie'] = visitorCookie(viewer.visitor.id)
    }

    const exists = await executor.execute<{ id: string }>(
      sql`select id from tenders where id = ${id}`,
    )
    if (!exists.rows[0]) {
      return fail({ state: 'error', error: 'not_found' }, 404, headers)
    }

    // The 3-day window belongs to "Visitante (sem conta)" (§10). An account has
    // a monthly quota and no expiry, so there is nothing to check for them.
    const startedAt = await windowStarted(viewer, executor)
    if (startedAt) {
      const days = await readLimit(VISITOR_PLAN, FEATURES.days, executor)
      const window = visitorView(startedAt, days.quantity ?? VISITOR_DAYS_FALLBACK, {
        used: 0,
        limit: null,
      })
      if (window.expired) {
        return fail({ state: 'error', error: 'visitor_expired' }, 403, headers)
      }
    }

    const outcome = await requestScreening(id, spenderOf(viewer), planOf(viewer), executor)

    if (outcome.state === 'quota_exceeded') {
      return fail({ state: 'error', error: 'quota_exceeded', quota: outcome.quota }, 402, headers)
    }

    // The banner canvas 02 and 04 both draw: the same window as above, now with
    // the screening count the spend just settled rather than the `0` the expiry
    // check did not need. `null` for an account — the banner is a visitor-only
    // affordance, which is why the contract has always had it nullable.
    const spent = outcome.state === 'ready' ? outcome.body.quota : outcome.quota
    const banner = startedAt
      ? await visitorWindow(viewer, startedAt, { used: spent.used, limit: spent.limit }, executor)
      : null

    await recordEventSafely({
      name: outcome.state === 'ready' ? 'screening_viewed' : 'screening_requested',
      userId: viewer.kind === 'user' ? viewer.user.userId : null,
      visitorId: viewer.kind === 'visitor' ? viewer.visitor.id : null,
      props: { tender_id: id, cached: outcome.state === 'ready' },
    })

    if (outcome.state === 'ready') {
      return NextResponse.json(
        { state: 'ready' as const, ...outcome.body, visitor: banner },
        { status: 200, headers },
      )
    }

    return NextResponse.json(
      {
        state: 'analyzing' as const,
        job: { id: outcome.job.id, kind: outcome.job.kind },
        quota: outcome.quota,
        visitor: banner,
      },
      { status: 202, headers },
    )
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'unknown'
    console.error(`POST /api/tenders/:id/screening failed (${code})`)
    return fail({ state: 'error', error: 'server_error' }, 500)
  }
}


/**
 * `GET /api/tenders/:id/screening` — the poll.
 *
 * `POST` is the request: it checks the quota, charges it and enqueues the job.
 * This is what the screen asks every three seconds afterwards, and it does
 * three things the `POST` must not do twenty times a minute — it never spends,
 * never enqueues, and never creates a visitor row (a `GET` that inserted would
 * let a crawler fill `visitors` one URL at a time, which is why `loadVisitor`
 * exists next to `loadOrCreateVisitor`).
 *
 * **It is not a way around the quota.** The analysis is cached and shared
 * across users (§3.2), so a `GET` that answered anybody would hand every
 * visitor every screening ever paid for, and §10 would mean nothing. So it
 * answers only a caller who already holds a `usage` row for *this* tender —
 * i.e. who already spent a screening on it through the `POST`. Anyone else
 * gets the same `404` as an id we hold no analysis for, which is also the
 * truth: there is nothing here that is theirs.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse<ScreeningReadResponse>> {
  const decision = rateLimitRequest('screening-read', request.headers, READ_RATE_LIMIT)
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
    const viewer = await readViewer(request.headers.get('cookie'), executor)
    if (!viewer) {
      return fail({ state: 'error', error: 'not_found' }, 404)
    }

    const spender = spenderOf(viewer)
    const limit = await readLimit(planOf(viewer), FEATURES.screening, executor)
    const paid = await hasSpentOn(spender, limit, id, executor)
    if (!paid) {
      return fail({ state: 'error', error: 'not_found' }, 404)
    }

    const used = await countUsage(spender, limit, executor)
    const startedAt = await windowStarted(viewer, executor)
    const window = startedAt
      ? await visitorWindow(viewer, startedAt, { used, limit: limit.quantity }, executor)
      : null

    const quota = quotaView(limit, used)
    const cached = await readScreening(id, executor)
    const headers = { 'cache-control': PRIVATE_NO_STORE }

    if (!cached) {
      return NextResponse.json(
        { state: 'pending' as const, tenderId: id, quota, visitor: window },
        { status: 200, headers },
      )
    }

    return NextResponse.json(
      {
        state: 'ready' as const,
        tenderId: id,
        status: cached.status,
        result: cached.result,
        citationCheck: cached.citationCheck,
        rules: cached.rules,
        createdAt: cached.createdAt.toISOString(),
        quota,
        visitor: window,
      },
      { status: 200, headers },
    )
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'unknown'
    console.error(`GET /api/tenders/:id/screening failed (${code})`)
    return fail({ state: 'error', error: 'server_error' }, 500)
  }
}

/**
 * When this caller's free window started, or `null` when they have an account.
 *
 * The earlier of the device's own `created_at` and the first time **any**
 * device searched their CNPJ (§8, decision 5 in §17) — the half of the rule
 * that an incognito window cannot undo.
 */
async function windowStarted(viewer: Viewer, executor: Executor): Promise<Date | null> {
  if (viewer.kind !== 'visitor') return null
  return windowStartedAt(viewer.visitor, cnpjOf(viewer), executor)
}
