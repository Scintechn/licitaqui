import { headers } from 'next/headers'
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
 * ## The raw header, not a rebuilt one
 *
 * `headers().get('cookie')` and **not** `cookies()`. The first version rebuilt
 * the header out of `cookies().getAll()`, which is lossy in two ways that both
 * end in the same wrong answer:
 *
 *   `cookies()` returns values **already percent-decoded**, and
 *   `sessionTokenFromCookies` calls `decodeURIComponent` on every value it
 *   walks past *before* it checks the name. So a cookie whose real value held
 *   `%25` came back as `%`, was decoded a second time, and threw `URIError:
 *   URI malformed` — on an unrelated cookie, before the session token was ever
 *   reached.
 *
 *   A decoded value containing `;` split the rebuilt header into bogus pairs,
 *   so the session cookie could be lost without any error at all.
 *
 * In both cases the `catch` below turned a parsing bug into `false`, and a
 * paying subscriber was shown "Ver plano Essencial" on every request for as
 * long as that cookie was set. The raw header has neither problem and is what
 * `readViewer` is documented to take.
 *
 * ## A failed read offers the plan
 *
 * `readViewer` answers `null` for anybody not signed in, which is the ordinary
 * case on this screen and already means "not entitled". A read that throws —
 * no database — is treated the same way: the cost of being wrong is showing
 * the offer to a subscriber during an outage, against hiding it from every
 * visitor during one.
 *
 * That trade is only defensible because the *parsing* bug above is gone. While
 * it was there, this `catch` was not absorbing an outage, it was absorbing a
 * defect and making it permanent.
 *
 * Nothing here spends a screening or mints an identity: `readViewer` never
 * creates a visitor row, by design.
 */
export async function readPriceBandEntitlement(): Promise<boolean> {
  try {
    const header = (await headers()).get('cookie')
    return hasPriceBand(planOf(await readViewer(header, db())))
  } catch {
    return false
  }
}
