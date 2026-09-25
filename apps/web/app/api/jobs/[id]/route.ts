import { NextResponse } from 'next/server'
import { PRIVATE_NO_STORE } from '@/lib/cache'
import type { JobResponse } from '@/lib/radar/contract'
import { readJob } from '@/lib/jobs'
import { rateLimitRequest } from '@/lib/rate-limit'

/**
 * `GET /api/jobs/:id` (spec §8) — what the "analyzing" screen polls.
 *
 * §3.1: "The client polls every 3 s (max 60 s)". Twenty polls per job, and the
 * screen may be showing two at once, so the limit below is generous where the
 * others are not.
 *
 * ## "owner"
 *
 * §8 says the caller must own the job, and nothing in `jobs` records an owner:
 * the table has `kind`, `key`, `payload` and no user column, and adding one is
 * a migration, which is another PR by the rules in CLAUDE.md. So ownership is
 * enforced by **giving the response nothing worth owning**: an id, a kind, a
 * status, an attempt count and two timestamps.
 *
 * What is deliberately not here is the point of the design:
 *
 *  - `payload` — a `company_lookup`'s payload is a CNPJ (§12);
 *  - `key` — a `screening:` key names a tender, but a `company:` key is a
 *    digest whose presence still confirms that *somebody* searched that CNPJ;
 *  - `error` — whatever PNCP, BrasilAPI or OpenRouter last said, which is the
 *    last text in this system that should reach an unauthenticated poller.
 *
 * And the projection is restricted to the three kinds the web itself creates,
 * so the route cannot be walked to enumerate the worker's queue.
 *
 * When U1 brings sessions and a migration gives `jobs` a requester, this
 * becomes a real ownership check and the projection can grow.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** 20 polls per job over 60 s, times a few screens, with room to spare. */
const RATE_LIMIT = { limit: 120, windowMs: 60_000 }

function fail(body: JobResponse, status: number, headers?: HeadersInit) {
  return NextResponse.json(body, {
    status,
    headers: { 'cache-control': PRIVATE_NO_STORE, ...headers },
  })
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse<JobResponse>> {
  const decision = await rateLimitRequest('jobs', request.headers, RATE_LIMIT)
  if (!decision.ok) {
    return fail({ state: 'error', error: 'rate_limited' }, 429, {
      'retry-after': String(decision.retryAfter),
    })
  }

  const { id } = await context.params
  const jobId = Number(id)
  if (!Number.isSafeInteger(jobId) || jobId <= 0) {
    return fail({ state: 'error', error: 'validation', fields: { id: 'jobIdInvalid' } }, 400)
  }

  try {
    const job = await readJob(jobId)
    if (!job) {
      return fail({ state: 'error', error: 'not_found' }, 404)
    }
    return NextResponse.json(
      { state: 'ready' as const, job },
      { status: 200, headers: { 'cache-control': PRIVATE_NO_STORE } },
    )
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'unknown'
    console.error(`GET /api/jobs/:id failed (${code})`)
    return fail({ state: 'error', error: 'server_error' }, 500)
  }
}
