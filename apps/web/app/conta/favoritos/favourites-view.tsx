'use client'

import { useMemo, useState } from 'react'
import { StateCard, Icon } from '@/components'
import type { Favourite } from '@/lib/favourites/store'
import { messages } from '@/lib/messages'
import { TenderCardView } from '@/app/radar/tender-card'
import { editalPath } from '@/lib/radar/client'
import { daysUntil } from '@/lib/radar/format'
import { cn } from '@/lib/cn'
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
type FavouriteTab = 'open' | 'closed'

const SORT_OPTIONS = [
  { value: 'deadline-asc', label: 'Vence em (próximo)' },
  { value: 'deadline-desc', label: 'Vence em (depois)' },
  { value: 'recent', label: 'Recém adicionado' },
]

function isClosed(favourite: Favourite, now: Date): boolean {
  const days = daysUntil(favourite.card.proposalsCloseAt, now)
  return days !== null && days < 0
}

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
  const [activeTab, setActiveTab] = useState<FavouriteTab>('open')
  const currentTime = useMemo(() => now ?? new Date(), [now])

  const sorted = useMemo(() => sortFavourites(favourites, sortOrder, currentTime), [
    favourites,
    sortOrder,
    currentTime,
  ])

  const openCount = useMemo(
    () => sorted.filter((f) => !isClosed(f, currentTime)).length,
    [sorted, currentTime],
  )
  const closedCount = useMemo(
    () => sorted.filter((f) => isClosed(f, currentTime)).length,
    [sorted, currentTime],
  )

  const filtered = useMemo(
    () =>
      sorted.filter((f) =>
        activeTab === 'open' ? !isClosed(f, currentTime) : isClosed(f, currentTime),
      ),
    [sorted, activeTab, currentTime],
  )

  return (
    <AccountChrome plan={plan} planName={planName} title={copy.title}>
      {favourites.length === 0 ? (
        <StateCard kind="empty" title={copy.emptyTitle} description={copy.emptyBody} />
      ) : (
        <>
          <p className="text-meta leading-relaxed text-muted">{copy.intro}</p>

          <div className="flex w-full flex-col gap-4 -mx-gutter px-gutter pb-10">
          {/* Tab controls: Open / Closed */}
          <nav className="border-b border-line-strong">
            <div className="flex gap-0 -mx-gutter px-gutter">
              <button
                onClick={() => setActiveTab('open')}
                className={`flex min-h-9 items-center gap-1.5 border-b-2 px-3 text-meta font-medium transition-colors ${
                  activeTab === 'open'
                    ? 'border-blue text-blue'
                    : 'border-transparent text-muted hover:text-ink'
                }`}
              >
                Abertos
                <span className="font-mono text-label">{openCount}</span>
              </button>
              <button
                onClick={() => setActiveTab('closed')}
                className={`flex min-h-9 items-center gap-1.5 border-b-2 px-3 text-meta font-medium transition-colors ${
                  activeTab === 'closed'
                    ? 'border-blue text-blue'
                    : 'border-transparent text-muted hover:text-ink'
                }`}
              >
                Encerrados
                <span className="font-mono text-label">{closedCount}</span>
              </button>
            </div>
          </nav>

          {/* Sort control — styled like Radar */}
          <div className="pb-3 pt-3">
            <details key={sortOrder} className="group/sort inline-block">
              <summary
                className={cn(
                  'flex min-h-touch cursor-pointer list-none items-center gap-1 text-body text-muted',
                  'whitespace-nowrap [&::-webkit-details-marker]:hidden',
                )}
              >
                <span>Ordenar: {SORT_OPTIONS.find((o) => o.value === sortOrder)?.label.split('(')[0].trim()}</span>
                <Icon
                  name="chevronRight"
                  size={16}
                  className="transition-transform group-open/sort:rotate-90"
                />
              </summary>
              <ul className="absolute left-gutter z-20 mt-1 w-max rounded-control border border-line-strong bg-surface py-1">
                {SORT_OPTIONS.map((opt) => (
                  <li key={opt.value}>
                    <button
                      onClick={() => setSortOrder(opt.value as SortOrder)}
                      className={cn(
                        'flex w-full min-h-touch items-center px-3 text-body whitespace-nowrap text-left',
                        sortOrder === opt.value ? 'font-semibold text-ink' : 'text-ink hover:bg-fill-muted',
                      )}
                    >
                      {opt.label}
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          </div>

          {/* Grid of cards */}
          {filtered.length === 0 ? (
            <div className="py-8 text-center">
              <p className="text-meta text-muted">
                {activeTab === 'open'
                  ? 'Nenhum edital aberto nos favoritos'
                  : 'Nenhum edital encerrado nos favoritos'}
              </p>
            </div>
          ) : (
            <div className="@container">
              <ul className="grid list-none grid-cols-1 gap-2.5 p-0 @min-[860px]:grid-cols-2 @min-[1080px]:grid-cols-3">
                {filtered.map((one) => (
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
          )}
          </div>
        </>
      )}
    </AccountChrome>
  )
}
