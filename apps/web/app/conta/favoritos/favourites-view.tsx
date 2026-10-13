'use client'

import { useMemo, useState } from 'react'
import { StateCard } from '@/components'
import type { Favourite } from '@/lib/favourites/store'
import { messages } from '@/lib/messages'
import { TenderCardView } from '@/app/radar/tender-card'
import { editalPath } from '@/lib/radar/client'
import { daysUntil } from '@/lib/radar/format'
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
 *
 * ## Sorting and urgency coloring (D23 quick wins)
 *
 * Cards are displayed in a 3-column responsive grid. They can be sorted by
 * deadline (ascending for most urgent first, or descending) or by value. The
 * countdown badge color indicates urgency: red for ≤2 days, yellow for 3–7
 * days, green for >7 days — surfacing what needs attention first.
 */

const copy = messages.radar.favourites

type SortOrder = 'deadline-asc' | 'deadline-desc' | 'recent'

const SORT_OPTIONS = [
  { value: 'deadline-asc', label: 'Vence em (próximo)' },
  { value: 'deadline-desc', label: 'Vence em (depois)' },
  { value: 'recent', label: 'Recém adicionado' },
]

function sortFavourites(
  favourites: Favourite[],
  order: SortOrder,
  now: Date,
): Favourite[] {
  const sorted = [...favourites]

  const getDaysUntil = (f: Favourite): number => {
    const days = daysUntil(f.card.proposalsCloseAt, now)
    return days === null ? 999999 : days
  }

  switch (order) {
    case 'deadline-asc':
      sorted.sort((a, b) => getDaysUntil(a) - getDaysUntil(b))
      break
    case 'deadline-desc':
      sorted.sort((a, b) => getDaysUntil(b) - getDaysUntil(a))
      break
    case 'recent':
      // Keep original order (newest first from server)
      break
  }

  return sorted
}

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
  const [sortOrder, setSortOrder] = useState<SortOrder>('deadline-asc')
  const currentTime = useMemo(() => now ?? new Date(), [now])

  const sorted = useMemo(() => sortFavourites(favourites, sortOrder, currentTime), [
    favourites,
    sortOrder,
    currentTime,
  ])

  return (
    <AccountChrome plan={plan} planName={planName} title={copy.title}>
      {favourites.length === 0 ? (
        <StateCard kind="empty" title={copy.emptyTitle} description={copy.emptyBody} />
      ) : (
        <>
          <p className="text-meta leading-relaxed text-muted">{copy.intro}</p>

          <div className="px-gutter pb-3">
            <select
              id="favourites-sort"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.currentTarget.value as SortOrder)}
              className="min-h-control rounded-control border border-field-line bg-surface px-3 text-base text-ink"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div style={{ containerType: 'inline-size' }}>
            <ul className="grid list-none grid-cols-1 gap-2.5 p-0 @min-[860px]:grid-cols-2 @min-[1080px]:grid-cols-3">
              {sorted.map((one) => (
                <li key={one.card.id}>
                  {/* No search to carry: this list is not a search result, so
                      "Voltar" from the tender goes to a bare Radar. Inventing a
                      query string here would take the reader back to a list
                      they never ran. */}
                  <TenderCardView
                    tender={one.card}
                    now={currentTime}
                    href={editalPath(one.card.id)}
                    showUrgencyColor
                  />
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </AccountChrome>
  )
}
