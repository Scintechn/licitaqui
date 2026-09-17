import { Card, SectionLabel, Status, Tag } from '@/components'
import { gateMet, type Gate, type GateReading } from '@/lib/admin/gates'

/**
 * The six Phase 0 gate numbers (spec §14), one card each.
 *
 * Every card says three things: the number, the target, and where the number
 * came from. Rows with nothing behind them yet are drawn exactly like the rest,
 * showing "0 de 150" or "sem fonte" — a gate you cannot see is a gate you are
 * not watching, and in week one most of them are zero by definition.
 */

const PT = new Intl.NumberFormat('pt-BR')

export function GateCards({ gates, gateDate }: { gates: readonly Gate[]; gateDate: string }) {
  return (
    <section className="flex flex-col gap-3.5">
      <div className="flex items-baseline gap-2">
        <SectionLabel>Metas da Fase 0</SectionLabel>
        <span className="text-caption text-muted">avaliação em {gateDate}</span>
      </div>
      <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
        {gates.map((gate) => (
          <GateCard key={gate.key} gate={gate} />
        ))}
      </div>
    </section>
  )
}

function GateCard({ gate }: { gate: Gate }) {
  const met = gateMet(gate)
  return (
    <Card className="flex flex-col gap-2" accent={met === true}>
      <div className="flex items-start justify-between gap-2">
        <div className="text-lead font-semibold text-ink">{gate.label}</div>
        <GateBadge gate={gate} met={met} />
      </div>

      <div className="flex items-baseline gap-2">
        <span className="font-mono text-stat tabular-nums text-ink">{headline(gate)}</span>
        <span className="text-meta text-muted">{targetLabel(gate)}</span>
      </div>

      <GateNote reading={gate.reading} />

      <div className="mt-auto pt-1 font-mono text-caption text-muted">{gate.source}</div>
    </Card>
  )
}

/** The big figure. Never invented: an unmeasurable gate shows an em dash. */
function headline(gate: Gate): string {
  switch (gate.reading.state) {
    case 'counted':
      return PT.format(gate.reading.value)
    case 'rate':
      return `${PT.format(Math.round(gate.reading.percent))}%`
    default:
      return '—'
  }
}

function targetLabel(gate: Gate): string {
  const target = gate.unit === 'percent' ? `${PT.format(gate.target)}%` : PT.format(gate.target)
  const of = gate.targetOf === undefined ? '' : ` de ${PT.format(gate.targetOf)}`
  return `meta ≥ ${target}${of}`
}

function GateBadge({ gate, met }: { gate: Gate; met: boolean | null }) {
  if (gate.reading.state === 'error') return <Tag tone="attention">erro</Tag>
  if (gate.reading.state === 'no_source') return <Tag tone="muted">sem fonte</Tag>
  if (gate.reading.state === 'no_data') return <Tag tone="muted">sem dados</Tag>
  if (met === true) return <Status kind="positive">batida</Status>
  return <Tag tone="neutral">em aberto</Tag>
}

function GateNote({ reading }: { reading: GateReading }) {
  switch (reading.state) {
    case 'rate':
      return (
        <p className="text-meta text-muted">
          {PT.format(reading.opened)} de {PT.format(reading.sent)} enviados foram abertos.
        </p>
      )
    case 'no_data':
    case 'no_source':
      return <p className="text-meta leading-relaxed text-muted">{reading.note}</p>
    case 'error':
      return (
        <p className="text-meta text-attention">
          A consulta falhou ({reading.reason}). O número não é zero — é desconhecido.
        </p>
      )
    default:
      return null
  }
}
