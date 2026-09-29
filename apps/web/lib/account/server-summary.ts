import { headers } from 'next/headers'
import { planOf, readViewer } from '@/lib/auth/viewer'
import { db } from '@/lib/db'
import { readAccountSummary, type AccountSummary } from './summary'

/**
 * This viewer's plan, triagens and alerts — read **on the server**, once, for
 * the shell that draws them.
 *
 * ## Why not `GET /api/conta/resumo`
 *
 * That route exists and is correct, and `radar-screen.tsx` fetches it from the
 * client into `useState`. For a screen that was already mounted that is fine.
 * For the **shell**, which is the first thing painted on every signed-in route,
 * it is the same mistake the price band's entitlement made: the answer arrives
 * after the page does, so the rail renders empty and then fills, and "am I
 * signed in?" — the question D20 exists to answer — is unanswered for exactly
 * as long as the round trip takes.
 *
 * The layout is a server component. It already has the request. It can simply
 * know.
 *
 * ## The raw header, and why that is stated
 *
 * `headers().get('cookie')`, not `cookies()`. On 2026-09-29 a sibling reader
 * rebuilt the header from `cookies().getAll()`, whose values come back
 * **already percent-decoded**, and `sessionTokenFromCookies` decodes every
 * value it walks past before checking the name — so one unrelated cookie
 * containing `%25` threw `URIError` and a paying subscriber was told they had
 * no plan. The raw header has no such problem and is what `readViewer` takes.
 *
 * ## A failed read is a visitor, not an error
 *
 * The shell must render. A person whose summary could not be read still needs
 * the links, and `MenuView` already draws the visitor strip when `summary` is
 * `null` — "what a visitor has, and the account offered instead of the
 * upgrade". Throwing here would blank the navigation on every signed-in route
 * the moment the database blinked.
 *
 * Nothing here mints an identity: `readViewer` never creates a visitor row.
 */
export async function readShellSummary(): Promise<AccountSummary | null> {
  try {
    const executor = db()
    const viewer = await readViewer((await headers()).get('cookie'), executor)
    return await readAccountSummary(
      viewer === null
        ? null
        : viewer.kind === 'user'
          ? { userId: viewer.user.userId }
          : { visitorId: viewer.visitor.id },
      planOf(viewer),
      executor,
    )
  } catch {
    return null
  }
}
