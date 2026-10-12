import { beforeEach, describe, expect, it, vi } from 'vitest'

/** What happened, in order. The order is the correctness argument for cancel. */
const order = vi.hoisted(() => [] as string[])

const auth = vi.hoisted(() => vi.fn())
const rateLimitRequest = vi.hoisted(() => vi.fn())
const startCheckout = vi.hoisted(() => vi.fn())
const readSubscription = vi.hoisted(() => vi.fn())
const cancelSubscription = vi.hoisted(() => vi.fn())
const deleteSubscription = vi.hoisted(() => vi.fn())
const recordEventSafely = vi.hoisted(() => vi.fn(async () => true))
const live = vi.hoisted(() => ({ value: true }))

class Redirect extends Error {
  constructor(readonly url: string) {
    super(`redirect:${url}`)
  }
}

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Redirect(url)
  },
}))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('@/lib/auth', () => ({ auth }))
vi.mock('@/lib/rate-limit', () => ({ rateLimitRequest }))
vi.mock('@/lib/asaas/checkout', () => ({ startCheckout }))
vi.mock('@/lib/asaas/subscription', () => ({ readSubscription, cancelSubscription }))
vi.mock('@/lib/events', () => ({ recordEventSafely }))
vi.mock('@/lib/db', () => ({
  db: () => ({
    transaction: async (run: (tx: unknown) => unknown) => {
      order.push('cancel-row')
      return run({})
    },
  }),
}))
vi.mock('@/lib/asaas/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/asaas/client')>('@/lib/asaas/client')
  return {
    ...actual,
    AsaasClient: class {
      get live() {
        return live.value
      }
      deleteSubscription = deleteSubscription
    },
  }
})

const { confirmCancel, goToCheckout } = await import('./actions')
const { PLAN_STATES } = await import('./states')

const SUBSCRIPTION = {
  asaasSubscriptionId: 'sub_1',
  status: 'active' as const,
  plan: 'promocional',
  amount: '57.00',
  nextChargeOn: '2026-11-17',
  promoEndsOn: null,
  endsOn: null,
  checkoutUrl: null,
  lastPayment: null,
}

async function where(run: () => Promise<void>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof Redirect) return error.url
    throw error
  }
  throw new Error('the action returned without redirecting')
}

/**
 * The two Server Functions on `/conta/plano` — cards **F2** and **D8**.
 *
 * Mocked at the module boundary, so what is under test is the **decision
 * sequence**: who is asked, in what order, and where the reader lands. The
 * database behaviour is `lib/asaas/billing.db.test.ts`'s and the Asaas request
 * shapes are `lib/asaas/client.test.ts`'s.
 *
 * Every case asserts a redirect, because every branch of both actions must
 * end in one. A Server Function that returns without redirecting leaves the
 * reader on a screen that says nothing happened, which is the shape the parked
 * draft's 202-and-poll had: no way to tell a failed job from a slow one.
 */
/**
 * The form `/conta/plano` posts. `metodo` is the radio group added when Sci
 * ruled Pix *and* card (2026-10-11); omitting it is the no-JavaScript case,
 * which `goToCheckout` answers with the default rather than an error.
 */
const form = (metodo?: string) => {
  const data = new FormData()
  if (metodo !== undefined) data.set('metodo', metodo)
  return data
}

describe('goToCheckout', () => {
  beforeEach(reset)

  it('refuses a signed-out caller before doing anything', async () => {
    auth.mockResolvedValue(null)
    expect(await where(() => goToCheckout(form()))).toBe('/conta/criar')
    // A Server Function is a POST endpoint with a generated name: the button
    // is not the only thing that can call it.
    expect(rateLimitRequest).not.toHaveBeenCalled()
    expect(startCheckout).not.toHaveBeenCalled()
  })

  /*
   * **The method the subscriber chose, all the way to the Asaas call.** Sci's
   * rule, 2026-10-11. These four are the path, not the unit: the chooser is a
   * radio group in the form, this action reads it, and `startCheckout` passes
   * it to `billingType`. A test that only checked the parser would pass while
   * the form's value was dropped on the floor — which is this repo's own
   * worked example (`radar.opportunity.screeningCost`: written, tested, never
   * passed).
   */
  it('passes Pix through to the checkout when that is what was chosen', async () => {
    startCheckout.mockResolvedValue({
      outcome: 'ready',
      plan: 'promocional',
      amount: 57,
      asaasSubscriptionId: 'sub_1',
      checkoutUrl: 'https://sandbox.asaas.com/i/abc',
      created: true,
    })
    await where(() => goToCheckout(form('PIX')))
    expect(startCheckout).toHaveBeenCalledWith(7, 'PIX')
  })

  it('passes the card through when that is what was chosen', async () => {
    startCheckout.mockResolvedValue({
      outcome: 'ready',
      plan: 'promocional',
      amount: 57,
      asaasSubscriptionId: 'sub_1',
      checkoutUrl: 'https://sandbox.asaas.com/i/abc',
      created: true,
    })
    await where(() => goToCheckout(form('CREDIT_CARD')))
    expect(startCheckout).toHaveBeenCalledWith(7, 'CREDIT_CARD')
  })

  it('refuses boleto outright and creates nothing', async () => {
    // The one that matters. A Server Function is a POST endpoint with a
    // generated name, so this is a reachable request — and Asaas **cannot
    // refund a boleto**, which the terms' 7-day withdrawal and 30-day
    // guarantee both require. Measured in the sandbox on 2026-10-10, which is
    // how the whole F21 defect was found.
    expect(await where(() => goToCheckout(form('BOLETO')))).toBe('/conta/plano?estado=erro')
    expect(startCheckout).not.toHaveBeenCalled()
  })

  it('refuses the payer-picks value too, which is the one that looks harmless', async () => {
    // `UNDEFINED` is what this code sent until 10-10. Asaas describes it as
    // letting the payer choose; what it actually does is add boleto to the
    // invoice page.
    expect(await where(() => goToCheckout(form('UNDEFINED')))).toBe('/conta/plano?estado=erro')
    expect(startCheckout).not.toHaveBeenCalled()
  })

  it('takes the default when the form carries no method at all', async () => {
    // The no-JavaScript case, and not an attack: a form posted without the
    // radio should still buy something the terms can refund. Distinct from the
    // two above on purpose — a *present but unrecognised* value is refused, a
    // *missing* one is defaulted.
    startCheckout.mockResolvedValue({
      outcome: 'ready',
      plan: 'promocional',
      amount: 57,
      asaasSubscriptionId: 'sub_1',
      checkoutUrl: 'https://sandbox.asaas.com/i/abc',
      created: true,
    })
    await where(() => goToCheckout(form()))
    expect(startCheckout).toHaveBeenCalledWith(7, 'CREDIT_CARD')
  })

  it('hands over the Asaas invoice when there is one', async () => {
    startCheckout.mockResolvedValue({
      outcome: 'ready',
      plan: 'promocional',
      amount: 57,
      asaasSubscriptionId: 'sub_1',
      checkoutUrl: 'https://sandbox.asaas.com/i/abc',
      created: true,
    })
    expect(await where(() => goToCheckout(form()))).toBe('https://sandbox.asaas.com/i/abc')
  })

  it('records the gate metric with a plan name and no amount or URL', async () => {
    startCheckout.mockResolvedValue({
      outcome: 'ready',
      plan: 'promocional',
      amount: 57,
      asaasSubscriptionId: 'sub_1',
      checkoutUrl: 'https://sandbox.asaas.com/i/abc',
      created: true,
    })
    await where(() => goToCheckout(form()))
    expect(recordEventSafely).toHaveBeenCalledWith({
      name: 'checkout_opened',
      userId: 7,
      // The chosen method rides along from 2026-10-11: §14's gate wants to
      // know which of the two people pick, and it is a fixed enum — never an
      // amount and never a URL (§12).
      props: { plan: 'promocional', method: 'CREDIT_CARD' },
    })
    // §12: a checkout URL opens one named customer's invoice.
    expect(JSON.stringify(recordEventSafely.mock.calls)).not.toContain('asaas.com')
  })

  it('comes back to the plan screen when the subscription exists with no link yet', async () => {
    startCheckout.mockResolvedValue({
      outcome: 'ready',
      plan: 'promocional',
      amount: 57,
      asaasSubscriptionId: 'sub_1',
      checkoutUrl: null,
      created: true,
    })
    expect(await where(() => goToCheckout(form()))).toBe('/conta/plano?estado=aguardando')
  })

  it('sends an account with no document to the company screen', async () => {
    startCheckout.mockResolvedValue({ outcome: 'needs_company' })
    // **No invented sentence.** Nothing in the catalogue says "we need your
    // CNPJ before we can charge you"; copy is Sci's (legal brief §5), so this
    // is a navigation affordance and card F8 carries the silence.
    expect(await where(() => goToCheckout(form()))).toBe('/conta/empresa')
  })

  it('says the payment page could not be opened when billing is switched off', async () => {
    startCheckout.mockResolvedValue({ outcome: 'dry_run', plan: 'promocional', amount: 57 })
    expect(await where(() => goToCheckout(form()))).toBe('/conta/plano?estado=erro')
  })

  it('does not offer a second checkout to somebody already paying', async () => {
    startCheckout.mockResolvedValue({ outcome: 'already_active' })
    expect(await where(() => goToCheckout(form()))).toBe('/conta/plano?estado=ativo')
    expect(recordEventSafely).not.toHaveBeenCalled()
  })

  it('turns a rate-limit refusal into a state, not an error page', async () => {
    rateLimitRequest.mockResolvedValue({ ok: false, retryAfter: 30 })
    expect(await where(() => goToCheckout(form()))).toBe('/conta/plano?estado=muitas-tentativas')
    expect(startCheckout).not.toHaveBeenCalled()
  })

  it('awaits the rate-limit decision', async () => {
    /**
     * The parked routes read `rateLimitRequest(...)` with no `await` while the
     * function is `async`, so `decision.ok` was `undefined`, `!decision.ok`
     * was true, and **every** request answered 429.
     *
     * **The assertion is the destination, not the shape of the mock's return.**
     * A first version only checked that the mock returned a Promise — which a
     * `mockResolvedValue` always does, so it asserted the mock and would have
     * passed with the `await` dropped. Review named it, and named it after the
     * defect it did not catch. Landing on `ativo` rather than
     * `muitas-tentativas` is what proves the decision was read.
     */
    startCheckout.mockResolvedValue({ outcome: 'already_active' })
    expect(await where(() => goToCheckout(form()))).toBe('/conta/plano?estado=ativo')
    expect(rateLimitRequest).toHaveBeenCalledTimes(1)
  })
})

describe('confirmCancel', () => {
  beforeEach(reset)

  it('refuses a signed-out caller', async () => {
    auth.mockResolvedValue(null)
    expect(await where(confirmCancel)).toBe('/conta/criar')
    expect(deleteSubscription).not.toHaveBeenCalled()
  })

  /**
   * **The ordering is the whole correctness argument.** If our row were
   * written first and the Asaas call then failed, we would show a cancelled
   * subscription that keeps charging every month — the worst outcome
   * available. In this order, Asaas refusing changes nothing and Asaas
   * succeeding while our write fails self-heals, because
   * `SUBSCRIPTION_DELETED` arrives and ends the row.
   */
  it('stops the money at Asaas before it writes our row', async () => {
    readSubscription.mockResolvedValue({ state: 'found', subscription: SUBSCRIPTION })
    deleteSubscription.mockImplementation(async () => {
      order.push('asaas-delete')
      return true
    })
    cancelSubscription.mockResolvedValue({
      cancelled: true,
      asaasSubscriptionId: 'sub_1',
      endsOn: '2026-11-16',
    })

    expect(await where(confirmCancel)).toBe('/conta/plano?estado=cancelado')
    expect(order).toEqual(['asaas-delete', 'cancel-row'])
    expect(deleteSubscription).toHaveBeenCalledWith('sub_1')
  })

  it('changes nothing when Asaas refuses', async () => {
    readSubscription.mockResolvedValue({ state: 'found', subscription: SUBSCRIPTION })
    const { AsaasError } = await import('@/lib/asaas/client')
    deleteSubscription.mockRejectedValue(new AsaasError('server_error', { status: 500 }))

    expect(await where(confirmCancel)).toBe('/conta/plano?estado=erro')
    expect(cancelSubscription).not.toHaveBeenCalled()
    expect(recordEventSafely).not.toHaveBeenCalled()
  })

  it('records the cancellation with a plan name and where it came from', async () => {
    readSubscription.mockResolvedValue({ state: 'found', subscription: SUBSCRIPTION })
    deleteSubscription.mockResolvedValue(true)
    cancelSubscription.mockResolvedValue({
      cancelled: true,
      asaasSubscriptionId: 'sub_1',
      endsOn: '2026-11-16',
    })
    await where(confirmCancel)
    expect(recordEventSafely).toHaveBeenCalledWith({
      name: 'cancelled',
      userId: 7,
      props: { source: 'account', plan: 'promocional' },
    })
  })

  it('says so when there is nothing to cancel', async () => {
    readSubscription.mockResolvedValue({ state: 'none' })
    expect(await where(confirmCancel)).toBe('/conta/plano?estado=sem-assinatura')
    expect(deleteSubscription).not.toHaveBeenCalled()
  })

  it('refuses when the database cannot say whether there is a subscription', async () => {
    // Not the same as "none": cancelling what we cannot read is guessing.
    readSubscription.mockResolvedValue({ state: 'unavailable', reason: '42P01' })
    expect(await where(confirmCancel)).toBe('/conta/plano?estado=erro')
    expect(deleteSubscription).not.toHaveBeenCalled()
  })

  it('cancels the local row with billing switched off, loudly', async () => {
    // A dry-run environment in which the cancel screen cannot be exercised is
    // a screen nobody can test. The console line is what keeps it from looking
    // like a provider outage.
    live.value = false
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    readSubscription.mockResolvedValue({ state: 'found', subscription: SUBSCRIPTION })
    cancelSubscription.mockResolvedValue({
      cancelled: true,
      asaasSubscriptionId: 'sub_1',
      endsOn: '2026-11-16',
    })

    expect(await where(confirmCancel)).toBe('/conta/plano?estado=cancelado')
    expect(deleteSubscription).not.toHaveBeenCalled()
    expect(errors.mock.calls.flat().join(' ')).toContain('ASAAS_BILLING')
    errors.mockRestore()
  })
})

describe('the states these actions redirect with', () => {
  it('are the ones the screen knows how to render', () => {
    // `plan-view.tsx` turns each into an approved `billing.*` sentence, and
    // `page.tsx` refuses anything not in this list rather than rendering an
    // empty banner. Two lists that must agree, pinned here.
    expect([...PLAN_STATES]).toEqual([
      'ativo',
      'aguardando',
      'cancelado',
      'sem-assinatura',
      'erro',
      'muitas-tentativas',
    ])
  })
})

function reset() {
  order.length = 0
  live.value = true
  auth.mockReset()
  rateLimitRequest.mockReset()
  startCheckout.mockReset()
  readSubscription.mockReset()
  cancelSubscription.mockReset()
  deleteSubscription.mockReset()
  recordEventSafely.mockReset()

  auth.mockResolvedValue({ user: { id: '7' } })
  rateLimitRequest.mockResolvedValue({ ok: true, retryAfter: 0 })
  recordEventSafely.mockResolvedValue(true)
  deleteSubscription.mockResolvedValue(true)
}
