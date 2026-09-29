import type { Metadata } from 'next'
import { messages } from '@/lib/messages'
import { readAccountData } from './account-data'
import { AccountView } from './account-view'
import { signOutEverywhere } from './actions'

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

export default async function AccountPage() {
  const account = await readAccountData()
  return <AccountView plan={account.plan} planName={account.planName} signOutAction={signOutEverywhere} />
}
