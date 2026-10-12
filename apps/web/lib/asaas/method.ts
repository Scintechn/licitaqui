/**
 * How a subscriber pays — **Pix or card, both, and nothing else.**
 *
 * Sci's rule, 2026-10-11: *"The application will accept Card and Pix, this is
 * the rule… even if for pix we have to charge every month, not like a normal
 * subscription."*
 *
 * ## Why this is its own module
 *
 * `/conta/plano` renders the chooser and `lib/asaas/client.ts` sends the value.
 * If the union lived in the client, the view would import the Asaas client —
 * and with it `config.ts`, which reads `process.env` — to render two radio
 * buttons. The type and its parser are the only things both sides need.
 *
 * ## Why boleto is not a member
 *
 * Asaas **cannot refund a boleto**, and the terms carry a 7-day withdrawal
 * (CDC art. 49) and a 30-day guarantee. Measured in the sandbox on 2026-10-10:
 * `billingType: UNDEFINED` let the payer pick boleto, the first real
 * subscription came back `billing_type: BOLETO`, and the refund was refused
 * with *"Somente é possível estornar cobranças cuja a forma de pagamento seja
 * cartão de crédito ou Pix."* Both members here are refundable — Pix in full
 * or in several partial refunds, card in full or in part. Nothing else Asaas
 * offers for a subscription is. So the union is the guarantee: there is no
 * value of this type that the terms cannot honour.
 */

export type SubscriptionMethod = 'PIX' | 'CREDIT_CARD'

/**
 * Display order on the plan screen, and the first is the default.
 *
 * **Card is first because it is the only one that renews unattended.** A Pix
 * subscription is an invoice per cycle: Asaas issues a fresh QR every month and
 * the subscriber has to pay it. Card is tokenized on the first payment and
 * charged automatically afterwards (measured 2026-10-11 — see
 * `client.ts`'s `createSubscription`). Defaulting to the method that cannot
 * lapse by forgetfulness is the kinder default; choosing Pix is one click.
 */
export const SUBSCRIPTION_METHODS = ['CREDIT_CARD', 'PIX'] as const satisfies readonly SubscriptionMethod[]

export const DEFAULT_SUBSCRIPTION_METHOD: SubscriptionMethod = 'CREDIT_CARD'

/**
 * Read a method off a form submission.
 *
 * Returns `null` rather than a default for anything unrecognised, and the
 * caller decides. A Server Function is a POST endpoint with a generated name
 * (see `app/conta/plano/actions.ts`), so this value is **attacker-controlled**:
 * `'BOLETO'` is exactly what a crafted request would send to get an
 * unrefundable charge, and it must not fall through to a default that accepts
 * it by accident.
 */
export function parseSubscriptionMethod(value: unknown): SubscriptionMethod | null {
  return SUBSCRIPTION_METHODS.includes(value as SubscriptionMethod)
    ? (value as SubscriptionMethod)
    : null
}
