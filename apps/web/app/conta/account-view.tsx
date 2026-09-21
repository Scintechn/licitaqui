import Link from 'next/link'
import { AppBar, Button, Card, CardRow, Logo, SectionLabel, Tag } from '@/components'
import { format, messages } from '@/lib/messages'
import type { QuotaView } from '@/lib/radar/contract'
import { ALERTS_HREF, PLAN_HREF } from '@/lib/routes'

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
}

/**
 * "Para corrigir ou apagar seus dados, escreva para …" (§12), or nothing.
 *
 * `support.email` is still E0's `TODO(Sci)` placeholder. Task F1 hit the same
 * thing and took the same decision: a sentence naming an address that does not
 * exist is worse than no sentence, so the line is omitted until the address is
 * decided and appears here the moment it is.
 */
const DATA_REQUEST = messages.support.email.startsWith('TODO')
  ? null
  : format(messages.legal.dataRequest, { email: messages.support.email })

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
          {DATA_REQUEST ? (
            <p className="text-meta leading-relaxed text-muted">{DATA_REQUEST}</p>
          ) : null}
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
