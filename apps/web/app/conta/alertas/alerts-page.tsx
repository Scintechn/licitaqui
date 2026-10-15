'use client'

import { useCallback, useState } from 'react'
import { AppBar, Button, Card, CardRow, SectionLabel } from '@/components'
import { format, messages } from '@/lib/messages'
import { ALERTS_PATH } from '@/lib/routes'
import { HANDOFF_MINUTES, type LinkPhase } from '@/lib/telegram/handoff'
import { type AlertLimits } from '@/lib/telegram/quota'
import { CompanyForm } from '../company-form'
import { AlertForm } from './alert-form'
import { AlertList } from './alert-list'
import { AlertsPreferencesForm } from './alerts-preferences-form'
import type { Alert } from '@/lib/alerts/types'

const copy = messages.telegram
const hand = messages.telegram.handoff
const prefs = messages.notifications

export type AlertNotice = 'saved' | 'disconnected' | 'company' | 'cnpj-invalid' | 'criado' | 'atualizado' | 'removido' | null

export type AlertsPageProps = {
  userId: number
  phase: LinkPhase
  active: boolean
  limits: AlertLimits
  cnpj: string | null
  companyName: string | null
  botHandle: string
  keywords: string[]
  states: string[]
  alerts: Alert[]
  notice: AlertNotice
  connectAction: () => void | Promise<void>
  recheckAction: () => void | Promise<void>
  disconnectAction: () => void | Promise<void>
  pauseAction: () => void | Promise<void>
  resumeAction: () => void | Promise<void>
  saveAction: (formData: FormData) => void | Promise<void>
  companyAction: (formData: FormData) => void | Promise<void>
  createAlertAction: (formData: FormData) => Promise<{ success: true }>
  updateAlertAction: (alertId: string | number, formData: FormData) => Promise<{ success: true }>
  deleteAlertAction: (alertId: string | number) => Promise<{ success: true }>
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-meta leading-relaxed text-muted">{children}</p>
}

function frequencyLabel(limits: AlertLimits): string {
  return limits.perWeek === 1 ? copy.connected.frequencyBasic : copy.connected.frequencyPaid
}

function StartCommand({ command, botHandle }: { command: string; botHandle: string }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-meta leading-relaxed font-medium">{hand.manualTitle}</p>
      <Note>{format(hand.manualBody, { bot: botHandle })}</Note>
      <code className="block rounded-control border border-line-strong bg-fill-muted px-3 py-2 font-mono text-meta break-all select-all">
        {command}
      </code>
      <Note>{hand.manualHint}</Note>
    </div>
  )
}

function TelegramExamplePreview() {
  return (
    <Card padding="none" className="overflow-hidden">
      <div className="bg-blue px-4 py-3">
        <p className="text-lead font-medium text-on-brand">LicitaQui</p>
      </div>
      <div className="px-4 py-3 flex flex-col gap-3">
        <p className="text-lead font-semibold">3 editais novos para sua empresa</p>

        <div className="flex gap-3 items-start">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-blue mt-0.5">
            <path d="M7 3h7l5 5v13H7z"/>
            <path d="M14 3v5h5M10 13h6M10 17h6"/>
          </svg>
          <div className="flex-1">
            <p className="text-lead font-semibold">Baterias e pilhas · Campinas/SP</p>
            <p className="text-caption text-muted">R$ 48 mil · exclusivo ME/EPP · 30/09</p>
          </div>
        </div>

        <div className="flex gap-3 items-start">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-blue mt-0.5">
            <path d="M7 3h7l5 5v13H7z"/>
            <path d="M14 3v5h5M10 13h6M10 17h6"/>
          </svg>
          <div className="flex-1">
            <p className="text-lead font-semibold">Materiais hospitalares · Campinas/SP</p>
            <p className="text-caption text-muted">R$ 1,25 mi · exige licença sanitária</p>
          </div>
        </div>

        <div className="flex gap-3 items-start">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 text-blue mt-0.5">
            <path d="M7 3h7l5 5v13H7z"/>
            <path d="M14 3v5h5M10 13h6M10 17h6"/>
          </svg>
          <div className="flex-1">
            <p className="text-lead font-semibold">Sistema web SaaS · Americana/SP</p>
            <p className="text-caption text-muted">R$ 4,3 mi · atestado de 650 usuários</p>
          </div>
        </div>

        <button className="w-full min-h-touch flex items-center justify-center rounded-control bg-blue-soft text-blue font-semibold text-lead transition-colors hover:bg-blue-line">
          Ver triagens
        </button>

        <p className="text-caption text-muted text-center">Telegram · segunda 07:00</p>
      </div>
    </Card>
  )
}

export function AlertsPage({
  userId,
  phase,
  active,
  limits,
  cnpj,
  companyName,
  botHandle,
  keywords,
  states,
  alerts,
  notice,
  connectAction,
  recheckAction,
  disconnectAction,
  pauseAction,
  resumeAction,
  saveAction,
  companyAction,
  createAlertAction,
  updateAlertAction,
  deleteAlertAction,
}: AlertsPageProps) {
  const [isFormOpen, setIsFormOpen] = useState(false)
  const [editingAlert, setEditingAlert] = useState<Alert | null>(null)

  const handleEdit = useCallback((alert: Alert) => {
    setEditingAlert(alert)
    setIsFormOpen(true)
  }, [])

  const handleCancel = useCallback(() => {
    setIsFormOpen(false)
    setEditingAlert(null)
  }, [])

  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar />
      <main className="mx-auto flex w-full grow flex-col gap-4 px-gutter pt-6 pb-10" style={{ maxWidth: '1400px' }}>
        <h1 className="font-display text-[26px] leading-tight font-semibold">{prefs.title}</h1>
        <Note>{prefs.intro}</Note>

        {/* Status notices */}
        {notice === 'saved' ? (
          <Card accent>
            <p className="text-meta leading-relaxed">{prefs.saved}</p>
          </Card>
        ) : null}
        {notice === 'company' ? (
          <Card accent>
            <p className="text-meta leading-relaxed">{messages.account.screen.companySaved}</p>
          </Card>
        ) : null}
        {notice === 'disconnected' ? (
          <Card>
            <p className="text-meta leading-relaxed">{copy.connected.disconnected}</p>
          </Card>
        ) : null}
        {notice === 'criado' ? (
          <Card accent>
            <p className="text-meta leading-relaxed">Alerta criado com sucesso</p>
          </Card>
        ) : null}
        {notice === 'atualizado' ? (
          <Card accent>
            <p className="text-meta leading-relaxed">Alerta atualizado com sucesso</p>
          </Card>
        ) : null}
        {notice === 'removido' ? (
          <Card accent>
            <p className="text-meta leading-relaxed">Alerta removido com sucesso</p>
          </Card>
        ) : null}

        {/* Section 1: Telegram Weekly Digest */}
        <section className="flex flex-col gap-3 pt-4">
          <SectionLabel>{prefs.telegramLabel}</SectionLabel>

          {phase.phase === 'linked' ? (
            <>
              <Card padding="none">
                <div className="px-4 py-1">
                  <CardRow
                    label={copy.connected.title}
                    value={companyName ?? prefs.telegramHelp}
                  />
                  <CardRow label={prefs.digestLabel} value={frequencyLabel(limits)} last />
                </div>
              </Card>

              {active ? null : <Note>{copy.screen.paused}</Note>}

              <div className="flex flex-col gap-2 min-[560px]:flex-row">
                <form action={active ? pauseAction : resumeAction}>
                  <Button type="submit" variant="secondary">
                    {active ? copy.screen.pause : copy.screen.resume}
                  </Button>
                </form>
                <form action={disconnectAction}>
                  <Button type="submit" variant="secondary">
                    {copy.connected.disconnect}
                  </Button>
                </form>
              </div>
            </>
          ) : cnpj === null ? (
            <>
              <Card>
                <h2 className="font-display text-[18px] leading-tight font-semibold">
                  {copy.connect.title}
                </h2>
                <p className="pt-1 text-meta leading-relaxed text-muted">{copy.connect.body}</p>
              </Card>

              <div className="rounded-card border border-line overflow-hidden bg-fill-muted p-4">
                <p className="text-caption font-mono uppercase text-muted mb-3">Exemplo do alerta</p>
                <TelegramExamplePreview />
              </div>

              <Note>{copy.screen.needsCnpjHere}</Note>
              <CompanyForm
                action={companyAction}
                next={ALERTS_PATH}
                cnpj={null}
                invalid={notice === 'cnpj-invalid'}
                submitLabel={messages.common.save}
                hint={false}
              />
            </>
          ) : phase.phase === 'waiting' ? (
            <>
              <Card accent>
                <h2 className="font-display text-[18px] leading-tight font-semibold">
                  {hand.waitingTitle}
                </h2>
                <p className="pt-1 text-meta leading-relaxed text-muted">
                  {format(hand.waitingBody, { bot: botHandle })}
                </p>
              </Card>

              <Button
                href={phase.url}
                target="_blank"
                rel="noopener noreferrer"
                iconEnd="arrowRight"
              >
                {hand.open}
              </Button>
              <Note>{format(hand.validFor, { minutos: HANDOFF_MINUTES })}</Note>

              <StartCommand command={phase.command} botHandle={botHandle} />

              <form action={recheckAction} className="w-full">
                <Button type="submit" variant="secondary" fullWidth>
                  {hand.recheck}
                </Button>
              </form>
              <Note>{hand.stillWaiting}</Note>
            </>
          ) : phase.phase === 'failed' ? (
            <>
              <Card>
                <h2 className="font-display text-[18px] leading-tight font-semibold">
                  {hand.failedTitle}
                </h2>
                <p className="pt-1 text-meta leading-relaxed text-muted">{hand.failedBody}</p>
              </Card>
              <form action={connectAction}>
                <Button type="submit" iconEnd="arrowRight">
                  {hand.newLink}
                </Button>
              </form>
              <Note>{copy.connect.noApp}</Note>
            </>
          ) : (
            <>
              <Card>
                <h2 className="font-display text-[18px] leading-tight font-semibold">
                  {copy.connect.title}
                </h2>
                <p className="pt-1 text-meta leading-relaxed text-muted">{copy.connect.body}</p>
              </Card>

              <div className="rounded-card border border-line overflow-hidden bg-fill-muted p-4">
                <p className="text-caption font-mono uppercase text-muted mb-3">Exemplo do alerta</p>
                <TelegramExamplePreview />
              </div>

              <form action={connectAction}>
                <Button type="submit" iconEnd="arrowRight">
                  {copy.connect.cta}
                </Button>
              </form>
              <Note>{copy.connect.help}</Note>
              <Note>{copy.connect.noApp}</Note>
            </>
          )}
        </section>


        {/* Section 2: Custom Alerts Register */}
        <section className="flex flex-col gap-3 pt-6 border-t border-line">
          <div className="flex items-center justify-between gap-4 pt-4">
            <SectionLabel>Meus Alertas Customizados</SectionLabel>
            {!isFormOpen && (
              <Button onClick={() => setIsFormOpen(true)} variant="secondary">
                + Novo Alerta
              </Button>
            )}
          </div>
          <Note>Crie alertas customizados com suas próprias palavras-chave e frequência</Note>

          {isFormOpen ? (
            <div className="bg-fill-muted rounded-card border border-line p-6 mt-2">
              <h3 className="font-display text-[18px] leading-tight font-semibold mb-6">
                {editingAlert ? 'Editar alerta' : 'Criar novo alerta'}
              </h3>
              <AlertForm
                userId={userId}
                alert={editingAlert}
                limits={{ keywords: limits.keywords ?? 10 }}
                onSubmit={async (data) => {
                  const formData = new FormData()
                  data.keywords.forEach((kw) => formData.append('keywords', kw))
                  data.states.forEach((state) => formData.append('states', state))
                  formData.append('frequency', data.frequency)
                  formData.append('channel', data.channel)

                  try {
                    if (editingAlert) {
                      await updateAlertAction(editingAlert.id, formData)
                      window.location.href = '/conta/alertas?estado=atualizado'
                    } else {
                      await createAlertAction(formData)
                      window.location.href = '/conta/alertas?estado=criado'
                    }
                  } catch (error) {
                    console.error('Failed to save alert:', error)
                    throw error
                  }
                }}
                onCancel={handleCancel}
              />
            </div>
          ) : (
            <AlertList
              alerts={alerts}
              onEdit={handleEdit}
              onDelete={async (alertId) => {
                if (confirm('Deseja remover este alerta?')) {
                  try {
                    await deleteAlertAction(alertId)
                    window.location.href = '/conta/alertas?estado=removido'
                  } catch (error) {
                    console.error('Failed to delete alert:', error)
                    throw error
                  }
                }
              }}
              isEmpty={alerts.length === 0}
            />
          )}
        </section>
      </main>
    </div>
  )
}
