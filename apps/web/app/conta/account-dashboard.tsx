'use client'

import { useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { Tabs, TabPanel } from '@/components/tabs'
import { messages } from '@/lib/messages'
import { AccountView, type AccountViewProps } from './account-view'
import { AccountViewRedesigned } from './account-view-redesigned'
import { CompanyViewRedesigned } from './empresa/company-view-redesigned'
import { PlanViewRedesigned } from './plano/plan-view-redesigned'
import { ProfileViewRedesigned } from './perfil/profile-view-redesigned'
import type { AccountNotice } from './account-view'
import type { QuotaView } from '@/lib/radar/contract'
import type { Subscription } from '@/lib/asaas/subscription'
import type { PlanState } from './plano/states'

export type AccountDashboardProps = {
  account: AccountViewProps & { quota?: QuotaView }
  company: {
    cnpj: string | null
    companyName: string | null
    notice: AccountNotice
    companyAction: (formData: FormData) => void | Promise<void>
  }
  plan: {
    quota: QuotaView
    founderSeat: number | null
    seatTotal: number
    subscription: Subscription | null | 'unavailable'
    canBill: boolean
    state?: PlanState | null
    confirmingCancel?: boolean
    onCheckout: (data: FormData) => void
    onCancel: () => void
  }
  profile: {
    action: (formData: FormData) => Promise<void>
    values: {
      name: string | null
      birthDate: string | null
      mobile: string | null
      cnpj: string | null
    }
    errors: string[]
    plan: string
    planName: string
  }
  plan_key: string
  planName: string
}

type TabId = 'conta' | 'empresa' | 'plano' | 'perfil'

export function AccountDashboard({
  account,
  company,
  plan,
  profile,
  plan_key,
  planName,
}: AccountDashboardProps) {
  const searchParams = useSearchParams()
  const tabParam = searchParams.get('tab') as TabId | null
  const [activeTab, setActiveTab] = useState<TabId>(tabParam || 'conta')

  const tabs = [
    { id: 'conta' as TabId, label: 'Conta' },
    { id: 'empresa' as TabId, label: messages.radar.menu.company },
    { id: 'plano' as TabId, label: 'Plano' },
    { id: 'perfil' as TabId, label: 'Perfil' },
  ]

  const handleTabChange = (id: TabId) => {
    setActiveTab(id)
    const url = new URL(window.location.href)
    url.searchParams.set('tab', id)
    window.history.replaceState(null, '', url)
  }

  return (
    <div className="mx-auto w-full flex flex-col gap-4 px-gutter pt-6 pb-10">
      <div>
        <h1 className="font-display text-[32px] leading-tight font-semibold">{messages.account.screen.title}</h1>
        <p className="text-meta text-muted">{messages.account.screen.subtitle}</p>
      </div>

      <Tabs
        items={tabs}
        active={activeTab}
        onSelect={handleTabChange}
        idPrefix="account"
      />

      <TabPanel idPrefix="account" id="conta" isActive={activeTab === 'conta'}>
        <AccountViewRedesigned {...account} hideTitle />
      </TabPanel>

      <TabPanel idPrefix="account" id="empresa" isActive={activeTab === 'empresa'}>
        <CompanyViewRedesigned {...company} plan={plan_key} planName={planName} hideTitle />
      </TabPanel>

      <TabPanel idPrefix="account" id="plano" isActive={activeTab === 'plano'}>
        <PlanViewRedesigned {...plan} plan={plan_key} planName={planName} hideTitle />
      </TabPanel>

      <TabPanel idPrefix="account" id="perfil" isActive={activeTab === 'perfil'}>
        <ProfileViewRedesigned {...profile} hideTitle />
      </TabPanel>
    </div>
  )
}
