import { Card, SectionLabel, Status, Tag } from '@/components'
import type { Feed, FeedReading } from '@/lib/admin/feeds'

/**
 * When each price feed last did real work — card B37, one card per feed.
 *
 * **Alarm on silence, never on an empty queue.** B32's lesson: a feed that
 * stops enqueuing also stops failing, so 916 broken jobs looked like silence
 * for two days. These cards therefore read the last row of *work*, and a feed
 * with nothing queued is not thereby healthy.
 *
 * The state worth the most here is `refusals_only`: the price feed writes a
 * `catalog_bands` row whether it finds a band or refuses one, so counting rows
 * would show a dead feed as perfectly well. Measured 2026-10-04 over a full
 * pass: 1 028 codes, **947 refusals, 74 bands**. The card prints both numbers
 * for that reason.
 */

const PT = new Intl.NumberFormat('pt-BR')

export function FeedCards({ feeds }: { feeds: readonly Feed[] }) {
  return (
    <section className="flex flex-col gap-3.5">
      <div className="flex items-baseline gap-2">
        <SectionLabel>Alimentação das faixas de preço</SectionLabel>
        <span className="text-caption text-muted">último trabalho de cada rotina</span>
      </div>
      <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
        {feeds.map((feed) => (
          <FeedCard key={feed.key} feed={feed} />
        ))}
      </div>
    </section>
  )
}

function FeedCard({ feed }: { feed: Feed }) {
  return (
    <Card className="flex flex-col gap-2" accent={feed.reading.state === 'fresh'}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-lead font-semibold text-ink">{feed.label}</div>
        <FeedBadge reading={feed.reading} />
      </div>

      <div className="flex items-baseline gap-2">
        <span className="font-mono text-stat tabular-nums text-ink">{headline(feed.reading)}</span>
        <span className="text-meta text-muted">
          alerta depois de {PT.format(Math.round(feed.thresholdHours / 24))} dias
        </span>
      </div>

      <FeedNote reading={feed.reading} />

      <div className="mt-auto pt-1 font-mono text-caption text-muted">{feed.source}</div>
    </Card>
  )
}

/** Hours, or days once hours stop being readable. An em dash, never a zero. */
function headline(reading: FeedReading): string {
  if (reading.state === 'never' || reading.state === 'error') return '—'
  const hours = Math.floor(reading.hours)
  if (hours < 48) return `${PT.format(hours)} h`
  return `${PT.format(Math.floor(hours / 24))} dias`
}

function FeedBadge({ reading }: { reading: FeedReading }) {
  switch (reading.state) {
    case 'fresh':
      return <Status kind="positive">em dia</Status>
    case 'stale':
      return <Tag tone="attention">atrasada</Tag>
    case 'refusals_only':
      return <Tag tone="attention">sem faixas</Tag>
    case 'never':
      return <Tag tone="muted">nunca rodou</Tag>
    case 'error':
      return <Tag tone="attention">erro</Tag>
  }
}

function FeedNote({ reading }: { reading: FeedReading }) {
  switch (reading.state) {
    case 'fresh':
      return <p className="text-meta text-muted">{reading.detail}.</p>
    case 'stale':
      return (
        <p className="text-meta leading-relaxed text-attention">
          Passou do prazo sem produzir nada novo. {reading.detail}.
        </p>
      )
    case 'refusals_only':
      return (
        <p className="text-meta leading-relaxed text-attention">
          A rotina rodou e não produziu nenhuma faixa. {reading.detail}. Rodar sem
          resultado não é o mesmo que estar em dia.
        </p>
      )
    case 'never':
      return <p className="text-meta leading-relaxed text-muted">{reading.note}</p>
    case 'error':
      return (
        <p className="text-meta text-attention">
          A consulta falhou ({reading.reason}). O silêncio não é prova de saúde.
        </p>
      )
  }
}
