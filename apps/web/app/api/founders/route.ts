import { NextResponse } from 'next/server'
import type { SignupError, SignupOk } from '@/lib/founders/contract'
import { fieldErrors, signupInput } from '@/lib/founders/input'
import { seatsLeft } from '@/lib/founders/seats'
import { signUpFounder } from '@/lib/founders/signup'
import { rateLimitRequest } from '@/lib/rate-limit'

/**
 * `POST /api/founders` (spec §8) — the founders list.
 *
 * Validates with Zod, rate limits per IP, assigns the seat inside the
 * transaction in `lib/founders/signup.ts`, writes the `events` row and enqueues
 * the WhatsApp welcome as a `send_whatsapp` job for task E2 and the e-mail
 * welcome as a `send_email` job for task E6. It sends nothing itself: §3's
 * rule is that no web request waits on an external service.
 *
 * Nothing about the person is ever logged (§12): failures log the shape of the
 * problem, never the body.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Six submissions a minute from one address. A person filling the form needs
 * one, and a mistyped e-mail plus two corrections is still three; a script
 * hits the wall immediately.
 */
const RATE_LIMIT = { limit: 6, windowMs: 60_000 }

function fail(error: SignupError, status: number, headers?: HeadersInit) {
  return NextResponse.json(error, { status, headers })
}

export async function POST(request: Request): Promise<NextResponse<SignupOk | SignupError>> {
  const decision = await rateLimitRequest('founders', request.headers, RATE_LIMIT)
  if (!decision.ok) {
    return fail({ status: 'error', error: 'rate_limited' }, 429, {
      'retry-after': String(decision.retryAfter),
    })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return fail({ status: 'error', error: 'bad_request' }, 400)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return fail({ status: 'error', error: 'bad_request' }, 400)
  }

  const parsed = signupInput.safeParse(body)
  if (!parsed.success) {
    return fail({ status: 'error', error: 'validation', fields: fieldErrors(parsed.error) }, 400)
  }

  try {
    const outcome = await signUpFounder(parsed.data)

    switch (outcome.status) {
      case 'seated':
        return NextResponse.json(
          {
            status: 'seated' as const,
            seat: outcome.seat,
            seatsTaken: outcome.seatsTaken,
            seatsLeft: seatsLeft(outcome.seatsTaken),
          },
          { status: 201 },
        )
      case 'waitlisted':
        return NextResponse.json(
          { status: 'waitlisted' as const, position: outcome.position },
          { status: 201 },
        )
      case 'already_registered':
        // Not an error: the person is on the list, which is what they wanted.
        // 200 rather than 201 — nothing was created, no second seat, no second
        // welcome message.
        return NextResponse.json(
          {
            status: 'already_registered' as const,
            seat: outcome.seat,
            position: outcome.position,
          },
          { status: 200 },
        )
    }
  } catch (error) {
    // The message may quote a column or a constraint, never a value: Postgres
    // errors here are `unique_violation` on `founders_list_seat_key` and the
    // like. Still, log only the code and the constraint, never the error body.
    const detail =
      error instanceof Error
        ? `${(error as Error & { code?: string }).code ?? 'unknown'} ${(error as Error & { constraint?: string }).constraint ?? ''}`.trim()
        : 'unknown'
    console.error(`POST /api/founders failed: ${detail}`)
    return fail({ status: 'error', error: 'server_error' }, 500)
  }
}

