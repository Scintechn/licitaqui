'use client'

import { Card } from '@/components'
import type { Alert } from '@/lib/alerts/types'
import { AlertCard } from './alert-card'

interface AlertListProps {
  alerts: Alert[]
  onEdit: (alert: Alert) => void
  onDelete: (alertId: number) => void
  isEmpty: boolean
}

export function AlertList({ alerts, onEdit, onDelete, isEmpty }: AlertListProps) {
  if (isEmpty) {
    return (
      <Card>
        <div className="flex flex-col items-center gap-3 py-8 text-center">
          <svg
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-muted"
          >
            <path d="M10 20.5H4a2 2 0 0 1-2-2v-12a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2V10" />
            <path d="M2 7h20" />
            <circle cx="18" cy="19" r="3" />
            <path d="M18 16v6M15 19h6" />
          </svg>
          <h3 className="text-lead font-semibold text-ink">Você não tem nenhum alerta</h3>
          <p className="text-meta text-muted max-w-xs">
            Crie seu primeiro alerta para receber notificações sobre editais que combinam com seu negócio.
          </p>
        </div>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      {alerts.map((alert) => (
        <AlertCard
          key={alert.id}
          alert={alert}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
    </div>
  )
}
