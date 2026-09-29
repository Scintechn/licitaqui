import { cookies } from 'next/headers'
import { planOf, readViewer } from '@/lib/auth/viewer'
import { db } from '@/lib/db'
import { hasPriceBand } from '@/lib/radar/quota'

/**
 * Whether this viewer's plan includes the price band — read **on the server**,
 * once, before anything renders.
 *
 * ## Why it is not read from the band request
 *
 * It was. `GET /api/tenders/:id/band` answered `entitled` alongside the band,
 * and the screen drove its plan CTA off that. Three things were wrong with it,
 * and only the first was obvious:
 *
 *   **The CTA arrived late.** The band query is measured at a median of 412 ms
 *   and a worst case of 2 715 ms (B21), and it is chained after the tender
 *   load. So the one conversion control on the screen was absent for the first
 *   second or more, then appeared at the bottom of a page the reader had
 *   already started reading.
 *
 *   **It vanished and came back on every item chip.** The answer is keyed on
 *   the item, correctly — so changing items discarded it and the CTA flickered
 *   once per click.
 *
 *   **On a tender with no items it never came at all.** `chooseItem` answers
 *   `null` for an empty list, the request is never made, and "we have not
 *   asked" is indistinguishable from "in flight" — so the offer was withheld
 *   permanently from a screen that shows nothing else to buy.
 *
 * Entitlement does not depend on the item, the band, or the tender. It depends
 * on the viewer, which the server already knows. Reading it here makes the CTA
 * correct on first paint in every one of those cases, and removes the second
 * source of truth that made them possible.
 *
 * ## A failed read offers the plan
 *
 * `readViewer` answers `null` for anybody not signed in, which is the ordinary
 * case on this screen and already means "not entitled". A thrown read — no
 * database, a bad cookie — is therefore indistinguishable from the common path
 * at this layer, and is treated the same way. The cost of being wrong is
 * showing "Ver plano Essencial" to a subscriber during an outage; the cost of
 * the opposite default is hiding the offer from every visitor during one.
 *
 * Nothing here spends a screening or mints an identity: `readViewer` never
 * creates a visitor row, by design.
 */
export async function readPriceBandEntitlement(): Promise<boolean> {
  try {
    const jar = await cookies()
    const header = jar
      .getAll()
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ')
    return hasPriceBand(planOf(await readViewer(header, db())))
  } catch {
    return false
  }
}
