import { sql } from 'drizzle-orm'
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { auth } from '@/lib/auth'
import { MAX_SEAT } from '@/lib/auth/founder-seat'
import { db } from '@/lib/db'
import { messages } from '@/lib/messages'
import { countUsage, FEATURES, quotaView, readLimit } from '@/lib/radar/quota'
import { ACCOUNT_CREATE_PATH } from '@/lib/routes'
import { AccountView, type AccountNotice } from './account-view'
import { saveCompany, signOutEverywhere } from './actions'

/**
 * `/conta` — the signed-in account (spec §10, §6.2).
 *
 * Dynamic, never cached, never indexed: it is the most personal page on the
 * site (§3.3). No session means no page — a visitor is sent to `/conta/criar`
 * rather than shown an empty shell, because there is nothing here that is
 * theirs yet.
 *
 * The plan, the quota and the seat are read here and handed to a pure view.
 * `plan_limits` + `usage` are the same two tables the API routes charge
 * against, read through the same module, so this screen can never disagree with
 * what a screening request will actually allow.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: messages.account.meta.title,
  description: messages.account.meta.description,
  robots: { index: false, follow: false },
}

type Row = { plan: string; cnpj: string | null; founder_seat: number | null }

type Search = Promise<{ [key: string]: string | string[] | undefined }>

function noticeFrom(value: string | string[] | undefined): AccountNotice {
  const one = Array.isArray(value) ? value[0] : value
  if (one === 'empresa') return 'company'
  if (one === 'cnpj-invalido') return 'cnpj-invalid'
  return null
}

export default async function AccountPage({ searchParams }: { searchParams: Search }) {
  const session = await auth()
  const id = session?.user?.id
  if (!id) redirect(ACCOUNT_CREATE_PATH)

  const executor = db()
  const found = await executor.execute<Row>(sql`
    select plan, cnpj, founder_seat from users where id = ${id}::bigint
  `)
  const user = found.rows[0]
  // The session names a user who is gone (LGPD deletion, or a rolled-back
  // database). Signing in again is the only honest next step.
  if (!user) redirect(ACCOUNT_CREATE_PATH)

  const userId = Number(id)
  const limit = await readLimit(user.plan, FEATURES.screening, executor)
  const used = await countUsage({ userId }, limit, executor)

  const company = user.cnpj
    ? await executor.execute<{ name: string | null }>(sql`
        select coalesce(trade_name, legal_name) as name from companies where cnpj = ${user.cnpj}
      `)
    : null

  return (
    <AccountView
      plan={user.plan}
      quota={quotaView(limit, used)}
      cnpj={user.cnpj}
      companyName={company?.rows[0]?.name ?? null}
      founderSeat={user.founder_seat === null ? null : Number(user.founder_seat)}
      seatTotal={MAX_SEAT}
      signOutAction={signOutEverywhere}
      companyAction={saveCompany}
      notice={noticeFrom((await searchParams).estado)}
    />
  )
}
