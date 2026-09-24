import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'
import { countUsage, FEATURES, quotaView, readLimit, type Spender } from '@/lib/radar/quota'
import type { QuotaView } from '@/lib/radar/contract'

/**
 * What the menu's plan strip says, and what `/conta` already said.
 *
 * ## Why this exists as its own module
 *
 * `app/conta/page.tsx` has computed exactly these numbers since it was
 * written — plan, screening limit, screenings used, founder seat — and nothing
 * else could reach them. So a signed-in person could see their plan on
 * `/conta` and nowhere else, while every screen they actually use (the Radar,
 * a tender, a triagem) showed no plan, no allowance and no sign that they were
 * signed in at all. Canvas 09 (`docs/design/wireframes/Menu.dc.html`) was
 * drawn to fix that and was never carded — see D5.
 *
 * Two callers now want the same four facts, so the read moves here rather than
 * being written a second time. A second copy is how `ScreeningAvailability`
 * ended up declared twice and drifting.
 *
 * ## The visitor is not an error case
 *
 * Somebody with no session still has a plan (`visitor`), an allowance (2
 * triagens, total rather than monthly) and a window. The strip must say so
 * rather than render nothing — a menu that goes blank for the people most
 * likely to open it is the state this card exists to remove.
 *
 * ## The alert cadence
 *
 * Read from `plan_limits` like everything else, never from a literal. It is
 * the number `/fundadores` advertises, and `plan_limits` currently holds an
 * `alert` row for `basico` alone — so a paid plan answers `quantity: 0` here,
 * which is the true and uncomfortable answer, and card D6 is where it gets
 * fixed. This module's job is to report it, not to paper over it.
 */

export type AccountSummary = {
  /** `visitor`, `basico`, `promocional`, `essencial`, `pro`. */
  plan: string
  /** Triagens: what the plan allows and what is left. */
  screenings: QuotaView
  /**
   * Alerts per period, straight from `plan_limits`. `limit: 0` means the plan
   * has no `alert` row — which is not "unlimited", per `readLimit`.
   */
  alerts: QuotaView
  /** Null for a visitor, and for an account that never took a seat. */
  founderSeat: number | null
  /** Whether this is a signed-in account at all. */
  signedIn: boolean
}

export async function readAccountSummary(
  viewer: { userId: number } | { visitorId: string } | null,
  plan: string,
  executor: Executor = db(),
): Promise<AccountSummary> {
  const spender: Spender | null =
    viewer === null ? null : 'userId' in viewer ? { userId: viewer.userId } : { visitorId: viewer.visitorId }

  const [screeningLimit, alertLimit] = await Promise.all([
    readLimit(plan, FEATURES.screening, executor),
    readLimit(plan, FEATURES.alert, executor),
  ])

  // A caller with no identity has spent nothing; asking the database would be
  // a round trip to learn zero.
  const used = spender ? await countUsage(spender, screeningLimit, executor) : 0

  const seat =
    viewer !== null && 'userId' in viewer
      ? await executor
          .execute<{ founder_seat: number | null }>(
            sql`select founder_seat from users where id = ${viewer.userId}::bigint`,
          )
          .then((found) => found.rows[0]?.founder_seat ?? null)
      : null

  return {
    plan,
    screenings: quotaView(screeningLimit, used),
    alerts: quotaView(alertLimit, 0),
    founderSeat: seat === null ? null : Number(seat),
    signedIn: viewer !== null && 'userId' in viewer,
  }
}
