import { describe, expect, it, vi } from 'vitest'
import { AsaasClient, AsaasError, DRY_RUN, externalReference } from './client'
import {
  API_KEY_VAR,
  BILLING_VAR,
  configFault,
  ENV_VAR,
  PRODUCTION,
  safeInvoiceUrl,
  SANDBOX,
} from './config'

/**
 * The Asaas client, against a fake transport.
 *
 * **No real call was ever made from this code** — `ASAAS_API_KEY` is Sci's and
 * G12 (the production account, bank details and webhook URL) is not done. So
 * these tests pin the request this code *would* send and the answer it makes
 * of each reply, and the PR says plainly that the sandbox cycle is Sci's to
 * run. A green suite here is not evidence that Asaas accepts these fields; it
 * is evidence that we send what we think we send.
 */

const LIVE = {
  [BILLING_VAR]: 'live',
  [ENV_VAR]: SANDBOX,
  [API_KEY_VAR]: '$aact_hmlg_000000',
}

function stub(replies: Array<{ status?: number; body?: unknown; text?: string }>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const transport = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const reply = replies.shift() ?? { status: 200, body: {} }
    const text = reply.text ?? JSON.stringify(reply.body ?? {})
    return new Response(text, { status: reply.status ?? 200 })
  })
  return { calls, transport }
}

const client = (replies: Parameters<typeof stub>[0], env = LIVE) => {
  const { calls, transport } = stub(replies)
  return { calls, client: new AsaasClient({ env, transport }) }
}

describe('the dry run, which is the default', () => {
  it('opens no socket and returns DRY_RUN for every call', async () => {
    const { calls, transport } = stub([])
    const off = new AsaasClient({ env: { [API_KEY_VAR]: '$aact_hmlg_1' }, transport })
    expect(off.live).toBe(false)
    expect(await off.findCustomer('x')).toBe(DRY_RUN)
    expect(await off.createSubscription({
      customer: 'cus_1',
      value: 57,
      nextDueDate: '2026-10-17',
      externalReference: 'licitaqui-user-1',
      description: 'x',
    })).toBe(DRY_RUN)
    expect(await off.deleteSubscription('sub_1')).toBe(DRY_RUN)
    // The whole point: a deploy that forgets the variable cannot charge
    // anybody, and the symptom is a distinct state rather than a silence.
    expect(transport).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })

  it('treats a typo as a dry run rather than as live', async () => {
    const typo = new AsaasClient({ env: { ...LIVE, [BILLING_VAR]: 'LIVE ' } })
    // Trimmed and lower-cased, so `LIVE ` *is* live; `liev` is not.
    expect(typo.live).toBe(true)
    expect(new AsaasClient({ env: { ...LIVE, [BILLING_VAR]: 'liev' } }).live).toBe(false)
  })
})

describe('configuration faults', () => {
  it('names a missing key', () => {
    expect(configFault({ [BILLING_VAR]: 'live' })).toBe('no_api_key')
  })

  /**
   * The mistake worth catching: a production key while `ASAAS_ENV=sandbox`, or
   * the reverse. The first would charge real money from a preview deployment.
   */
  it('names a key that belongs to the other environment', () => {
    expect(configFault({ ...LIVE, [API_KEY_VAR]: '$aact_prod_1' })).toBe(
      'key_environment_mismatch',
    )
    expect(configFault({ ...LIVE, [ENV_VAR]: PRODUCTION, [API_KEY_VAR]: '$aact_prod_1' })).toBeNull()
  })

  it('accepts a key that does not look like an Asaas key at all', () => {
    // §4d: before pinning a threshold, check it is one. The prefixes are a
    // convention, not a contract, and refusing an otherwise-valid key because
    // of a prefix table would be inventing a limit.
    expect(configFault({ ...LIVE, [API_KEY_VAR]: 'whatever-the-sandbox-gave-us' })).toBeNull()
  })

  it('refuses to open a socket while misconfigured', async () => {
    const { calls, transport } = stub([{ body: {} }])
    const broken = new AsaasClient({ env: { [BILLING_VAR]: 'live' }, transport })
    await expect(broken.findCustomer('x')).rejects.toThrow(AsaasError)
    expect(calls).toEqual([])
  })
})

describe('the requests it sends', () => {
  it('authenticates with access_token and declares a User-Agent', async () => {
    const { calls, client: c } = client([{ body: { data: [] } }])
    await c.findCustomer(externalReference(7))
    const headers = calls[0].init.headers as Record<string, string>
    // Asaas v3 uses its own header, not `Authorization: Bearer`.
    expect(headers.access_token).toBe(LIVE[API_KEY_VAR])
    // Required since 2024-06-13; Asaas answers 403 without one.
    expect(headers['user-agent']).toContain('LicitaQui')
  })

  it('talks to the sandbox host while ASAAS_ENV is sandbox', async () => {
    const { calls, client: c } = client([{ body: { data: [] } }])
    await c.findCustomer('licitaqui-user-7')
    expect(calls[0].url).toContain('api-sandbox.asaas.com')
    expect(calls[0].url).not.toContain('https://api.asaas.com')
  })

  it('looks a customer up by externalReference before creating one', async () => {
    const { calls, client: c } = client([{ body: { data: [{ id: 'cus_1' }] } }])
    expect(await c.findCustomer(externalReference(7))).toEqual({ id: 'cus_1' })
    expect(calls[0].url).toContain('externalReference=licitaqui-user-7')
    expect(calls[0].init.method).toBe('GET')
    // A GET carries no body.
    expect(calls[0].init.body).toBeUndefined()
  })

  /**
   * **Spec §9, and it costs money to get wrong.** *"Asaas bills us for the
   * billing notifications it sends on our behalf … and they are on by
   * default"*. There is no parameter for this: no caller should be able to
   * leave it off.
   */
  it('always creates a customer with notifications disabled', async () => {
    const { calls, client: c } = client([{ body: { id: 'cus_2' } }])
    await c.createCustomer({
      name: 'Empresa',
      cpfCnpj: '11222333000181',
      externalReference: externalReference(7),
    })
    const body = JSON.parse(calls[0].init.body as string)
    expect(body.notificationDisabled).toBe(true)
  })

  it('creates a monthly subscription that lets the payer choose Pix or card', async () => {
    const { calls, client: c } = client([{ body: { id: 'sub_1', status: 'ACTIVE' } }])
    await c.createSubscription({
      customer: 'cus_1',
      value: 57,
      nextDueDate: '2026-10-17',
      externalReference: externalReference(7),
      description: 'LicitaQui · Promocional',
    })
    const body = JSON.parse(calls[0].init.body as string)
    expect(body.cycle).toBe('MONTHLY')
    // `UNDEFINED` is what makes the invoice page offer both; naming one would
    // take the choice away, and `billing.subscribe.methods` promises both.
    expect(body.billingType).toBe('UNDEFINED')
    expect(body.value).toBe(57)
    expect(body.nextDueDate).toBe('2026-10-17')
  })

  it('reuses no deleted or inactive subscription', async () => {
    // A deleted subscription in the list would otherwise be handed back as a
    // checkout link that can never be paid.
    const { client: c } = client([
      {
        body: {
          data: [
            { id: 'sub_old', status: 'INACTIVE' },
            { id: 'sub_gone', deleted: true, status: 'ACTIVE' },
            { id: 'sub_live', status: 'ACTIVE', nextDueDate: '2026-11-17', value: 57 },
          ],
        },
      },
    ])
    expect(await c.findSubscription(externalReference(7))).toEqual({
      id: 'sub_live',
      status: 'ACTIVE',
      nextDueDate: '2026-11-17',
      value: 57,
    })
  })

  it('reads a payment with dueDate, never with the subscription field', async () => {
    /**
     * The draft read `payment.nextDueDate` when granting access. A payment has
     * `dueDate`, `originalDueDate`, `paymentDate`, `clientPaymentDate` and
     * `confirmedDate`; `nextDueDate` is a **subscription** field, so the value
     * was always absent and `next_charge_on` would have frozen at its
     * creation-time value — a stale "Próxima cobrança em {data}" from the
     * second month onward.
     */
    const { client: c } = client([
      {
        body: {
          id: 'pay_1',
          status: 'CONFIRMED',
          value: 57,
          netValue: 55.08,
          dueDate: '2026-10-17',
          nextDueDate: '2099-01-01',
          confirmedDate: '2026-10-17',
          invoiceUrl: 'https://sandbox.asaas.com/i/abc',
          billingType: 'PIX',
          subscription: 'sub_1',
        },
      },
    ])
    const payment = await c.payment('pay_1')
    expect(payment).not.toBe(DRY_RUN)
    if (payment === DRY_RUN) return
    expect(payment.dueDate).toBe('2026-10-17')
    expect(payment.paymentDate).toBe('2026-10-17')
    expect(payment.netValue).toBe(55.08)
  })
})

describe('the answers it makes of a failure', () => {
  it('reads Asaas own stable error code and drops their description', async () => {
    const { client: c } = client([
      {
        status: 400,
        body: {
          errors: [{ code: 'invalid_cpfCnpj', description: 'CPF/CNPJ de Maria Silva invalido' }],
        },
      },
    ])
    const error = await c.createCustomer({
      name: 'x',
      cpfCnpj: '1',
      externalReference: 'licitaqui-user-1',
    }).catch((e) => e as AsaasError)
    expect(error).toBeInstanceOf(AsaasError)
    expect((error as AsaasError).code).toBe('invalid_cpfCnpj')
    expect((error as AsaasError).reason).toBe('invalid_request')
    // §12: their `description` can echo a person's name back, and this object
    // reaches a log line.
    expect(JSON.stringify(error)).not.toContain('Maria')
    expect((error as AsaasError).message).not.toContain('Maria')
  })

  it('calls 400/401/403/404 permanent and 429/5xx retryable', async () => {
    for (const [status, retryable] of [
      [400, false],
      [401, false],
      [403, false],
      [404, false],
      [429, true],
      [500, true],
      [503, true],
    ] as const) {
      const { client: c } = client([{ status, body: {} }])
      const error = (await c.findCustomer('x').catch((e) => e)) as AsaasError
      expect(error.retryable, `status ${status}`).toBe(retryable)
    }
  })

  it('reports a timeout as a timeout rather than as a network fault', async () => {
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      // What `fetch` does when the AbortController fires.
      const error = new Error('aborted')
      error.name = 'AbortError'
      void init
      throw error
    })
    const c = new AsaasClient({ env: LIVE, transport, timeoutMs: 5 })
    const error = (await c.findCustomer('x').catch((e) => e)) as AsaasError
    expect(error.reason).toBe('timeout')
    expect(error.retryable).toBe(true)
  })

  it('reports an unparseable success body rather than guessing', async () => {
    const { client: c } = client([{ text: 'not json' }])
    const error = (await c.findCustomer('x').catch((e) => e)) as AsaasError
    expect(error.reason).toBe('bad_response')
  })

  /**
   * A cancel of something Asaas does not have is a cancel. Failing here would
   * leave our row live against a subscription that is gone, which is the state
   * that keeps showing "Assinatura ativa" on an account nothing will charge.
   */
  it('treats a 404 on delete as success', async () => {
    const { client: c } = client([{ status: 404, body: { errors: [{ code: 'not_found' }] } }])
    expect(await c.deleteSubscription('sub_gone')).toBe(true)
  })

  it('does not treat a 404 on anything else as success', async () => {
    const { client: c } = client([{ status: 404, body: {} }])
    await expect(c.payment('pay_gone')).rejects.toThrow(AsaasError)
  })
})

/**
 * **`invoiceUrl` is a URL we hand a subscriber's browser, and it arrives in a
 * webhook body.**
 *
 * `webhook.ts` states the bound as *"a forged body cannot invent a
 * subscriber"*, which is true and incomplete: whoever holds
 * `ASAAS_WEBHOOK_TOKEN` cannot invent a subscriber but could repoint an
 * existing one's payment link, because `refreshCheckoutUrl` wrote the value
 * straight into `subscriptions.checkout_url` — a column that is `redirect()`ed
 * to and rendered as the pay-now `href`. An open redirect aimed at the one
 * screen where somebody is about to type card or Pix details.
 *
 * Review found it. No test had ever supplied a hostile URL, so the suite was
 * green throughout — and a green suite is not evidence.
 */
describe('invoice URLs', () => {
  it('accepts Asaas invoice pages in both environments', () => {
    expect(safeInvoiceUrl('https://www.asaas.com/i/abc123')).toBe('https://www.asaas.com/i/abc123')
    expect(safeInvoiceUrl('https://sandbox.asaas.com/i/abc')).toBe('https://sandbox.asaas.com/i/abc')
    expect(safeInvoiceUrl('https://asaas.com/i/abc')).toBe('https://asaas.com/i/abc')
  })

  it('refuses another host, however much it looks like one', () => {
    expect(safeInvoiceUrl('https://asaas.com.evil.test/i/abc')).toBeNull()
    expect(safeInvoiceUrl('https://notasaas.com/i/abc')).toBeNull()
    // `URL.hostname` is the host, so userinfo cannot smuggle one past it.
    expect(safeInvoiceUrl('https://asaas.com@evil.test/i/abc')).toBeNull()
  })

  it('refuses a scheme that is not https', () => {
    expect(safeInvoiceUrl('http://www.asaas.com/i/abc')).toBeNull()
    // The one that would run script in the reader's page if it reached an href.
    expect(safeInvoiceUrl('javascript:alert(1)')).toBeNull()
    expect(safeInvoiceUrl('data:text/html,<script>1</script>')).toBeNull()
  })

  it('refuses nothing, empty and unparseable rather than throwing', () => {
    expect(safeInvoiceUrl(null)).toBeNull()
    expect(safeInvoiceUrl(undefined)).toBeNull()
    expect(safeInvoiceUrl('')).toBeNull()
    expect(safeInvoiceUrl('not a url at all')).toBeNull()
  })
})
