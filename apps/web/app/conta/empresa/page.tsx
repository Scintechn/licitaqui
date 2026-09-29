import type { Metadata } from 'next'
import { messages } from '@/lib/messages'
import { readAccountData } from '../account-data'
import { saveCompany } from '../actions'
import { noticeFrom, type Search } from '../notice'
import { CompanyView } from './company-view'

/**
 * `/conta/empresa` — card **D22**.
 *
 * Dynamic, never cached, never indexed: it names the company this account
 * searched, which is as personal as the rest of `/conta` (§3.3). The session
 * check and the redirects are `readAccountData`'s, so this page cannot forget
 * them the way a fourth page added later could.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: messages.account.meta.title,
  description: messages.account.meta.description,
  robots: { index: false, follow: false },
}

export default async function CompanyPage({ searchParams }: { searchParams: Search }) {
  const account = await readAccountData()
  return (
    <CompanyView
      plan={account.plan}
      planName={account.planName}
      cnpj={account.cnpj}
      companyName={account.companyName}
      notice={noticeFrom((await searchParams).estado)}
      companyAction={saveCompany}
    />
  )
}
