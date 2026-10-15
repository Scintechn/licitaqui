'use client'

import { useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { Tabs, TabPanel } from '@/components/tabs'
import { messages } from '@/lib/messages'
import { AccountView, type AccountViewProps } from './account-view'
import { CompanyView } from './empresa/company-view'
import { PlanView } from './plano/plan-view'
import { ProfileView } from './perfil/profile-view'
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
    <div className="flex flex-col gap-4">
      <Tabs
        items={tabs}
        active={activeTab}
        onSelect={handleTabChange}
        idPrefix="account"
      />

      <TabPanel idPrefix="account" id="conta" isActive={activeTab === 'conta'}>
        <AccountView {...account} />
      </TabPanel>

      <TabPanel idPrefix="account" id="empresa" isActive={activeTab === 'empresa'}>
        <CompanyView {...company} plan={plan_key} planName={planName} />
      </TabPanel>

      <TabPanel idPrefix="account" id="plano" isActive={activeTab === 'plano'}>
        <PlanView {...plan} plan={plan_key} planName={planName} />
      </TabPanel>

      <TabPanel idPrefix="account" id="perfil" isActive={activeTab === 'perfil'}>
        <ProfileView {...profile} />
      </TabPanel>
    </div>
  )
}
