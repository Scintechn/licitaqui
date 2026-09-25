import { NextResponse } from 'next/server'
import { z } from 'zod'
import { rememberUserCnpj } from '@/lib/auth/session'
import { readOrCreateViewer, visitorWindow, type Viewer } from '@/lib/auth/viewer'
import { PRIVATE_NO_STORE } from '@/lib/cache'
import { normaliseCnpj } from '@/lib/cnpj'
import { db } from '@/lib/db'
import { recordEventSafely } from '@/lib/events'
import { companyOrLookup } from '@/lib/radar/company'
import type { CnpjResponse } from '@/lib/radar/contract'
import { countUsage, FEATURES, readLimit } from '@/lib/radar/quota'
import { attachCnpj, visitorCookie, VISITOR_PLAN, windowStartedAt } from '@/lib/radar/visitor'
import { rateLimitRequest } from '@/lib/rate-limit'

/**
 * `POST /api/radar/cnpj` (spec §8) — the Radar's front door.
 *
 * > Creates or reads visitor (cookie), reads `companies`; if missing,
 * > `company_lookup` job → 202
 *
 * The route does three things and no more: identify the device, run the CNPJ
 * through `readOrEnqueue()`, and say which of the three states came back. It
 * calls BrasilAPI never — that is the whole point of §3's golden rule, and the
 * reason the first search of a CNPJ answers `202` instead of waiting on an API
 * with no SLA (§9).
 *
 * ## LGPD
 *
 * A CNPJ is written to `visitors.cnpj` and passed to the job payload. It is
 * never logged, never put in an `events.props`, and never echoed in an error.
 * The failure log below carries a Postgres error code and nothing else.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** A person types one CNPJ and maybe corrects it. Thirty a minute is a script. */
const RATE_LIMIT = { limit: 30, windowMs: 60_000 }

const input = z.object({
  cnpj: z
    .string({ error: 'cnpjInvalid' })
    .transform((value) => normaliseCnpj(value))
    .refine((value): value is string => value !== null, { message: 'cnpjInvalid' }),
})

function fail(body: CnpjResponse, status: number, headers?: HeadersInit) {
  return NextResponse.json(body, { status, headers: { 'cache-control': PRIVATE_NO_STORE, ...headers } })
}

export async function POST(request: Request): Promise<NextResponse<CnpjResponse>> {
  const decision = await rateLimitRequest('radar-cnpj', request.headers, RATE_LIMIT)
  if (!decision.ok) {
    return fail({ state: 'error', error: 'rate_limited' }, 429, {
      'retry-after': String(decision.retryAfter),
    })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return fail({ state: 'error', error: 'bad_request' }, 400)
  }

  const parsed = input.safeParse(body)
  if (!parsed.success) {
    return fail(
      { state: 'error', error: 'validation', fields: { cnpj: parsed.error.issues[0]?.message ?? 'cnpjInvalid' } },
      400,
    )
  }
  const { cnpj } = parsed.data

  try {
    const viewer = await readOrCreateViewer({
      cookieHeader: request.headers.get('cookie'),
      ip: request.headers.get('x-forwarded-for'),
      userAgent: request.headers.get('user-agent'),
    })
    // Where the CNPJ is remembered depends on who asked: a device remembers it
    // on its `visitors` row, which is what carries the 3-day clock across an
    // incognito window; an account remembers it on `users.cnpj` (§6.2), which
    // is what E1's weekly digest will search for.
    if (viewer.kind === 'visitor') await attachCnpj(viewer.visitor.id, cnpj)

    const cached = await companyOrLookup(cnpj)

    // §14's `cnpj_searched` gate metric. The CNPJ itself stays out of `props`:
    // `visitors.cnpj` already holds it and the gate only counts searches.
    await recordEventSafely({
      name: 'cnpj_searched',
      userId: viewer.kind === 'user' ? viewer.user.userId : null,
      visitorId: viewer.kind === 'visitor' ? viewer.visitor.id : null,
      props: { cache: cached.state, manual_cnae: cached.data?.manualCnae ?? null },
    })

    const headers: Record<string, string> = { 'cache-control': PRIVATE_NO_STORE }
    if (viewer.kind === 'visitor' && viewer.visitor.isNew) {
      headers['set-cookie'] = visitorCookie(viewer.visitor.id)
    }

    const found = cached.data
    if (cached.state === 'absent' || !found) {
      return NextResponse.json(
        { state: 'analyzing' as const, job: { id: cached.job?.id ?? null, kind: 'company_lookup' } },
        { status: 202, headers },
      )
    }

    if (viewer.kind === 'user') await rememberUserCnpj(viewer.user.userId, cnpj)
    const view = await describeVisitor(viewer, cnpj)

    return NextResponse.json(
      {
        state: 'ready' as const,
        company: found.company,
        manualCnae: found.manualCnae,
        freshness: {
          state: cached.state,
          updatedAt: cached.updatedAt?.toISOString() ?? null,
          ageSeconds: cached.ageSeconds,
        },
        visitor: view,
      },
      { status: 200, headers },
    )
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'unknown'
    console.error(`POST /api/radar/cnpj failed (${code})`)
    return fail({ state: 'error', error: 'server_error' }, 500)
  }
}

/**
 * The visitor's remaining window: §10's three days and two screenings, both
 * read from `plan_limits` so they are configurable without a deploy (§6.2).
 *
 * The window starts at the earlier of this device's `created_at` and the first
 * time any device searched this CNPJ — decision 5 in §17, which is what stops
 * an incognito window from being a reset button.
 *
 * `null` for a signed-in account: §10 gives the three days to "Visitante (sem
 * conta)", and the banner the Radar draws from this is a visitor affordance.
 */
async function describeVisitor(viewer: Viewer, cnpj: string) {
  if (viewer.kind !== 'visitor') return null
  const executor = db()
  const screenings = await readLimit(VISITOR_PLAN, FEATURES.screening, executor)
  const [startedAt, used] = await Promise.all([
    windowStartedAt(viewer.visitor, cnpj, executor),
    countUsage({ visitorId: viewer.visitor.id }, screenings, executor),
  ])
  return visitorWindow(viewer, startedAt, { used, limit: screenings.quantity }, executor)
}
