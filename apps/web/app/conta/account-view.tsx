import Link from 'next/link'
import { AppBar, Button, Card, CardRow, Logo, SectionLabel, Tag } from '@/components'
import { format, messages } from '@/lib/messages'
import type { QuotaView } from '@/lib/radar/contract'
import { ACCOUNT_PATH, ALERTS_HREF, PLAN_HREF } from '@/lib/routes'
import { CompanyForm } from './company-form'

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
  /** Screenings: the feature this plan is actually measured by. */
  quota: QuotaView
  /** The company this account searched, or `null`. */
  cnpj: string | null
  companyName: string | null
  /** 1..48 when they came from the founders list. */
  founderSeat: number | null
  /** The total number of founder seats — `founders_list.seat`'s check. */
  seatTotal: number
  signOutAction: () => void | Promise<void>
  /**
   * `saveCompany` (task E3). The account setting `rememberUserCnpj` has been
   * deferring to since U1: until it existed, the first company anybody searched
   * in the Radar was theirs permanently.
   */
  companyAction: (formData: FormData) => void | Promise<void>
  /** `?estado=…` after `saveCompany` redirected back here. */
  notice: AccountNotice
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

const PLAN_NAMES: Record<string, string> = {
  basico: messages.plans.basic.name,
  promocional: messages.plans.promo.name,
  essencial: messages.plans.essential.name,
  pro: messages.plans.pro.name,
}

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
  quota,
  cnpj,
  companyName,
  founderSeat,
  seatTotal,
  signOutAction,
  companyAction,
  notice,
}: AccountViewProps) {
  return (
    <div className="flex min-h-dvh flex-col">
      <AppBar
        leading={
          <Link href="/" aria-label={messages.radar.nav.home} className="inline-flex">
            <Logo size={30} />
          </Link>
        }
        actions={<Tag tone="muted">{PLAN_NAMES[plan] ?? plan}</Tag>}
      />
      <main className="mx-auto flex w-full max-w-[560px] grow flex-col gap-4 px-gutter pt-6 pb-10">
        <h1 className="font-display text-[26px] leading-tight font-semibold">{copy.title}</h1>

        <Card padding="none">
          <div className="px-4 py-1">
            <CardRow label={copy.planLabel} value={PLAN_NAMES[plan] ?? plan} />
            <CardRow label={copy.screeningsLabel} value={screeningsLabel(quota)} />
            <CardRow
              label={copy.companyLabel}
              value={cnpj ? (companyName ?? formatCnpj(cnpj)) : copy.companyNone}
              last={!founderSeat}
            />
            {founderSeat ? (
              <CardRow
                label={copy.founderLabel}
                value={format(copy.founderSeat, { numero: founderSeat, total: seatTotal })}
                last
              />
            ) : null}
          </div>
        </Card>

        {founderSeat ? (
          <p className="text-meta leading-relaxed text-muted">{copy.founderNote}</p>
        ) : null}

        {notice === 'company' ? (
          <Card accent>
            <p className="text-meta leading-relaxed">{copy.companySaved}</p>
          </Card>
        ) : null}
        {cnpj && !companyName ? (
          <p className="text-meta leading-relaxed text-muted">{copy.companyPending}</p>
        ) : null}

        {/*
          Task E3. The row above states the company; this changes it. A separate
          section rather than an inline control on the row, because the CNPJ is
          the single input that decides which editais this account ever sees —
          it earns a label and a hint, not a pencil icon.
        */}
        <section className="flex flex-col gap-2 pt-2">
          <SectionLabel>{copy.companyTitle}</SectionLabel>
          <CompanyForm
            action={companyAction}
            next={ACCOUNT_PATH}
            cnpj={cnpj}
            invalid={notice === 'cnpj-invalid'}
            submitLabel={cnpj ? copy.companyChange : copy.companySave}
          />
        </section>

        <div className="flex flex-col gap-2 min-[560px]:flex-row">
          <Button href="/radar" iconEnd="arrowRight">
            {copy.radar}
          </Button>
          <Button href={ALERTS_HREF} variant="secondary">
            {copy.alerts}
          </Button>
          <Button href={PLAN_HREF} variant="secondary">
            {copy.plans}
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
      </main>
    </div>
  )
}
