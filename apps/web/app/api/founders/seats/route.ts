import { NextResponse } from 'next/server'
import type { SeatsResponse } from '@/lib/founders/contract'
import { FOUNDER_SEATS, seatsLeft, seatsTaken } from '@/lib/founders/seats'
import { countFounderSeatsTaken } from '@/lib/founders/signup'
import { rateLimitRequest } from '@/lib/rate-limit'

/**
 * `GET /api/founders/seats` (spec §8) — "Seats remaining (cache 60 s)".
 *
 * The offer page is statically rendered (§3.3), so the seat grid asks this
 * route for the live count once the page is in the browser. One indexed
 * `count(seat)` over at most 48 non-null values: cheap enough to serve on every
 * cold CDN miss.
 *
 * `s-maxage=60` is the 60 s of §8, and `stale-while-revalidate` means a burst of
 * traffic after a post never lands on the database more than once a minute. The
 * count is public — nothing personal is in the response.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const RATE_LIMIT = { limit: 120, windowMs: 60_000 }

export async function GET(request: Request): Promise<NextResponse<SeatsResponse | null>> {
  const decision = rateLimitRequest('founders-seats', request.headers, RATE_LIMIT)
  if (!decision.ok) {
    return NextResponse.json(null, {
      status: 429,
      headers: { 'retry-after': String(decision.retryAfter) },
    })
  }

  const taken = seatsTaken(await countFounderSeatsTaken())
  const body: SeatsResponse = {
    total: FOUNDER_SEATS,
    taken,
    left: seatsLeft(taken),
    soldOut: seatsLeft(taken) === 0,
  }

  return NextResponse.json(body, {
    headers: { 'cache-control': 'public, s-maxage=60, stale-while-revalidate=300' },
  })
}
