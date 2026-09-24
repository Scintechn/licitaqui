import { NextResponse } from 'next/server'
import { readAccountSummary, type AccountSummary } from '@/lib/account/summary'
import { planOf, readViewer } from '@/lib/auth/viewer'
import { db } from '@/lib/db'
import { rateLimitRequest } from '@/lib/rate-limit'

/**
 * `GET /api/conta/resumo` — the plan strip at the foot of the menu (card D5).
 *
 * ## Why a route and not a server component
 *
 * The screens that need it — the Radar, a tender, a triagem — are client
 * components, and the menu is a drawer they open rather than a page they
 * navigate to. Rendering the strip into every one of them would put two extra
 * database reads on the critical path of every screen, to fill a panel most
 * visits never open.
 *
 * So the menu asks for this **when it opens**, once, and shows its own
 * loading state until the answer lands. The two reads are cheap and indexed
 * (`plan_limits` by `(plan, feature)`, `usage` by spender) and they happen at
 * the moment somebody has asked to see them.
 *
 * ## It answers for a visitor too
 *
 * There is no 401 here. Somebody with no account still has a plan, an
 * allowance and a window, and the strip exists to tell them — a menu that
 * goes blank for the people most likely to open it would reproduce the gap
 * this card was written to close. `readViewer` returns `null` only when there
 * is no cookie at all, and even then the `visitor` plan's limits are the
 * honest answer.
 *
 * ## LGPD §12
 *
 * Nothing identifying is returned: a plan name, two quotas and a seat number.
 * No CNPJ, no e-mail, no name. The seat is the founder's own number, which
 * `/conta` already shows them.
 */

export const dynamic = 'force-dynamic'

const RATE_LIMIT = { limit: 60, windowMs: 60_000 }

export async function GET(request: Request): Promise<NextResponse<AccountSummary | { error: string }>> {
  const decision = rateLimitRequest('conta-resumo', request.headers, RATE_LIMIT)
  if (!decision.ok) {
    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'retry-after': String(decision.retryAfter) } },
    )
  }

  const executor = db()
  const viewer = await readViewer(request.headers.get('cookie'), executor)
  const summary = await readAccountSummary(
    viewer === null
      ? null
      : viewer.kind === 'user'
        ? { userId: viewer.user.userId }
        : { visitorId: viewer.visitor.id },
    planOf(viewer),
    executor,
  )

  // Never cached, by anything. It is per-viewer and it changes the moment a
  // triagem is spent.
  return NextResponse.json(summary, { headers: { 'cache-control': 'private, no-store' } })
}
