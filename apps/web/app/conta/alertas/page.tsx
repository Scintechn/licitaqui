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
import { saveCompany } from '../actions'
import {
  connectTelegram,
  disconnectTelegram,
  pauseTelegram,
  recheckTelegram,
  resumeTelegram,
  savePreferences,
} from './actions'
import { AlertsView, type AlertNotice } from './alerts-view'

/**
 * `/conta/alertas` — the Telegram connection and the weekly digest's filters
 * (tasks E1 and E3, spec §10).
 *
 * Dynamic, never cached, never indexed, like `/conta`: it is one person's
 * account (§3.3). No session means no page.
 *
 * The page does all the I/O and hands a pure view everything, including the
 * Server Functions as props, so the view renders in a vitest with no database
 * and no session — the house pattern.
 *
 * ## E3: three reads, not two
 *
 * `linkPhase` needs the account-wide fact (`pending`, from `telegram_links`)
 * **and** this browser's fact (the hand-off cookie holding the plaintext
 * token). Neither is a new column: see `lib/telegram/handoff.ts` for why the
 * token's own signed expiry is the only clock involved.
 *
 * The cookie is read here rather than in the view because `next/headers` is
 * request-scoped and the view has to render in a test with neither.
 */

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
  // The session names a user who is gone (an LGPD deletion, a rolled-back
  // database). Signing in again is the only honest next step.
  if (!user) redirect(ACCOUNT_CREATE_PATH)

  const userId = Number(id)
  const [status, limits, company, jar] = await Promise.all([
    readLinkStatus(userId, executor),
    readAlertLimits(user.plan, executor),
    user.cnpj
      ? executor.execute<{ name: string | null }>(sql`
          select coalesce(trade_name, legal_name) as name from companies where cnpj = ${user.cnpj}
        `)
      : null,
    cookies(),
  ])

  const phase = linkPhase({
    linked: status.linked,
    pending: status.pending,
    handoffToken: jar.get(HANDOFF_COOKIE)?.value ?? null,
  })

  return (
    <AlertsView
      phase={phase}
      active={status.active}
      limits={limits}
      cnpj={user.cnpj}
      companyName={company?.rows[0]?.name ?? null}
      botHandle={botHandle()}
      keyword={status.keyword}
      states={status.states}
      notice={noticeFrom(one((await searchParams).estado))}
      connectAction={connectTelegram}
      recheckAction={recheckTelegram}
      disconnectAction={disconnectTelegram}
      pauseAction={pauseTelegram}
      resumeAction={resumeTelegram}
      saveAction={savePreferences}
      companyAction={saveCompany}
    />
  )
}
