'use client'

import { messages } from '@/lib/messages'
import { AccountChrome } from '../account-chrome'
import { type AccountNotice, formatCnpj } from '../account-view'
import { CompanyForm } from '../company-form'
import { COMPANY_PATH } from '@/lib/routes'

const copy = messages.account.screen

export function CompanyViewRedesigned({
  plan,
  planName,
  cnpj,
  companyName,
  notice,
  companyAction,
  hideTitle,
}: {
  plan: string
  planName: string
  cnpj: string | null
  companyName: string | null
  notice: AccountNotice
  companyAction: (formData: FormData) => void | Promise<void>
  hideTitle?: boolean
}) {
  const content = (
    <div className="flex flex-col gap-8 py-6">
        {/* Company Status Cards */}
        <section>
          <h2 className="sr-only">Company Information</h2>
          <div className="grid grid-cols-1 gap-6 min-[560px]:grid-cols-2">
            <CompanyInfoCard
              label={copy.companyLabel}
              value={cnpj ? (companyName ?? formatCnpj(cnpj)) : copy.companyNone}
              detail={cnpj ? 'CNPJ registrado' : 'Nenhum CNPJ vinculado'}
            />
            <CompanyStatusCard notice={notice} />
          </div>
        </section>

        {/* Success Notice */}
        {notice === 'company' ? (
          <div className="rounded-lg border border-line bg-surface p-6">
            <p className="text-meta leading-relaxed">{copy.companySaved}</p>
          </div>
        ) : null}

        {/* Pending Company Name */}
        {cnpj && !companyName ? (
          <p className="text-meta leading-relaxed text-muted">{copy.companyPending}</p>
        ) : null}

        {/* Company Form Section */}
        <section className="flex flex-col gap-4">
          <h2 className="text-base font-semibold text-ink">{copy.companyTitle}</h2>
          <div className="rounded-lg border border-line bg-surface p-6">
            <CompanyForm
              action={companyAction}
              next={COMPANY_PATH}
              cnpj={cnpj}
              invalid={notice === 'cnpj-invalid'}
              submitLabel={cnpj ? copy.companyChange : copy.companySave}
            />
          </div>
        </section>
      </div>
  )

  if (hideTitle) return content

  return (
    <AccountChrome plan={plan} planName={planName} title={messages.radar.menu.company}>
      {content}
    </AccountChrome>
  )
}

interface CompanyInfoCardProps {
  label: string
  value: string
  detail: string
}

function CompanyInfoCard({ label, value, detail }: CompanyInfoCardProps) {
  return (
    <div className="rounded-lg border border-line bg-surface p-6 transition-all hover:border-blue hover:shadow-sm">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
        {label}
      </div>
      <div className="mb-1 text-xl font-semibold text-ink break-all">{value}</div>
      <div className="text-sm text-muted">{detail}</div>
    </div>
  )
}

interface CompanyStatusCardProps {
  notice: AccountNotice
}

function CompanyStatusCard({ notice }: CompanyStatusCardProps) {
  let statusValue = 'Configurar'
  let statusDetail = 'Adicione um CNPJ'

  if (notice === 'company') {
    statusValue = 'Completo'
    statusDetail = 'Empresa vinculada'
  } else if (notice === 'cnpj-invalid') {
    statusValue = 'Erro'
    statusDetail = 'CNPJ inválido'
  }

  return (
    <div className="rounded-lg border border-line bg-surface p-6 transition-all hover:border-blue hover:shadow-sm">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
        Status da Empresa
      </div>
      <div className="mb-1 text-xl font-semibold text-ink">{statusValue}</div>
      <div className="text-sm text-muted">{statusDetail}</div>
    </div>
  )
}
