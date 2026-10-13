'use client'

import { useMemo, useState } from 'react'
import { StateCard, Icon } from '@/components'
import type { Favourite } from '@/lib/favourites/store'
import { messages } from '@/lib/messages'
import { TenderCardView } from '@/app/radar/tender-card'
import { editalPath } from '@/lib/radar/client'
import { daysUntil } from '@/lib/radar/format'
import { cn } from '@/lib/cn'

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

function sortFavourites(favourites: Favourite[], order: SortOrder, now: Date): Favourite[] {
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

  const openCount = useMemo(() => sorted.filter((f) => !isClosed(f, currentTime)).length, [sorted, currentTime])
  const closedCount = useMemo(() => sorted.filter((f) => isClosed(f, currentTime)).length, [sorted, currentTime])

  const filtered = useMemo(
    () => sorted.filter((f) => (activeTab === 'open' ? !isClosed(f, currentTime) : isClosed(f, currentTime))),
    [sorted, activeTab, currentTime],
  )

  if (favourites.length === 0) {
    return (
      <div className="flex min-h-dvh flex-col">
        <header className="mx-auto w-full max-w-[560px] border-b border-line-strong px-gutter py-4">
          <h1 className="font-display text-[26px] leading-tight font-semibold">{copy.title}</h1>
        </header>
        <main className="mx-auto w-full max-w-[560px] flex grow flex-col gap-4 px-gutter pt-6 pb-10">
          <StateCard kind="empty" title={copy.emptyTitle} description={copy.emptyBody} />
        </main>
      </div>
    )
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="mx-auto w-full max-w-[560px] border-b border-line-strong px-gutter py-4">
        <h1 className="font-display text-[26px] leading-tight font-semibold">{copy.title}</h1>
      </header>
      <main className="flex w-full grow flex-col gap-4 px-gutter pt-6 pb-10">
        <p className="text-meta leading-relaxed text-muted">{copy.intro}</p>
        <nav className="border-b border-line-strong">
          <div className="flex gap-0 -mx-gutter px-gutter">
            <button
              onClick={() => setActiveTab('open')}
              className={`flex min-h-9 items-center gap-1.5 border-b-2 px-3 text-meta font-medium transition-colors ${
                activeTab === 'open' ? 'border-blue text-blue' : 'border-transparent text-muted hover:text-ink'
              }`}
            >
              Abertos<span className="font-mono text-label">{openCount}</span>
            </button>
            <button
              onClick={() => setActiveTab('closed')}
              className={`flex min-h-9 items-center gap-1.5 border-b-2 px-3 text-meta font-medium transition-colors ${
                activeTab === 'closed' ? 'border-blue text-blue' : 'border-transparent text-muted hover:text-ink'
              }`}
            >
              Encerrados<span className="font-mono text-label">{closedCount}</span>
            </button>
          </div>
        </nav>
        <div className="pb-3 pt-3">
          <details key={sortOrder} className="group/sort inline-block">
            <summary className={cn('flex min-h-touch cursor-pointer list-none items-center gap-1 text-body text-muted', 'whitespace-nowrap [&::-webkit-details-marker]:hidden')}>
              <span>Ordenar: {SORT_OPTIONS.find((o) => o.value === sortOrder)?.label.split('(')[0].trim()}</span>
              <Icon name="chevronRight" size={16} className="transition-transform group-open/sort:rotate-90" />
            </summary>
            <ul className="absolute left-gutter z-20 mt-1 w-max rounded-control border border-line-strong bg-surface py-1">
              {SORT_OPTIONS.map((opt) => (
                <li key={opt.value}>
                  <button
                    onClick={() => setSortOrder(opt.value as SortOrder)}
                    className={cn('flex w-full min-h-touch items-center px-3 text-body whitespace-nowrap text-left', sortOrder === opt.value ? 'font-semibold text-ink' : 'text-ink hover:bg-fill-muted')}
                  >
                    {opt.label}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        </div>
        {filtered.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-meta text-muted">{activeTab === 'open' ? 'Nenhum edital aberto nos favoritos' : 'Nenhum edital encerrado nos favoritos'}</p>
          </div>
        ) : (
          <ul className="grid list-none grid-cols-1 gap-2.5 p-0 md:grid-cols-2 lg:grid-cols-3">
            {filtered.map((one) => (
              <li key={one.card.id}>
                <TenderCardView tender={one.card} now={currentTime} href={editalPath(one.card.id)} showUrgencyColor />
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}
