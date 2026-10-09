import { Button, Card, CardRow } from '@/components'
import type { Subscription } from '@/lib/asaas/subscription'
import { cn } from '@/lib/cn'
import { format, messages } from '@/lib/messages'
import type { QuotaView } from '@/lib/radar/contract'
import { moneyExact } from '@/lib/radar/format'
import { COMPANY_PATH, PLAN_HREF, PLAN_PATH } from '@/lib/routes'
import { withQuery } from '@/lib/url'
import { AccountChrome } from '../account-chrome'
import { screeningsLabel } from '../account-view'
import type { PlanState } from './states'

/**
 * `/conta/plano` — what this plan includes, what is left of it, and the two
 * controls that start and stop a subscription (cards **D22**, **F2**, **D8**).
 *
 * `PLAN_PATH` has named this address since U1. D22 made it a summary; F2 makes
 * it the screen the terms of use already point at.
 *
 * **Every number comes from `plan_limits`, `usage` and `subscriptions`.**
 * Nothing is written in the markup: the legal brief §5 is explicit that the
 * limits are configurable without a deploy, so a component printing "5" would
 * be wrong the first time Sci changed a row — and a component printing a price
 * would be wrong about a charge.
 *
 * ## The cancel control is a clause of the contract, not an advert
 *
 * `docs/legal/termos-de-uso.md` names this screen by address and promises
 * *"Sem fidelidade. Você cancela quando quiser, em um clique."* D8 is that
 * promise. It is **one** confirmation step and not a maze, because the
 * approved copy has a confirmation in it (`billing.cancel.title`, *"Quer mesmo
 * cancelar?"*, with `confirm` and `keep`): the step is the copy's, not an
 * invention of this screen. It is a link to `?cancelar=1` rather than a dialog
 * because `vitest.config.mts` has no jsdom and a dialog's open state is
 * `useEffect` territory — invisible to the unit suite by construction (§4c).
 * `e2e/accounts/plano.spec.ts` pins the result, and **skips with its reason**
 * unless the environment names a deployment and a session: a first draft of
 * this comment claimed a journey that did not exist, which review caught.
 *
 * ## Every sentence here is already approved
 *
 * The 32 `billing.*` keys were written and have rendered nowhere since they
 * were approved. This wires them; it rewrites none of them. Two are
 * deliberately **not** rendered and both are carded rather than left in a
 * comment: `billing.cancel.reasonLabel`/`reasonHelp` ask for a free-text
 * reason there is no column for (**F11**), and no string in the catalogue says
 * *"we need your CNPJ before you can charge you"*, so an account with no CNPJ
 * gets the company button and no explanation (**F8**, with a `CLAIMS.md` row).
 */

const copy = messages.account.screen
const billing = messages.billing

/**
 * `"2026-10-17"` → `"17/10/2026"`.
 *
 * **Not `fullDate()`.** That one takes an *instant* and formats it in
 * `America/Sao_Paulo`, which is right for a `timestamptz` and wrong here:
 * `new Date('2026-10-17')` is parsed as UTC midnight, and UTC midnight in
 * Brasília is 21:00 **the day before**, so every date on this screen would
 * print one day early. These columns are `date`, they were computed at
 * `America/Sao_Paulo` when they were written, and a date with no time in it
 * needs no conversion at all — only a reordering. CLAUDE.md, Clocks.
 */
function planDate(iso: string | null): string | null {
  if (!iso) return null
  const [year, month, day] = iso.slice(0, 10).split('-')
  return year && month && day ? `${day}/${month}/${year}` : null
}

/** The approved status line for our own five-word vocabulary. */
function statusLine(subscription: Subscription): string {
  if (subscription.status === 'active') return billing.status.active
  if (subscription.status === 'canceled') return billing.status.cancelled
  if (subscription.status === 'overdue') return billing.status.overdue
  // `pending` and `suspended`. Nothing writes `suspended` yet (card F4), and
  // until it does, "aguardando o pagamento" is the true sentence for both:
  // a subscription that exists and has not been paid.
  return billing.status.pending
}

/**
 * The banner after an action. An unknown `?estado=` renders nothing rather
 * than an empty card — the states are a union in `actions.ts` and this is the
 * only place that turns one into a sentence.
 */
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
  if (state === 'erro' || state === 'muitas-tentativas' || state === 'sem-assinatura') {
    // One sentence for all three, and it is true of all three: we could not
    // open the payment page right now, try again shortly. Distinguishing them
    // on screen would need three sentences nobody has written, and inventing
    // them is legal brief §5's line.
    return { title: null, body: billing.subscribe.error }
  }
  return null
}

export function PlanView({
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
}: {
  plan: string
  planName: string
  quota: QuotaView
  founderSeat: number | null
  /** The offer's size, from `docs/product.json` — never the column's bound. */
  seatTotal: number
  /**
   * The live subscription, `null` when there is none, and `'unavailable'` when
   * the database could not say. The third case is not the first: offering a
   * checkout there would create a real Asaas subscription we cannot record.
   */
  subscription: Subscription | null | 'unavailable'
  /** Whether Asaas can be given a document and a name for this account. */
  canBill: boolean
  state?: PlanState | null
  confirmingCancel?: boolean
  /** `goToCheckout`; a no-op in a component test. */
  onCheckout: () => void
  /** `confirmCancel`; a no-op in a component test. */
  onCancel: () => void
}) {
  const banner = notice(state)
  const live = subscription !== null && subscription !== 'unavailable'
  /**
   * A cancelled subscription whose paid period has not run out. `readSubscription`
   * returns it (it did not, which review found: three approved strings and the
   * whole cancelled branch were unreachable), and the screen treats it as
   * *both* — it states the status and the day the plan ends, **and** it offers
   * the checkout again, because somebody who cancelled may change their mind.
   */
  const cancelled = live && subscription.status === 'canceled'
  const cancellable =
    live && subscription.status !== 'canceled' && subscription.status !== 'suspended'
  const nextCharge = live ? planDate(subscription.nextChargeOn) : null
  const amount = live ? moneyExact(subscription.amount) : null
  const promoEnds = live ? planDate(subscription.promoEndsOn) : null
  const endsOn = live ? planDate(subscription.endsOn) : null

  return (
    <AccountChrome plan={plan} planName={planName} title={messages.radar.menu.billing}>
      {/* The house notice shape, the same one `/conta/empresa` uses for
          `companySaved`: an accented card with the approved sentence in it. */}
      {banner ? (
        <Card accent>
          {banner.title ? <h2 className="text-lead font-semibold">{banner.title}</h2> : null}
          <p className={cn('text-meta leading-relaxed', banner.title && 'mt-1')}>{banner.body}</p>
          {/* `billing.confirmed.cta` — "Voltar para o Radar". Approved with the
              two sentences above it and rendered nowhere until now; a
              confirmation with no way onward is a dead end. */}
          {state === 'ativo' ? (
            <div className="pt-3">
              <Button href="/radar" iconEnd="arrowRight">
                {billing.confirmed.cta}
              </Button>
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card padding="none">
        <div className="px-4 py-1">
          <CardRow label={copy.planLabel} value={planName || plan} />
          <CardRow
            label={copy.screeningsLabel}
            value={screeningsLabel(quota)}
            last={!founderSeat && !live}
          />
          {founderSeat ? (
            <CardRow
              label={copy.founderLabel}
              value={format(copy.founderSeat, { numero: founderSeat, total: seatTotal })}
              last={!live}
            />
          ) : null}
          {live ? <CardRow label={messages.radar.menu.billing} value={statusLine(subscription)} last /> : null}
        </div>
      </Card>

      {/* Approved copy, each line only where it is true. */}
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

      {/*
        The price-change notice, shown only once `promo_ends_on` exists — which
        is to say once a first payment has been taken, because that is what
        starts the promotional window. `billing.priceChange.*` is the approved
        wording and it carries the numbers as `{$preco…}` tokens, so nothing
        here types a price. The 30-day e-mail this banner's `noticeSent` line
        refers to is **card F3** and does not exist yet, so that one line is
        deliberately not rendered.
      */}
      {live && promoEnds && subscription.status !== 'canceled' ? (
        <Card accent>
          <h2 className="text-lead font-semibold">
            {format(billing.priceChange.bannerTitle, { data: promoEnds })}
          </h2>
          <p className="mt-1 text-meta leading-relaxed text-muted">
            {format(billing.priceChange.bannerBody, { data: promoEnds })}
          </p>
          <p className="mt-1 text-meta leading-relaxed text-muted">
            {format(billing.priceChange.bannerCancel, { data: promoEnds })}
          </p>
          {/*
            The detail block. Four approved strings that reached no screen
            until review counted them; each is true whenever this banner is,
            and all three figures arrive as `{$preco…}` tokens resolved from
            `docs/product.json`, so nothing here types a price.

            `billing.priceChange.noticeSent` is **not** here: it says we warned
            by e-mail 30 days before, and the job that would is card **F3**,
            due 09/12/2026. Rendering it would be this register's own worked
            example — a sentence describing something the product does not do.
          */}
          <p className="mt-3 text-label font-mono uppercase tracking-[0.06em] text-muted">
            {billing.priceChange.detailTitle}
          </p>
          <ul className="mt-1 list-none text-meta leading-relaxed text-muted">
            <li>{billing.priceChange.detailNow}</li>
            <li>{format(billing.priceChange.detailAfter, { data: promoEnds })}</li>
            <li>{billing.priceChange.detailSame}</li>
          </ul>
        </Card>
      ) : null}

      {confirmingCancel && cancellable ? (
        <Card>
          <h2 className="text-lead font-semibold">{billing.cancel.title}</h2>
          <p className="mt-1 text-meta leading-relaxed text-muted">{billing.cancel.body}</p>
          {/*
            **`billing.cancel.untilWhen` is not rendered here, only after.**
            Before cancelling, `ends_on` is null, so the only date this
            component has is `next_charge_on` — and `cancelSubscription`
            computes `ends_on` from three candidates, the greatest of which is
            usually the settled charge's due date plus a month. The
            confirmation said *"até 17/11"* while the row then said 16/11.
            Found by review. Rather than reimplement that arithmetic in the
            markup, the screen promises the date once, after the fact, from the
            value that was actually written.
          */}
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
        </Card>
      ) : null}

      {/* `billing.subscribe.title` — the heading the subscribe control was
          written with, and which reached no screen until review counted the
          catalogue. Shown only where the control is: a heading over a button
          that is not there would be the opposite defect. */}
      {(!live || cancelled) && canBill && subscription !== 'unavailable' ? (
        <h2 className="pt-2 text-lead font-semibold">{billing.subscribe.title}</h2>
      ) : null}

      <div className="flex flex-col gap-2 pt-2 min-[560px]:flex-row">
        {(!live || cancelled) && canBill && subscription !== 'unavailable' ? (
          <form action={onCheckout}>
            <Button type="submit" variant="primary" iconEnd="arrowRight" fullWidth>
              {billing.subscribe.cta}
            </Button>
          </form>
        ) : null}

        {/*
          **A subscription that exists and has not been paid still needs its
          invoice.** Without this the screen says "Aguardando o pagamento" and
          offers no way to pay: the founder created the subscription, closed the
          Asaas tab, came back, and the one thing they need is the link. It is a
          plain `<a>` to the stored `checkout_url` rather than the action,
          because the action would create nothing and redirect to the same
          place — one fewer round trip to Asaas for the same result.
        */}
        {live && subscription.checkoutUrl && subscription.status !== 'active'
        && subscription.status !== 'canceled' ? (
          <Button
            href={subscription.checkoutUrl}
            variant="primary"
            iconEnd="arrowRight"
            rel="noreferrer"
          >
            {billing.subscribe.cta}
          </Button>
        ) : null}

        {/*
          No CNPJ, so Asaas has no document to bill. The company screen is
          where that is fixed. **The sentence explaining it does not exist**
          (card F8) — this is a navigation affordance, not an explanation, and
          the silence is recorded in `docs/CLAIMS.md` rather than papered over
          with copy nobody approved.
        */}
        {(!live || cancelled) && !canBill ? (
          <Button href={COMPANY_PATH} variant="secondary">
            {messages.radar.menu.company}
          </Button>
        ) : null}

        {/* `PLAN_HREF`, not `PLAN_PATH`: during the founders window the offer
            page is still where somebody comparing plans should land, and this
            screen is where somebody who has chosen one acts. The two names
            exist so the link can move the day that stops being true. */}
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

      {founderSeat && !live ? (
        <p className="text-meta leading-relaxed text-muted">{copy.founderNote}</p>
      ) : null}

      {!live || cancelled ? (
        <p className="text-meta leading-relaxed text-muted">{billing.subscribe.methods}</p>
      ) : null}
    </AccountChrome>
  )
}
