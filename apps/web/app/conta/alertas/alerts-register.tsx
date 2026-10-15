'use client'

import { useCallback, useState } from 'react'
import { AppBar, Button, SectionLabel } from '@/components'
import { messages } from '@/lib/messages'
import type { Alert } from '@/lib/alerts/types'
import { AlertForm } from './alert-form'
import { AlertList } from './alert-list'
import { createAlert, deleteAlert, updateAlert } from './actions'

const prefs = messages.notifications

export type AlertRegisterNotice = 'criado' | 'atualizado' | 'removido' | null

interface AlertsRegisterProps {
  userId: number
  alerts: Alert[]
  limits: { keywords: number }
  notice: AlertRegisterNotice
}

export function AlertsRegister({
  userId,
  alerts,
  limits,
  notice,
}: AlertsRegisterProps) {
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [editingAlert, setEditingAlert] = useState<Alert | null>(null)
  const [localAlerts, setLocalAlerts] = useState(alerts)

  const handleEdit = useCallback((alert: Alert) => {
    setEditingAlert(alert)
    setIsFormOpen(true)
  }, [])

  const handleDelete = useCallback(async (alertId: number) => {
    try {
      await deleteAlert(alertId)
      setLocalAlerts(localAlerts.filter((a) => a.id !== alertId))
    } catch (error) {
      console.error('Failed to delete alert:', error)
    }
  }, [localAlerts])

  const handleCancel = useCallback(() => {
    setIsFormOpen(false)
    setEditingAlert(null)
  }, [])

  const handleSubmit = useCallback(
    async (data: { keywords: string[]; states: string[]; frequency: 'daily' | 'weekly' | 'telegram'; channel: string }) => {
      try {
        const formData = new FormData()
        data.keywords.forEach((kw: string) => formData.append('keywords', kw))
        data.states.forEach((state: string) => formData.append('states', state))
        formData.append('frequency', data.frequency)
        formData.append('channel', data.channel)

        if (editingAlert) {
          await updateAlert(editingAlert.id, formData)
          setLocalAlerts(
            localAlerts.map((a) =>
              a.id === editingAlert.id ? { ...a, ...data } : a
            )
          )
        } else {
          await createAlert(formData)
          // Alerts will be refetched on redirect
        }
        setIsFormOpen(false)
        setEditingAlert(null)
      } catch (error) {
        console.error('Failed to save alert:', error)
        throw error
      }
    },
    [editingAlert, localAlerts]
  )

  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar />
      <main className="mx-auto flex w-full grow flex-col gap-6 px-gutter pt-6 pb-10" style={{ maxWidth: '1400px' }}>
        {/* Header */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-[26px] leading-tight font-semibold">
              {prefs.title}
            </h1>
            <p className="text-meta leading-relaxed text-muted pt-1">
              {prefs.intro}
            </p>
          </div>
          {!isFormOpen && (
            <Button onClick={() => setIsFormOpen(true)}>
              Novo Alerta
            </Button>
          )}
        </div>

        {/* Status notices */}
        {notice === 'criado' && (
          <div className="rounded-control bg-success-soft border border-success-soft px-4 py-3">
            <p className="text-meta text-success font-semibold">
              Alerta criado com sucesso
            </p>
          </div>
        )}
        {notice === 'atualizado' && (
          <div className="rounded-control bg-success-soft border border-success-soft px-4 py-3">
            <p className="text-meta text-success font-semibold">
              Alerta atualizado com sucesso
            </p>
          </div>
        )}
        {notice === 'removido' && (
          <div className="rounded-control bg-success-soft border border-success-soft px-4 py-3">
            <p className="text-meta text-success font-semibold">
              Alerta removido com sucesso
            </p>
          </div>
        )}

        {/* Form or List */}
        {isFormOpen ? (
          <div className="bg-fill-muted rounded-card border border-line p-6">
            <h2 className="font-display text-[18px] leading-tight font-semibold mb-6">
              {editingAlert ? 'Editar alerta' : 'Criar novo alerta'}
            </h2>
            <AlertForm
              userId={userId}
              alert={editingAlert}
              limits={limits}
              onSubmit={handleSubmit}
              onCancel={handleCancel}
            />
          </div>
        ) : (
          <section className="flex flex-col gap-3">
            <SectionLabel>Meus Alertas</SectionLabel>
            <AlertList
              alerts={localAlerts}
              onEdit={handleEdit}
              onDelete={handleDelete}
              isEmpty={localAlerts.length === 0}
            />
          </section>
        )}
      </main>
    </div>
  )
}
