import Link from 'next/link'
import { Card, StateCard } from '@/components'
import type { Favourite } from '@/lib/favourites/store'
import { messages } from '@/lib/messages'
import { deadlineShort } from '@/lib/radar/format'
import { editalPath } from '@/lib/radar/client'
import { AccountChrome } from '../account-chrome'

/**
 * `/conta/favoritos` — the tenders this account marked (card **D23**).
 *
 * Sci, 2026-09-29: *"when the user marked a tenders as Favorite and we have
 * this section with all followers Tenders"*.
 *
 * **Newest first**, which is what `favourites_user_recent_idx` is for and what
 * the card asks for. Marking something is a "come back to this" gesture, so
 * the thing you marked last is the thing you were thinking about last.
 *
 * ## The empty state is an instruction, not an apology
 *
 * A person reaching an empty Favoritos has not failed at anything — they have
 * not used a control they may not have noticed. So it names the control and
 * where to find it, rather than saying "nothing here".
 *
 * Pure and prop-driven, so it renders under `renderToStaticMarkup` with no
 * session and no database.
 */

const copy = messages.radar.favourites

export function FavouritesView({
  plan,
  planName,
  favourites,
}: {
  plan: string
  planName: string
  favourites: Favourite[]
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
              <li key={one.tenderId}>
                {/* No search to carry: this list is not a search result, so
                    "Voltar" from the tender goes to a bare Radar. That is the
                    honest link — inventing a query string here would take the
                    reader back to a list they never ran. */}
                <Link href={editalPath(one.tenderId)} className="block no-underline">
                  <Card>
                    <div className="flex flex-col gap-1">
                      <span className="text-body font-medium text-ink">{one.object}</span>
                      <span className="text-meta text-muted">
                        {[one.agencyName, one.state].filter(Boolean).join(' · ')}
                      </span>
                      {/* `closeAt` is null for a tender PNCP published no
                          deadline for — four of the twenty seed fixtures are
                          like that — and a card must not render that as a
                          date, least of all as today. */}
                      {one.closeAt ? (
                        <span className="text-meta text-muted">
                          {deadlineShort(one.closeAt.toISOString())}
                        </span>
                      ) : null}
                    </div>
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </AccountChrome>
  )
}
