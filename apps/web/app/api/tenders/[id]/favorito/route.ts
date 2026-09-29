import { NextResponse } from 'next/server'
import { hasAccount, readViewer } from '@/lib/auth/viewer'
import { PRIVATE_NO_STORE } from '@/lib/cache'
import { db } from '@/lib/db'
import { isFavourite, toggleFavourite } from '@/lib/favourites/store'
import { rateLimitRequest } from '@/lib/rate-limit'

/**
 * `POST /api/tenders/:id/favorito` — mark or unmark, and say what it became
 * (card **D23**).
 *
 * ## An account, not a visitor
 *
 * The only route in the Radar that refuses a visitor outright. Everything else
 * degrades — anonymous browsing keeps working, screenings spend a visitor
 * quota — because §8's rule is that an account *adds capability* and is never
 * a precondition. A favourite is the exception by construction: it is a row
 * keyed on `users.id`, so there is nowhere to put one for somebody who has no
 * account. `401` rather than silently doing nothing, because a control that
 * accepts a tap and forgets it is worse than one that says why.
 *
 * ## `POST`, and one statement
 *
 * `toggleFavourite` is `delete … returning` and only inserts when nothing was
 * removed. A read-then-write would leave a window in which two taps both see
 * "not marked", the second insert is a no-op, and the button then reads
 * *Favoritar* on a tender that is marked. That window is exactly the
 * double-tap this control invites on a slow connection.
 *
 * ## It spends nothing
 *
 * No `usage` row, no screening, no plan check. Marking is free on every plan —
 * `plan_limits` has no `favourite` feature and deliberately so, because a cap
 * on remembering things is a cap nobody would understand.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Generous: this is a tap, and a person may mark a page of results quickly. */
const RATE_LIMIT = { limit: 60, windowMs: 60_000 }

/** PNCP's `numeroControlePNCP`: `<14 digits>-<1 digit>-<6 digits>/<year>`. */
const TENDER_ID_RE = /^\d{14}-\d-\d{6}\/\d{4}$/

export type FavouriteResponse =
  | { state: 'ready'; favourite: boolean }
  | { state: 'error'; error: 'rate_limited' | 'validation' | 'unauthenticated' | 'server_error' }

function fail(body: FavouriteResponse, status: number, headers?: HeadersInit) {
  return NextResponse.json(body, {
    status,
    headers: { 'cache-control': PRIVATE_NO_STORE, ...headers },
  })
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse<FavouriteResponse>> {
  const decision = await rateLimitRequest('tender-favourite', request.headers, RATE_LIMIT)
  if (!decision.ok) {
    return fail({ state: 'error', error: 'rate_limited' }, 429, {
      'retry-after': String(decision.retryAfter),
    })
  }

  const { id } = await context.params
  if (!TENDER_ID_RE.test(id)) {
    return fail({ state: 'error', error: 'validation' }, 400)
  }

  try {
    const executor = db()
    const viewer = await readViewer(request.headers.get('cookie'), executor)
    if (!hasAccount(viewer) || viewer?.kind !== 'user') {
      return fail({ state: 'error', error: 'unauthenticated' }, 401)
    }

    const favourite = await toggleFavourite(viewer.user.userId, id, executor)
    return NextResponse.json(
      { state: 'ready', favourite },
      { status: 200, headers: { 'cache-control': PRIVATE_NO_STORE } },
    )
  } catch (error) {
    const code = (error as { code?: string })?.code ?? 'unknown'
    // **Not the message.** A foreign-key violation names the table and the
    // constraint, and a 500 body is the one place that reliably reaches a
    // stranger.
    console.error(`POST /api/tenders/:id/favorito failed (${code})`)
    return fail({ state: 'error', error: 'server_error' }, 500)
  }
}

/** Whether this account has marked it — what the control renders on arrival. */
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse<FavouriteResponse>> {
  const { id } = await context.params
  if (!TENDER_ID_RE.test(id)) {
    return fail({ state: 'error', error: 'validation' }, 400)
  }

  try {
    const executor = db()
    const viewer = await readViewer(request.headers.get('cookie'), executor)
    // A visitor has no favourites rather than an error: the control renders
    // unmarked and the POST is what tells them they need an account.
    if (!hasAccount(viewer) || viewer?.kind !== 'user') {
      return NextResponse.json(
        { state: 'ready', favourite: false },
        { status: 200, headers: { 'cache-control': PRIVATE_NO_STORE } },
      )
    }

    const favourite = await isFavourite(viewer.user.userId, id, executor)
    return NextResponse.json(
      { state: 'ready', favourite },
      { status: 200, headers: { 'cache-control': PRIVATE_NO_STORE } },
    )
  } catch {
    return fail({ state: 'error', error: 'server_error' }, 500)
  }
}
