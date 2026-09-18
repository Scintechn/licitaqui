import { Card, SectionLabel, Tag } from '@/components'
import {
  ALERT_AT,
  formatBytes,
  formatPercent,
  type NeonUsage,
  type UsageMetric,
} from '@/lib/admin/neon'

/**
 * The Neon Free usage card (spec §5.1, gap G14).
 *
 * One row is a real measurement, two say plainly that they are not configured
 * and name the variables that would fix that. See `lib/admin/neon.ts` for why
 * the missing halves are not estimated: an invented storage figure is how a
 * database quietly fills up while a dashboard says it is fine.
 */

export function UsageCard({ usage }: { usage: NeonUsage }) {
  const alerting = [usage.databaseSize, usage.projectStorage, usage.computeHours].some(
    (metric) => metric.state === 'measured' && metric.alert,
  )

  return (
    <section className="flex flex-col gap-3.5">
      <div className="flex items-baseline gap-2">
        <SectionLabel>Uso do Neon · plano Free</SectionLabel>
        <span className="text-caption text-muted">
          alerta em {formatPercent(ALERT_AT)} de cada limite
        </span>
      </div>

      <Card accent={alerting} className="flex flex-col gap-4">
        <Row
          title="Tamanho deste banco"
          hint="pg_database_size(current_database()) — medido agora, direto no Postgres."
          metric={usage.databaseSize}
          render={formatBytes}
        />
        <Row
          title="Armazenamento do projeto na Neon"
          hint="É esta a métrica que a Neon cobra: todas as branches mais o histórico de restore. Só a API da Neon informa."
          metric={usage.projectStorage}
          render={formatBytes}
        />
        <Row
          title="CU-horas no mês"
          hint="Medidas pelo control plane da Neon; não existem dentro do Postgres."
          metric={usage.computeHours}
          render={(value) => `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} CU-h`}
        />
      </Card>
    </section>
  )
}

function Row({
  title,
  hint,
  metric,
  render,
}: {
  title: string
  hint: string
  metric: UsageMetric
  render: (value: number) => string
}) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-line pb-4 last:border-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-lead font-semibold text-ink">{title}</span>
        <Value metric={metric} render={render} />
      </div>
      {metric.state === 'measured' ? <Bar ratio={metric.ratio} alert={metric.alert} /> : null}
      <p className="text-caption leading-relaxed text-muted">{hint}</p>
      {metric.state === 'not_configured' ? (
        <p className="font-mono text-caption text-attention">
          Falta configurar: {metric.missing.join(' e ')}
        </p>
      ) : null}
      {metric.state === 'unavailable' ? (
        <p className="font-mono text-caption text-attention">
          Não foi possível medir ({metric.reason}).
        </p>
      ) : null}
    </div>
  )
}

function Value({ metric, render }: { metric: UsageMetric; render: (value: number) => string }) {
  if (metric.state === 'not_configured') return <Tag tone="muted">não configurado</Tag>
  if (metric.state === 'unavailable') return <Tag tone="attention">indisponível</Tag>

  return (
    <span className="flex items-baseline gap-2">
      <span className="font-mono text-lead tabular-nums text-ink">{render(metric.value)}</span>
      <span className="text-caption text-muted">
        de {render(metric.limit)} · {formatPercent(metric.ratio)}
      </span>
      {metric.alert ? <Tag tone="attention">80% do limite</Tag> : null}
    </span>
  )
}

/** A plain bar: `aria-hidden` because the numbers next to it already say this. */
function Bar({ ratio, alert }: { ratio: number; alert: boolean }) {
  const width = Math.max(1, Math.min(100, Math.round(ratio * 100)))
  return (
    <div aria-hidden className="h-1.5 w-full overflow-hidden rounded-pill bg-fill-muted">
      <div
        className={`h-full rounded-pill ${alert ? 'bg-attention' : 'bg-blue'}`}
        style={{ width: `${width}%` }}
      />
    </div>
  )
}
