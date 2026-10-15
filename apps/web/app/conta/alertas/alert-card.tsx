'use client'

import { Button } from '@/components'
import { messages } from '@/lib/messages'
import type { Alert } from '@/lib/alerts/types'

const ufNames = messages.radar.ufNames

interface AlertCardProps {
  alert: Alert
  onEdit: (alert: Alert) => void
  onDelete: (alertId: number) => void
}

export function AlertCard({ alert, onEdit, onDelete }: AlertCardProps) {
  const frequencyLabel = {
    daily: 'Diário',
    weekly: 'Semanal',
    telegram: 'Telegram',
  }[alert.frequency]

  const allStateNames = alert.states.length === 0
    ? ['Todo o Brasil']
    : alert.states.map(state => ufNames[state as keyof typeof ufNames] || state)

  const displayStates = allStateNames.slice(0, 5)
  const hasMore = allStateNames.length > 5

  const keywordDisplay = alert.keywords.length > 0
    ? alert.keywords.slice(0, 3).join(' • ')
    : '(nenhuma palavra-chave)'

  const showMoreKeywords = alert.keywords.length > 3
    ? ` +${alert.keywords.length - 3}`
    : ''

  return (
    <div
      className="rounded-card border border-line overflow-hidden"
      style={{
        borderLeftWidth: '4px',
        borderLeftColor: alert.active ? '#2457d6' : '#e7e1d9',
      }}
    >
      <div className="px-4 py-3 flex flex-col gap-3 sm:gap-4">
        {/* Header with status and actions */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1">
            {/* Keywords */}
            <p className="text-meta font-mono font-semibold text-ink mb-1">
              {keywordDisplay}
              {showMoreKeywords && <span className="font-semibold">{showMoreKeywords}</span>}
            </p>
            {/* States */}
            <div className="flex items-center justify-between gap-3">
              <p className="text-lead text-ink">
                {displayStates.join(', ')}
                {hasMore && ' ...'}
              </p>
              {hasMore && (
                <details className="text-blue text-meta font-semibold cursor-pointer">
                  <summary className="list-none">
                    +{allStateNames.length - 5}
                  </summary>
                  <p className="pt-2 text-meta text-muted">
                    {allStateNames.join(', ')}
                  </p>
                </details>
              )}
            </div>
          </div>
          {/* Status badge */}
          <div
            className="flex-shrink-0 px-2 py-1 rounded text-meta font-semibold text-on-brand"
            style={{
              backgroundColor: alert.active ? '#e8eefb' : '#f3eee8',
              color: alert.active ? '#2457d6' : '#6b6b67',
            }}
          >
            {alert.active ? 'Ativo' : 'Encerrado'}
          </div>
        </div>

        {/* Frequency info */}
        <div className="flex items-center justify-between pt-2 border-t border-line">
          <p className="text-caption text-ink">
            <span className="font-semibold">{frequencyLabel}</span>
            {alert.channel && ` • ${alert.channel}`}
          </p>

          {/* Actions */}
          <div className="flex gap-2">
            <Button
              variant="secondary"
              onClick={() => onEdit(alert)}
              className="text-meta"
            >
              Editar
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                if (confirm('Deseja remover este alerta?')) {
                  onDelete(alert.id)
                }
              }}
              className="text-error text-meta"
            >
              Remover
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
