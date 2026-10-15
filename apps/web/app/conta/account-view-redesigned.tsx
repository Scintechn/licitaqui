'use client'

import { Button } from '@/components'
import { messages } from '@/lib/messages'
import type { AccountViewProps } from './account-view'

export function AccountViewRedesigned({
  email,
  plan,
  planName,
  signOutAction,
  hideTitle,
}: AccountViewProps & { hideTitle?: boolean }) {
  return (
    <div className="flex flex-col gap-8 py-6">
      {/* Account Information Cards */}
      <section>
        <h2 className="sr-only">Account Information</h2>
        <div className="grid grid-cols-3 gap-6">
          <AccountCard
            label="Account Status"
            value="Active"
            detail="Member since Oct 2024"
          />
          <AccountCard
            label="Current Plan"
            value={planName}
            detail="See plan details"
          />
          <AccountCard
            label="Email"
            value={email}
            detail="Verified account"
            valueClass="text-sm break-all"
          />
        </div>
      </section>

      {/* Usage Statistics */}
      <section>
        <h2 className="sr-only">Account Limits</h2>
        <div className="grid grid-cols-3 gap-6">
          <AccountCard
            label="Screenings"
            value="5"
            detail="of 5 this month"
            showProgress={true}
            progressValue={100}
          />
          <AccountCard
            label="Weekly Alerts"
            value="1"
            detail="Resets every Monday"
          />
          <AccountCard
            label="Saved Favorites"
            value="28"
            detail="Open tenders"
          />
        </div>
      </section>

      {/* Quick Actions */}
      <section>
        <h2 className="sr-only">Account Management</h2>
        <div className="grid grid-cols-2 gap-6">
          <ActionCard
            title="Profile Settings"
            description="Update your personal information and contact preferences"
            buttonLabel="Edit Profile"
            buttonHref="/conta?tab=perfil"
          />
          <ActionCard
            title="Company Information"
            description="Manage your company CNPJ and business details"
            buttonLabel="Manage Company"
            buttonHref="/conta?tab=empresa"
          />
        </div>
      </section>

      {/* Data & Privacy Section */}
      <section className="mt-8 pt-8 border-t border-line">
        <h2 className="text-sm font-semibold text-muted mb-3">
          {messages.account.screen.dataTitle}
        </h2>
        <p className="text-meta text-muted leading-relaxed mb-3">
          {messages.account.screen.dataBody}
        </p>
        <p className="text-meta text-muted leading-relaxed">
          Para corrigir ou apagar seus dados, escreva para privacidade@licitaquiapp.com.br
        </p>
      </section>

      {/* Sign Out */}
      <section>
        <form action={signOutAction} className="pt-4">
          <Button type="submit" variant="secondary">
            {messages.account.screen.signOut}
          </Button>
        </form>
      </section>
    </div>
  )
}

interface AccountCardProps {
  label: string
  value: string | React.ReactNode
  detail: string
  valueClass?: string
  showProgress?: boolean
  progressValue?: number
}

function AccountCard({
  label,
  value,
  detail,
  valueClass = '',
  showProgress = false,
  progressValue = 0,
}: AccountCardProps) {
  return (
    <div className="rounded-lg border border-line bg-surface p-6 transition-all hover:border-blue hover:shadow-sm">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
        {label}
      </div>
      <div className={`mb-1 text-2xl font-semibold text-ink ${valueClass}`}>
        {value}
      </div>
      <div className="text-sm text-muted">{detail}</div>
      {showProgress && (
        <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-fill-muted">
          <div
            className="h-full rounded-full bg-blue transition-all"
            style={{ width: `${progressValue}%` }}
          />
        </div>
      )}
    </div>
  )
}

interface ActionCardProps {
  title: string
  description: string
  buttonLabel: string
  buttonHref: string
}

function ActionCard({
  title,
  description,
  buttonLabel,
  buttonHref,
}: ActionCardProps) {
  return (
    <div className="rounded-lg border border-line bg-surface p-6 transition-all hover:border-blue hover:shadow-sm">
      <h3 className="mb-2 text-base font-semibold text-ink">{title}</h3>
      <p className="mb-6 text-sm text-muted">{description}</p>
      <Button href={buttonHref} className="w-full">
        {buttonLabel}
      </Button>
    </div>
  )
}
