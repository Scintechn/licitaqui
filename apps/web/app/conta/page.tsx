import type { Metadata } from 'next'
import { readSubscription } from '@/lib/asaas/subscription'
import { readDraft } from '@/lib/profile/draft'
import { messages } from '@/lib/messages'
import { FOUNDERS } from '@/lib/product'
import { readAccountData } from './account-data'
import { signOutEverywhere } from './actions'
import { saveCompany } from './actions'
import { goToCheckout, confirmCancel } from './plano/actions'
import { planState } from './plano/states'
import { saveProfile } from './perfil/actions'
import { noticeFrom } from './notice'
import { AccountDashboard } from './account-dashboard'

/**
 * `/conta` — unified account dashboard (spec §10, §6.2).
 *
 * Consolidated view with tabs for Account, Company, Plan, and Profile.
 * Dynamic, never cached, never indexed: it is the most personal page on the
 * site (§3.3). No session means no page — a visitor is sent to `/conta/criar`
 * rather than shown an empty shell, because there is nothing here that is
 * theirs yet.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: messages.account.meta.title,
  description: messages.account.meta.description,
  robots: { index: false, follow: false },
}

type SearchParams = Promise<{ [key: string]: string | string[] | undefined }>

export default async function AccountPage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const account = await readAccountData()
  const subscription = await readSubscription(account.userId)
  const draft = await readDraft()
  const search = (await searchParams) ?? {}

  const profileErrors = String(Array.isArray(search.erro) ? search.erro[0] : search.erro ?? '')
    .split(',')
    .filter((field) => ['nome', 'nascimento', 'celular', 'cnpj'].includes(field))

  return (
    <AccountDashboard
      account={{
        email: account.email,
        plan: account.plan,
        planName: account.planName,
        signOutAction: signOutEverywhere,
        quota: account.quota,
      }}
      company={{
        cnpj: account.cnpj,
        companyName: account.companyName,
        notice: noticeFrom((await searchParams).estado),
        companyAction: saveCompany,
      }}
      plan={{
        quota: account.quota!,
        founderSeat: account.founderSeat,
        seatTotal: FOUNDERS.seatsTotal,
        subscription:
          subscription.state === 'found' ? subscription.subscription
          : subscription.state === 'unavailable' ? 'unavailable'
          : null,
        canBill: Boolean(account.cnpj?.trim()) && Boolean(account.userName?.trim()),
        state: planState(search.estado),
        confirmingCancel: search.cancelar === '1',
        onCheckout: goToCheckout,
        onCancel: confirmCancel,
      }}
      profile={{
        action: saveProfile,
        values: {
          name: draft?.name ?? account.userName,
          birthDate: draft?.birthDate ?? account.birthDate,
          mobile: draft?.mobile ?? account.whatsapp,
          cnpj: draft?.cnpj ?? account.cnpj,
        },
        errors: profileErrors,
        plan: account.plan,
        planName: account.planName,
      }}
      plan_key={account.plan}
      planName={account.planName}
    />
  )
}
