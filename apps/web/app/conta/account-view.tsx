import { Button, SectionLabel } from '@/components'
import { AccountChrome } from './account-chrome'
import { format, messages } from '@/lib/messages'
import type { QuotaView } from '@/lib/radar/contract'
import { ALERTS_HREF, COMPANY_PATH, PLAN_PATH } from '@/lib/routes'

/**
 * `/conta` — what this account is and what is left of it (spec §10).
 *
 * Every number on this screen comes from `plan_limits` and `usage` through the
 * `quota` prop. Nothing is written in the markup: the legal brief's last bullet
 * in §5 is explicit that the limits are configurable without a deploy, so a
 * component that printed "5" would be wrong the first time Sci changed a row.
 * The only literal here is the 48 founder seats, which is a `check` constraint
 * in migration `0001`, not a limit.
 *
 * Pure and prop-driven so it renders in a test with no session and no database.
 */

const copy = messages.account.screen

export type AccountViewProps = {
  /** §10's plan key. The display name comes from `messages.plans`. */
  plan: string
  /** The display name, resolved by `readAccountData`. */
  planName: string
  signOutAction: () => void | Promise<void>
}

export type AccountNotice = 'company' | 'cnpj-invalid' | null

/**
 * "Para corrigir ou apagar seus dados, escreva para …" (§12).
 *
 * This is the **LGPD data-subject channel**, so it names `privacidade@`, not
 * `contato@`: legal brief §1 makes that address the mandatory channel for
 * correction and deletion requests, and the one that must never bounce.
 * Support, refunds and contractual notices go to `contato@` — a different
 * inbox for a different duty, and the line is always rendered now that both
 * addresses exist (they were an E0 `TODO(Sci)` until this task).
 */
const DATA_REQUEST = format(messages.legal.dataRequest, {
  email: messages.support.privacyEmail,
})



/** "5 de 5 neste mês", "Sem limite", "Não incluídas neste plano" — never a literal. */
export function screeningsLabel(quota: QuotaView): string {
  if (quota.limit === null) return copy.screeningsUnlimited
  if (quota.limit === 0) return copy.screeningsNone
  const template = quota.period === 'month' || quota.period === 'week'
    ? copy.screeningsMonth
    : copy.screeningsTotal
  return format(template, { usadas: quota.used, total: quota.limit })
}

/** `12345678000190` → `12.345.678/0001-90`. The account screen shows it whole. */
export function formatCnpj(cnpj: string): string {
  if (cnpj.length !== 14) return cnpj
  return `${cnpj.slice(0, 2)}.${cnpj.slice(2, 5)}.${cnpj.slice(5, 8)}/${cnpj.slice(8, 12)}-${cnpj.slice(12)}`
}

export function AccountView({
  plan,
  planName,
  signOutAction,
}: AccountViewProps) {
  return (
    <AccountChrome plan={plan} planName={planName} title={copy.title}>
        <div className="flex flex-col gap-2 min-[560px]:flex-row">
          <Button href="/radar" iconEnd="arrowRight">
            {copy.radar}
          </Button>
          <Button href={ALERTS_HREF} variant="secondary">
            {copy.alerts}
          </Button>
          <Button href={COMPANY_PATH} variant="secondary">
            {messages.radar.menu.company}
          </Button>
          <Button href={PLAN_PATH} variant="secondary">
            {messages.radar.menu.billing}
          </Button>
        </div>

        <section className="flex flex-col gap-2 pt-2">
          <SectionLabel>{copy.dataTitle}</SectionLabel>
          <p className="text-meta leading-relaxed text-muted">{copy.dataBody}</p>
          <p className="text-meta leading-relaxed text-muted">{DATA_REQUEST}</p>
        </section>

        <form action={signOutAction} className="pt-2">
          <Button type="submit" variant="secondary">
            {copy.signOut}
          </Button>
        </form>
    </AccountChrome>
  )
}
