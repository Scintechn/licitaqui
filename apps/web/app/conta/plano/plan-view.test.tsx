import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Subscription } from '@/lib/asaas/subscription'
import { messages } from '@/lib/messages'
import { FOUNDERS, PLAN_PRICES } from '@/lib/product'
import type { QuotaView } from '@/lib/radar/contract'
import { COMPANY_PATH, PLAN_HREF, PLAN_PATH } from '@/lib/routes'
import { PlanView } from './plan-view'

/**
 * `/conta/plano` — cards **D22**, **F2** and **D8**.
 *
 * Two assertions this file exists for, and they are different in kind.
 *
 * **D22's, carried over:** no number on this screen is written in the markup.
 * Legal brief §5 says the limits live in `plan_limits` and change without a
 * deploy, so every figure arrives through `quota` or through the subscription
 * row, and a component that hard-coded "5" would be lying the first time Sci
 * changed a row. The seat total is the half that actually broke — `/conta`
 * rendered `MAX_SEAT`, a database CHECK bound of 48, so a founder read "Vaga 1
 * de 48" while the terms sold 25 (**E19**).
 *
 * **F2/D8's:** every sentence here is one of the 32 approved `billing.*` keys,
 * each rendered **only in the state where it is true**. A status line is not a
 * decoration: `billing.status.active` over an unpaid subscription, or
 * `billing.cancel.untilWhen` on one that was never cancelled, is a false
 * sentence on a screen about money — which is CDC art. 30's territory, not a
 * display bug. So most of what follows is negative: the sentence is **absent**
 * from the states it would be false in.
 *
 * ## What this file cannot see (§4c)
 *
 * `vitest.config.mts` has no jsdom, so these are `renderToStaticMarkup`
 * strings. They pin the **mechanism**: which sentence and which control appear
 * for which state. They cannot pin the **result** — that pressing the cancel
 * link reaches a confirmation and that confirming cancels — because that is
 * navigation and a form submission. `e2e/journeys/plano.spec.ts` does that
 * half, and says so.
 */

const copy = messages.account.screen
const billing = messages.billing

const BASICO: QuotaView = {
  feature: 'screening',
  plan: 'basico',
  period: 'month',
  limit: 5,
  used: 2,
  left: 3,
}

const ACTIVE: Subscription = {
  asaasSubscriptionId: 'sub_000001',
  status: 'active',
  plan: 'promocional',
  amount: PLAN_PRICES.promocional.toFixed(2),
  nextChargeOn: '2026-11-17',
  promoEndsOn: null,
  endsOn: null,
  checkoutUrl: null,
  lastPayment: null,
}

function render(over: Partial<Parameters<typeof PlanView>[0]> = {}) {
  return renderToStaticMarkup(
    <PlanView
      plan="basico"
      planName={messages.plans.basic.name}
      quota={BASICO}
      founderSeat={null}
      seatTotal={FOUNDERS.seatsTotal}
      subscription={null}
      canBill
      onCheckout={() => {}}
      onCancel={() => {}}
      {...over}
    />,
  )
}

describe('the plan screen, with no subscription', () => {
  it('is headed by the words the reader tapped to get here', () => {
    expect(render()).toContain(messages.radar.menu.billing)
  })

  it('names the plan in Portuguese and shows what is left of it', () => {
    const out = render()
    expect(out).toContain(messages.plans.basic.name)
    expect(out).toContain('2 de 5 neste mês')
  })

  it('reads the allowance out of the quota, never out of the markup', () => {
    // Change the row, change the screen. If this ever needs editing because a
    // limit moved, the number is in the wrong place.
    const out = render({ quota: { ...BASICO, limit: 9, used: 1, left: 8 } })
    expect(out).toContain('1 de 9 neste mês')
    expect(out).not.toContain('2 de 5')
  })

  it('shows a founder their seat against the number the terms sell', () => {
    // **Not `MAX_SEAT`.** 48 is a column bound; 25 is the offer. Rendering the
    // bound told a founder "Vaga 1 de 48" while the landing banner said 17 and
    // the terms said 25 — three numbers for one product (E19).
    const founder = render({ founderSeat: 7 })
    expect(founder).toContain(copy.founderLabel)
    expect(founder).toContain(`de ${FOUNDERS.seatsTotal}`)
    expect(founder).not.toContain('de 48')
    expect(founder).toContain(copy.founderNote)
  })

  it('shows nobody else a seat row', () => {
    expect(render()).not.toContain(copy.founderLabel)
  })

  it('offers the checkout, in the approved words, and says how you can pay', () => {
    const out = render()
    expect(out).toContain(billing.subscribe.cta)
    expect(out).toContain(billing.subscribe.methods)
  })

  it('sends a comparison through PLAN_HREF, which is still the offer page', () => {
    // `PLAN_HREF` and `PLAN_PATH` are separate names precisely so this link
    // can move when the founders window closes (card F12).
    expect(render()).toContain(`href="${PLAN_HREF}"`)
  })

  it('offers no cancel control when there is nothing to cancel', () => {
    expect(render()).not.toContain(billing.cancel.cta)
  })

  it('says nothing about a next charge, a last payment or a price change', () => {
    const out = render()
    // Each of these is a sentence with a `{data}` in it. Rendering one with no
    // subscription behind it would print a promise about a charge that does
    // not exist.
    expect(out).not.toContain('Próxima cobrança')
    expect(out).not.toContain('Último pagamento')
    expect(out).not.toContain('Sua mensalidade muda')
  })
})

describe('the plan screen, with an account Asaas cannot bill', () => {
  it('offers the company screen instead of a checkout', () => {
    const out = render({ canBill: false })
    expect(out).toContain(`href="${COMPANY_PATH}"`)
    expect(out).not.toContain(billing.subscribe.cta)
  })

  /**
   * **A deliberate silence, recorded rather than papered over.** No string in
   * the catalogue says "we need your CNPJ before we can charge you", copy is
   * Sci's (legal brief §5), and inventing one here is the line this repository
   * does not cross. Card **F8** and a `docs/CLAIMS.md` row carry it.
   *
   * This asserts the silence so that *filling* it is a visible change rather
   * than something that quietly never happens.
   */
  it('explains nothing, because the sentence that would does not exist yet', () => {
    const out = render({ canBill: false })
    expect(out).not.toContain('CNPJ')
  })
})

describe('the plan screen, when the database cannot answer', () => {
  /**
   * `unavailable` is not `none`. Offering a checkout here would create a real
   * Asaas subscription that could not be recorded — the one failure worth
   * showing less for.
   */
  it('offers no checkout and no cancel', () => {
    const out = render({ subscription: 'unavailable' })
    expect(out).not.toContain(billing.subscribe.cta)
    expect(out).not.toContain(billing.cancel.cta)
  })
})

describe('the plan screen, with a live subscription', () => {
  it('says it is active and when the next charge falls, in the product clock', () => {
    const out = render({ subscription: ACTIVE, plan: 'promocional' })
    expect(out).toContain(billing.status.active)
    // **17/11/2026, not 16/11.** The column is a `date`, written at
    // America/Sao_Paulo; formatting it as an instant would parse it as UTC
    // midnight and print the day before for every reader in Brazil.
    expect(out).toContain('17/11/2026')
    expect(out).toContain(`R$ ${PLAN_PRICES.promocional},00`)
  })

  it('offers the cancel control the terms of use promise by address', () => {
    const out = render({ subscription: ACTIVE })
    expect(out).toContain(billing.cancel.cta)
    expect(out).toContain('cancelar=1')
  })

  it('offers no second checkout once it is paid', () => {
    expect(render({ subscription: ACTIVE })).not.toContain(billing.subscribe.cta)
  })

  /**
   * **The defect this catches.** Without it the screen says *"Aguardando o
   * pagamento"* and offers no way to pay: the founder created the
   * subscription, closed the Asaas tab, came back, and the one thing they
   * need is the link. It was found by reading the screen rather than by a
   * failing test, which is how every row in `docs/CLAIMS.md` was found.
   */
  it('hands back the stored invoice while the subscription is unpaid', () => {
    const out = render({
      subscription: { ...ACTIVE, status: 'pending', checkoutUrl: 'https://sandbox.asaas.com/i/x' },
    })
    expect(out).toContain('href="https://sandbox.asaas.com/i/x"')
    expect(out).toContain(billing.subscribe.cta)
  })

  it('hands it back for an overdue subscription too', () => {
    const out = render({
      subscription: { ...ACTIVE, status: 'overdue', checkoutUrl: 'https://sandbox.asaas.com/i/x' },
    })
    expect(out).toContain('href="https://sandbox.asaas.com/i/x"')
  })

  it('does not offer an invoice for a cancelled subscription', () => {
    const out = render({
      subscription: {
        ...ACTIVE,
        status: 'canceled',
        endsOn: '2026-11-16',
        checkoutUrl: 'https://sandbox.asaas.com/i/x',
      },
    })
    expect(out).not.toContain('https://sandbox.asaas.com/i/x')
  })

  it('says "aguardando o pagamento" while the subscription is unpaid', () => {
    const out = render({ subscription: { ...ACTIVE, status: 'pending' } })
    expect(out).toContain(billing.status.pending)
    expect(out).not.toContain(billing.status.active)
  })

  it('says "em atraso" when a charge went past its due date', () => {
    const out = render({ subscription: { ...ACTIVE, status: 'overdue' } })
    expect(out).toContain(billing.status.overdue)
  })

  it('names the last payment only once one has been paid', () => {
    const unpaid = render({
      subscription: { ...ACTIVE, lastPayment: { status: 'PENDING', amount: '57.00', paidOn: null, dueOn: '2026-10-17' } },
    })
    expect(unpaid).not.toContain('Último pagamento')

    const paid = render({
      subscription: {
        ...ACTIVE,
        lastPayment: { status: 'CONFIRMED', amount: '57.00', paidOn: '2026-10-17', dueOn: '2026-10-17' },
      },
    })
    expect(paid).toContain('Último pagamento')
    expect(paid).toContain('17/10/2026')
  })

  it('shows the price-change banner only once the promotional window is dated', () => {
    expect(render({ subscription: ACTIVE })).not.toContain('Sua mensalidade muda')

    const promo = render({ subscription: { ...ACTIVE, promoEndsOn: '2027-01-17' } })
    expect(promo).toContain('Sua mensalidade muda')
    expect(promo).toContain('17/01/2027')
    // The banner quotes both prices, and both arrive as `{$preco…}` tokens
    // resolved from `docs/product.json` — nothing in this component types one.
    expect(promo).toContain(`R$ ${PLAN_PRICES.promocional}`)
    expect(promo).toContain(`R$ ${PLAN_PRICES.essencial}`)
  })

  it('does not promise a 30-day notice, because nothing sends one yet', () => {
    // `billing.priceChange.noticeSent` is approved copy for a mail F3 has not
    // built. Rendering it would be the register's own worked example: a
    // sentence describing something the product does not do.
    const promo = render({ subscription: { ...ACTIVE, promoEndsOn: '2027-01-17' } })
    expect(promo).not.toContain(billing.priceChange.noticeSent.slice(0, 20))
  })
})

describe('the plan screen, after cancelling', () => {
  const CANCELLED: Subscription = {
    ...ACTIVE,
    status: 'canceled',
    endsOn: '2026-11-16',
    nextChargeOn: null,
  }

  it('says it is cancelled and until when the paid plan runs', () => {
    const out = render({ subscription: CANCELLED })
    expect(out).toContain(billing.status.cancelled)
    expect(out).toContain('16/11/2026')
  })

  it('stops promising a next charge', () => {
    expect(render({ subscription: CANCELLED })).not.toContain('Próxima cobrança')
  })

  it('offers no cancel control twice', () => {
    expect(render({ subscription: CANCELLED })).not.toContain(billing.cancel.cta)
  })
})

describe('the confirmation step', () => {
  it('asks once, in the approved words, with a way out', () => {
    const out = render({ subscription: ACTIVE, confirmingCancel: true })
    expect(out).toContain(billing.cancel.title)
    expect(out).toContain(billing.cancel.body)
    expect(out).toContain(billing.cancel.confirm)
    expect(out).toContain(billing.cancel.keep)
    expect(out).toContain(`href="${PLAN_PATH}"`)
  })

  /**
   * `billing.cancel.reasonLabel` and `reasonHelp` are approved copy for a
   * free-text field and **there is no column to put it in**. A form field
   * whose answer is discarded is worse than not asking, so it is not rendered
   * and card **F11** says so. Asserted, so that adding the column and the
   * field is a visible change.
   */
  it('does not ask for a reason it would throw away', () => {
    const out = render({ subscription: ACTIVE, confirmingCancel: true })
    expect(out).not.toContain(billing.cancel.reasonLabel)
  })

  it('cannot be reached for a subscription that is already cancelled', () => {
    const out = render({
      subscription: { ...ACTIVE, status: 'canceled', endsOn: '2026-11-16' },
      confirmingCancel: true,
    })
    expect(out).not.toContain(billing.cancel.title)
  })
})

describe('the banner after an action', () => {
  it('confirms a cancellation in the approved words', () => {
    const out = render({ state: 'cancelado' })
    expect(out).toContain(billing.cancel.doneTitle)
    expect(out).toContain(billing.cancel.doneBody)
  })

  it('confirms a payment', () => {
    const out = render({ state: 'ativo', subscription: ACTIVE })
    expect(out).toContain(billing.confirmed.title)
  })

  it('says the payment page could not be opened, for every failure shape', () => {
    for (const state of ['erro', 'muitas-tentativas', 'sem-assinatura'] as const) {
      expect(render({ state }), state).toContain(billing.subscribe.error)
    }
  })

  it('renders no banner for a state it does not know', () => {
    // A `?estado=` somebody typed must not produce an empty card.
    const out = render({ state: null })
    expect(out).not.toContain(billing.subscribe.error)
    expect(out).not.toContain(billing.cancel.doneTitle)
  })
})

describe('across every state', () => {
  it('leaves no message placeholder unresolved', () => {
    const states = [
      render({ founderSeat: 7 }),
      render({ subscription: ACTIVE }),
      render({ subscription: { ...ACTIVE, promoEndsOn: '2027-01-17' } }),
      render({ subscription: { ...ACTIVE, status: 'canceled', endsOn: '2026-11-16' } }),
      render({ subscription: ACTIVE, confirmingCancel: true }),
      render({ state: 'cancelado' }),
      render({ canBill: false }),
      render({ subscription: 'unavailable' }),
    ]
    for (const out of states) {
      expect(out).not.toMatch(/\{[a-zA-Z$]+\}/)
    }
  })

  it('prints no price with a non-breaking space', () => {
    // `moneyExact` exists to avoid U+00A0, which reads identically to a space
    // and compares unequal — so a screen mixing it with the catalogue shows
    // two spacings for one price and every assertion above would pass anyway.
    expect(render({ subscription: ACTIVE })).not.toContain(' ')
  })
})
