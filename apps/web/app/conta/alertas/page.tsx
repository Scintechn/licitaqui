import { sql } from 'drizzle-orm'
import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { messages } from '@/lib/messages'
import { ACCOUNT_CREATE_PATH } from '@/lib/routes'
import { botHandle, HANDOFF_COOKIE, linkPhase } from '@/lib/telegram/handoff'
import { readLinkStatus } from '@/lib/telegram/link'
import { readAlertLimits } from '@/lib/telegram/quota'
import { readUserAlerts } from '@/lib/alerts/queries'
import { saveCompany } from '../actions'
import {
  connectTelegram,
  disconnectTelegram,
  pauseTelegram,
  recheckTelegram,
  resumeTelegram,
  savePreferences,
  createAlert,
  updateAlert,
  deleteAlert,
} from './actions'
import { AlertsPage as AlertsPageComponent, type AlertNotice } from './alerts-page'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: messages.notifications.title,
  description: messages.telegram.connect.body,
  robots: { index: false, follow: false },
}

type Row = { plan: string; cnpj: string | null }
type Search = Promise<{ [key: string]: string | string[] | undefined }>

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function noticeFrom(value: string | undefined): AlertNotice {
  if (value === 'salvo') return 'saved'
  if (value === 'desconectado') return 'disconnected'
  if (value === 'empresa') return 'company'
  if (value === 'cnpj-invalido') return 'cnpj-invalid'
  if (value === 'criado') return 'criado'
  if (value === 'atualizado') return 'atualizado'
  if (value === 'removido') return 'removido'
  return null
}

export default async function AlertsPage({ searchParams }: { searchParams: Search }) {
  const session = await auth()
  const id = session?.user?.id
  if (!id) redirect(ACCOUNT_CREATE_PATH)

  const executor = db()
  const found = await executor.execute<Row>(sql`
    select plan, cnpj from users where id = ${id}::bigint
  `)
  const user = found.rows[0]
  if (!user) redirect(ACCOUNT_CREATE_PATH)

  const userId = Number(id)
  const [status, limits, company, alerts, jar] = await Promise.all([
    readLinkStatus(userId, executor),
    readAlertLimits(user.plan, executor),
    user.cnpj
      ? executor.execute<{ name: string | null }>(sql`
          select coalesce(trade_name, legal_name) as name from companies where cnpj = ${user.cnpj}
        `)
      : null,
    readUserAlerts(userId, executor),
    cookies(),
  ])

  const phase = linkPhase({
    linked: status.linked,
    pending: status.pending,
    handoffToken: jar.get(HANDOFF_COOKIE)?.value ?? null,
  })

  return (
    <AlertsPageComponent
      userId={userId}
      phase={phase}
      active={status.active}
      limits={limits}
      cnpj={user.cnpj}
      companyName={company?.rows[0]?.name ?? null}
      botHandle={botHandle()}
      keywords={status.keywords}
      states={status.states}
      alerts={alerts}
      notice={noticeFrom(one((await searchParams).estado))}
      connectAction={connectTelegram}
      recheckAction={recheckTelegram}
      disconnectAction={disconnectTelegram}
      pauseAction={pauseTelegram}
      resumeAction={resumeTelegram}
      saveAction={savePreferences}
      companyAction={saveCompany}
      createAlertAction={createAlert}
      updateAlertAction={updateAlert}
      deleteAlertAction={deleteAlert}
    />
  )
}
