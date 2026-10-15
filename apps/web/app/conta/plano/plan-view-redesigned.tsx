'use client'

import { Button } from '@/components'
import type { Subscription } from '@/lib/asaas/subscription'
import { cn } from '@/lib/cn'
import { format, messages } from '@/lib/messages'
import type { QuotaView } from '@/lib/radar/contract'
import { moneyExact } from '@/lib/radar/format'
import { DEFAULT_SUBSCRIPTION_METHOD, SUBSCRIPTION_METHODS } from '@/lib/asaas/method'
import { PLAN_HREF, PLAN_PATH, PROFILE_PATH } from '@/lib/routes'
import { withQuery } from '@/lib/url'
import { AccountChrome } from '../account-chrome'
import { screeningsLabel } from '../account-view'
import type { PlanState } from './states'

const copy = messages.account.screen
const billing = messages.billing
const profile = messages.account.profile

function planDate(iso: string | null): string | null {
  if (!iso) return null
  const [year, month, day] = iso.slice(0, 10).split('-')
  return year && month && day ? `${day}/${month}/${year}` : null
}

function statusLine(subscription: Subscription): string {
  if (subscription.status === 'active') return billing.status.active
  if (subscription.status === 'canceled') return billing.status.cancelled
  if (subscription.status === 'overdue') return billing.status.overdue
  return billing.status.pending
}

function notice(state: PlanState | null): { title: string | null; body: string } | null {
  if (state === 'cancelado') {
    return { title: billing.cancel.doneTitle, body: billing.cancel.doneBody }
  }
  if (state === 'ativo') {
    return { title: billing.confirmed.title, body: billing.confirmed.body }
  }
  if (state === 'aguardando') {
    return { title: billing.status.pending, body: billing.subscribe.redirect }
  }
  if (state === 'cadastro-salvo') {
    return { title: null, body: profile.saved }
  }
  if (state === 'erro' || state === 'muitas-tentativas' || state === 'sem-assinatura') {
    return { title: null, body: billing.subscribe.error }
  }
  return null
}

export function PlanViewRedesigned({
  plan,
  planName,
  quota,
  founderSeat,
  seatTotal,
  subscription,
  canBill,
  state = null,
  confirmingCancel = false,
  onCheckout,
  onCancel,
  hideTitle,
}: {
  plan: string
  planName: string
  quota: QuotaView
  founderSeat: number | null
  seatTotal: number
  subscription: Subscription | null | 'unavailable'
  canBill: boolean
  state?: PlanState | null
  confirmingCancel?: boolean
  onCheckout: (formData: FormData) => void
  onCancel: () => void
  hideTitle?: boolean
}) {
  const banner = notice(state)
  const live = subscription !== null && subscription !== 'unavailable'
  const cancelled = live && subscription.status === 'canceled'
  const cancellable = live && subscription.status !== 'canceled' && subscription.status !== 'suspended'
  const nextCharge = live ? planDate(subscription.nextChargeOn) : null
  const amount = live ? moneyExact(subscription.amount) : null
  const promoEnds = live ? planDate(subscription.promoEndsOn) : null
  const endsOn = live ? planDate(subscription.endsOn) : null

  const content = (
    <div className="flex flex-col gap-8 py-6 mt-4">
        {/* Banner Notice */}
        {banner ? (
          <div className="rounded-lg border border-line bg-surface p-6">
            {banner.title ? <h2 className="text-lead font-semibold">{banner.title}</h2> : null}
            <p className={cn('text-meta leading-relaxed', banner.title && 'mt-1')}>{banner.body}</p>
            {state === 'ativo' ? (
              <div className="pt-3">
                <Button href="/radar" iconEnd="arrowRight">
                  {billing.confirmed.cta}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        {/* Plan Information Cards */}
        <section>
          <h2 className="sr-only">Plan Details</h2>
          <div className="grid grid-cols-1 gap-6 min-[560px]:grid-cols-2 lg:grid-cols-3">
            <PlanInfoCard label={copy.planLabel} value={planName || plan} detail="Plano atual" />
            <PlanInfoCard
              label={copy.screeningsLabel}
              value={screeningsLabel(quota)}
              detail="Triagens por mês"
            />
            {founderSeat ? (
              <PlanInfoCard
                label={copy.founderLabel}
                value={format(copy.founderSeat, { numero: founderSeat, total: seatTotal })}
                detail="Fundador"
              />
            ) : null}
            {live ? (
              <PlanInfoCard label={messages.radar.menu.billing} value={statusLine(subscription)} detail="Status" />
            ) : null}
          </div>
        </section>

        {/* Subscription Details */}
        {live && nextCharge && amount && subscription.status !== 'canceled' ? (
          <p className="text-meta leading-relaxed text-muted">
            {format(billing.status.nextCharge, { data: nextCharge, valor: amount })}
          </p>
        ) : null}

        {live && subscription.status === 'canceled' && endsOn ? (
          <p className="text-meta leading-relaxed text-muted">
            {format(billing.cancel.untilWhen, { data: endsOn })}
          </p>
        ) : null}

        {live && subscription.lastPayment?.paidOn && moneyExact(subscription.lastPayment.amount) ? (
          <p className="text-meta leading-relaxed text-muted">
            {format(billing.status.lastPayment, {
              valor: moneyExact(subscription.lastPayment.amount) as string,
              data: planDate(subscription.lastPayment.paidOn) as string,
            })}
          </p>
        ) : null}

        {/* Price Change Notice */}
        {live && promoEnds && subscription.status !== 'canceled' ? (
          <div className="rounded-lg border border-line bg-surface p-6">
            <h2 className="text-lead font-semibold">
              {format(billing.priceChange.bannerTitle, { data: promoEnds })}
            </h2>
            <p className="mt-1 text-meta leading-relaxed text-muted">
              {format(billing.priceChange.bannerBody, { data: promoEnds })}
            </p>
            <p className="mt-1 text-meta leading-relaxed text-muted">
              {format(billing.priceChange.bannerCancel, { data: promoEnds })}
            </p>
            <p className="mt-3 text-label font-mono uppercase tracking-[0.06em] text-muted">
              {billing.priceChange.detailTitle}
            </p>
            <ul className="mt-1 list-none text-meta leading-relaxed text-muted">
              <li>{billing.priceChange.detailNow}</li>
              <li>{format(billing.priceChange.detailAfter, { data: promoEnds })}</li>
              <li>{billing.priceChange.detailSame}</li>
            </ul>
          </div>
        ) : null}

        {/* Cancel Confirmation */}
        {confirmingCancel && cancellable ? (
          <div className="rounded-lg border border-line bg-surface p-6">
            <h2 className="text-lead font-semibold">{billing.cancel.title}</h2>
            <p className="mt-1 text-meta leading-relaxed text-muted">{billing.cancel.body}</p>
            <div className="flex flex-col gap-2 pt-3 min-[560px]:flex-row">
              <form action={onCancel}>
                <Button type="submit" variant="primary" fullWidth>
                  {billing.cancel.confirm}
                </Button>
              </form>
              <Button href={PLAN_PATH} variant="secondary">
                {billing.cancel.keep}
              </Button>
            </div>
          </div>
        ) : null}

        {/* Subscription Controls */}
        {(!live || cancelled) && canBill && subscription !== 'unavailable' ? (
          <section className="flex flex-col gap-4">
            <h2 className="text-base font-semibold text-ink">{billing.subscribe.title}</h2>
            <div className="rounded-lg border border-line bg-surface p-6">
              <form action={onCheckout} className="flex flex-col gap-3">
                <fieldset className="flex flex-col gap-2">
                  <legend className="pb-1 text-meta font-medium">
                    {billing.subscribe.methodLegend}
                  </legend>
                  {SUBSCRIPTION_METHODS.map((value) => (
                    <label key={value} className="flex items-start gap-2 text-body">
                      <input
                        type="radio"
                        name="metodo"
                        value={value}
                        defaultChecked={value === DEFAULT_SUBSCRIPTION_METHOD}
                        className="mt-1 size-4 shrink-0 accent-blue"
                      />
                      <span className="flex flex-col">
                        <span>
                          {value === 'PIX'
                            ? billing.subscribe.methodPix
                            : billing.subscribe.methodCard}
                        </span>
                        <span className="text-meta text-muted">
                          {value === 'PIX'
                            ? billing.subscribe.methodPixHelp
                            : billing.subscribe.methodCardHelp}
                        </span>
                      </span>
                    </label>
                  ))}
                </fieldset>
                <Button type="submit" variant="primary" iconEnd="arrowRight" fullWidth>
                  {billing.subscribe.cta}
                </Button>
              </form>
            </div>
          </section>
        ) : null}

        {/* Pending Payment Link */}
        {live && subscription.checkoutUrl && subscription.status !== 'active' && subscription.status !== 'canceled' ? (
          <div className="rounded-lg border border-line bg-surface p-6">
            <p className="mb-3 text-sm text-muted">Pagamento pendente</p>
            <Button href={subscription.checkoutUrl} variant="primary" iconEnd="arrowRight" rel="noreferrer" fullWidth>
              {billing.subscribe.cta}
            </Button>
          </div>
        ) : null}

        {/* Missing Profile for Billing */}
        {(!live || cancelled) && !canBill ? (
          <div className="rounded-lg border border-line bg-surface p-6">
            <h2 className="text-lead font-semibold">{profile.needProfileTitle}</h2>
            <p className="mt-1 text-body text-muted">{profile.needProfileBody}</p>
            <div className="pt-3">
              <Button href={PROFILE_PATH} variant="secondary" className="self-start">
                {profile.needProfileAction}
              </Button>
            </div>
          </div>
        ) : null}

        {/* Secondary Actions */}
        <div className="flex flex-col gap-2 pt-2 min-[560px]:flex-row">
          {!live || cancelled ? (
            <Button href={PLAN_HREF} variant="secondary">
              {copy.plans}
            </Button>
          ) : null}

          {cancellable && !confirmingCancel ? (
            <Button href={withQuery(PLAN_PATH, 'cancelar=1')} variant="secondary">
              {billing.cancel.cta}
            </Button>
          ) : null}
        </div>

        {/* Notes */}
        {founderSeat && !live ? (
          <p className="text-meta leading-relaxed text-muted">{copy.founderNote}</p>
        ) : null}

        {!live || cancelled ? (
          <p className="text-meta leading-relaxed text-muted">{billing.subscribe.methods}</p>
        ) : null}
    </div>
  )

  if (hideTitle) return content

  return (
    <AccountChrome plan={plan} planName={planName} title={messages.radar.menu.billing}>
      {content}
    </AccountChrome>
  )
}

interface PlanInfoCardProps {
  label: string
  value: string
  detail: string
}

function PlanInfoCard({ label, value, detail }: PlanInfoCardProps) {
  return (
    <div className="rounded-lg border border-line bg-surface p-6 transition-all hover:border-blue hover:shadow-sm">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
        {label}
      </div>
      <div className="mb-1 text-xl font-semibold text-ink">{value}</div>
      <div className="text-sm text-muted">{detail}</div>
    </div>
  )
}
