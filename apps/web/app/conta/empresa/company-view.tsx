import { Card, CardRow, SectionLabel } from '@/components'

import { messages } from '@/lib/messages'
import { COMPANY_PATH } from '@/lib/routes'
import { AccountChrome } from '../account-chrome'
import { type AccountNotice, formatCnpj } from '../account-view'
import { CompanyForm } from '../company-form'

/**
 * `/conta/empresa` — the CNPJ, and changing it (card **D22**).
 *
 * Split out of `/conta`, where it shared one page with the plan and the
 * profile and was reachable by a menu entry that landed on a heading saying
 * something else. The CNPJ earns its own screen for the reason E3 gave it its
 * own section: it is the single input that decides which editais this account
 * ever sees, so it gets a label and a hint rather than a pencil icon.
 *
 * The heading is `radar.menu.company` — the words the reader tapped to get
 * here. This split invented no new user-facing copy.
 */

const copy = messages.account.screen

export function CompanyView({
  plan,
  planName,
  cnpj,
  companyName,
  notice,
  companyAction,
}: {
  plan: string
  planName: string
  cnpj: string | null
  companyName: string | null
  notice: AccountNotice
  companyAction: (formData: FormData) => void | Promise<void>
}) {
  return (
    <AccountChrome plan={plan} planName={planName} title={messages.radar.menu.company}>
      <Card padding="none">
        <div className="px-4 py-1">
          <CardRow
            label={copy.companyLabel}
            value={cnpj ? (companyName ?? formatCnpj(cnpj)) : copy.companyNone}
            last
          />
        </div>
      </Card>

      {notice === 'company' ? (
        <Card accent>
          <p className="text-meta leading-relaxed">{copy.companySaved}</p>
        </Card>
      ) : null}
      {cnpj && !companyName ? (
        <p className="text-meta leading-relaxed text-muted">{copy.companyPending}</p>
      ) : null}

      <section className="flex flex-col gap-2 pt-2">
        <SectionLabel>{copy.companyTitle}</SectionLabel>
        {/* `next` is this page, not `/conta`. Saving a CNPJ used to bounce the
            reader to a different screen than the one they were on, which was
            invisible while there was only one. */}
        <CompanyForm
          action={companyAction}
          next={COMPANY_PATH}
          cnpj={cnpj}
          invalid={notice === 'cnpj-invalid'}
          submitLabel={cnpj ? copy.companyChange : copy.companySave}
        />
      </section>
    </AccountChrome>
  )
}
