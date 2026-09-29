import { StateCard } from '@/components'
import type { Favourite } from '@/lib/favourites/store'
import { messages } from '@/lib/messages'
import { TenderCardView } from '@/app/radar/tender-card'
import { editalPath } from '@/lib/radar/client'
import { AccountChrome } from '../account-chrome'

/**
 * `/conta/favoritos` — the tenders this account marked (card **D23**).
 *
 * ## It draws the Radar's card, not a card of its own
 *
 * The first version rendered the raw `object`, the agency and a date. Sci,
 * 2026-09-29: *"even closed of a good UX… tells nothing worthy"* — and he was
 * right. `tenders.object` is a paragraph; `short_title` is the two-to-eight
 * word title every other screen shows, and the card that draws it also draws
 * the value, the deadline countdown, the item count and the ME/EPP tags.
 *
 * Reusing `TenderCardView` means none of that can drift from how the Radar
 * shows the same tender — which is the whole reason the component is shared
 * rather than the markup copied.
 *
 * **Newest first**, which is what `favourites_user_recent_idx` is for: marking
 * is a "come back to this" gesture, so the last thing you marked is the thing
 * you were thinking about last.
 *
 * ## The empty state is an instruction, not an apology
 *
 * Somebody reaching an empty Favoritos has not failed at anything — they have
 * not used a control they may not have noticed. So it names the control and
 * where to find it.
 */

const copy = messages.radar.favourites

export function FavouritesView({
  plan,
  planName,
  favourites,
  now,
}: {
  plan: string
  planName: string
  favourites: Favourite[]
  /** Injected so the countdown is testable against a fixed clock. */
  now?: Date
}) {
  return (
    <AccountChrome plan={plan} planName={planName} title={copy.title}>
      {favourites.length === 0 ? (
        <StateCard kind="empty" title={copy.emptyTitle} description={copy.emptyBody} />
      ) : (
        <>
          <p className="text-meta leading-relaxed text-muted">{copy.intro}</p>
          <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
            {favourites.map((one) => (
              <li key={one.card.id}>
                {/* No search to carry: this list is not a search result, so
                    "Voltar" from the tender goes to a bare Radar. Inventing a
                    query string here would take the reader back to a list
                    they never ran. */}
                <TenderCardView tender={one.card} now={now} href={editalPath(one.card.id)} />
              </li>
            ))}
          </ul>
        </>
      )}
    </AccountChrome>
  )
}
