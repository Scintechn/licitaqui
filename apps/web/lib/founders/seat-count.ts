import { FOUNDER_SEATS, seatsLeft, seatsTaken } from './seats'
import { countFounderSeatsTaken } from './signup'

/**
 * The founder seat count, read on the server at render time.
 *
 * `/fundadores` already shows this number, but it asks `GET
 * /api/founders/seats` from the browser (see `fundadores/signup-form.tsx`):
 * that page's seat grid is 48 cells the visitor is looking straight at, so a
 * cell filling in a moment later is fine.
 *
 * The Landing's founders strip is the first line of the document. Fetching it
 * from the browser would mean the top of the page reflowing, or printing a
 * number that is not there yet — so the count is taken here instead, at build
 * and at each ISR revalidation, the same way `radar/stats.ts` takes the "Hoje
 * no Brasil" figures. The page stays static (spec §3.3); the number is at most
 * `revalidate` seconds old, and `/fundadores` remains the live one.
 *
 * ## Why it may answer `null`
 *
 * `next build` runs with no `DATABASE_URL` (`lib/db/index.ts`), and F1's table
 * may be unreachable. A marketing counter is never worth failing a deploy over
 * and **a made-up remaining number is worse than none**: when the count cannot
 * be taken this returns `null` and the strip says how many seats exist in
 * total, without claiming how many are left.
 *
 * Server-only: `./signup` pulls in Drizzle and `pg`. Client Components import
 * `@/lib/founders`, which deliberately re-exports only the pure half.
 */

export type FounderSeatsView = {
  /** Always `FOUNDER_SEATS` — 48, spec §10. */
  total: number
  taken: number
  left: number
  soldOut: boolean
}

/**
 * `count` is injected so the degradation can be tested without a database;
 * nothing in the app passes it.
 */
export async function founderSeats(
  count: () => Promise<number> = countFounderSeatsTaken,
): Promise<FounderSeatsView | null> {
  try {
    const taken = seatsTaken(await count())
    return {
      total: FOUNDER_SEATS,
      taken,
      left: seatsLeft(taken),
      soldOut: seatsLeft(taken) === 0,
    }
  } catch {
    return null
  }
}
