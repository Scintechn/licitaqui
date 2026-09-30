import { Card, SectionLabel, Tag } from '@/components'
import { formatBytes, formatPercent, formatUsd, type NeonUsage, type UsageMetric } from '@/lib/admin/neon'

/**
 * The Neon usage card (spec §5.1, gap G14) — card **B27**.
 *
 * One row is a real measurement; the two the Neon API owns say plainly which
 * of *no credentials* and *nothing written yet* is true, because for days this
 * card said the first while the second was the case.
 *
 * **No row prints a percentage of a limit that does not exist.** The project
 * is on Launch, which removes Free's ceilings and prices storage per
 * GB-month, so `metric.limit` is normally `null` and a null limit means no
 * ratio, no bar and no alert. The previous version rendered 338% and a red
 * warning on a database in no danger, which is exactly the failure this
 * screen exists to prevent. See `lib/admin/neon.ts`.
 */

export function UsageCard({ usage }: { usage: NeonUsage }) {
  const alerting = [usage.databaseSize, usage.projectStorage, usage.computeHours].some(
    (metric) => metric.state === 'measured' && metric.alert,
  )

  return (
    <section className="flex flex-col gap-3.5">
      <div className="flex items-baseline gap-2">
        <SectionLabel>Uso do Neon · plano {usage.plan}</SectionLabel>
        <span className="text-caption text-muted">
          cobrança por uso — sem limite fixo de armazenamento
        </span>
      </div>

      <Card accent={alerting} className="flex flex-col gap-4">
        <Row
          title="Tamanho deste banco"
          hint="pg_database_size(current_database()) — medido agora, direto no Postgres."
          metric={usage.databaseSize}
          render={formatBytes}
          cost={usage.storageUsdPerMonth}
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
  cost,
}: {
  title: string
  hint: string
  metric: UsageMetric
  render: (value: number) => string
  /** Dollars per month this row accounts for, when it is arithmetic and not a guess. */
  cost?: number | null
}) {
  return (
    <div className="flex flex-col gap-1.5 border-b border-line pb-4 last:border-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="text-lead font-semibold text-ink">{title}</span>
        <Value metric={metric} render={render} />
      </div>
      {metric.state === 'measured' && metric.ratio !== null ? (
        <Bar ratio={metric.ratio} alert={metric.alert} />
      ) : null}
      {cost !== null && cost !== undefined ? (
        <p className="text-caption text-muted">
          ≈ <span className="font-mono tabular-nums text-ink">{formatUsd(cost)}</span> por mês a
          US$ 0,35/GB-mês
        </p>
      ) : null}
      <p className="text-caption leading-relaxed text-muted">{hint}</p>
      {metric.state === 'not_configured' ? (
        <p className="font-mono text-caption text-attention">
          Falta configurar: {metric.missing.join(' e ')}
        </p>
      ) : null}
      {metric.state === 'pending' ? (
        <p className="font-mono text-caption text-muted">
          Credenciais configuradas; aguardando {metric.writtenBy}.
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
  if (metric.state === 'pending') return <Tag tone="muted">aguardando leitura</Tag>
  if (metric.state === 'unavailable') return <Tag tone="attention">indisponível</Tag>

  return (
    <span className="flex items-baseline gap-2">
      <span className="font-mono text-lead tabular-nums text-ink">{render(metric.value)}</span>
      {/* **Only when there is a ceiling.** On Launch there is none, and a
          percentage of nothing is the defect this card was rebuilt for. */}
      {metric.limit !== null && metric.ratio !== null ? (
        <span className="text-caption text-muted">
          de {render(metric.limit)} · {formatPercent(metric.ratio)}
        </span>
      ) : null}
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
