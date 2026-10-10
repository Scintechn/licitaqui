import {
  apiKey,
  asaasEnvironment,
  baseUrl,
  billingEnabled,
  billingMode,
  configFault,
  type ConfigFault,
  type Env,
  USER_AGENT,
} from './config'

/**
 * The only thing in this repository that talks to Asaas — task **F2**.
 *
 * Server-only: it reads `ASAAS_API_KEY` and is imported by route handlers and
 * Server Functions, never by a client component.
 *
 * ## Six calls, and why each one exists
 *
 * | | |
 * |---|---|
 * | `GET /v3/customers?externalReference=…` | read-before-write: Asaas has **no idempotency-key header** and its own docs tell integrators to query before retrying |
 * | `POST /v3/customers` | with `notificationDisabled: true` — spec §9 |
 * | `GET /v3/subscriptions?externalReference=…` | the same read-before-write, one level up |
 * | `POST /v3/subscriptions` | monthly cycle, `billingType: CREDIT_CARD` — see below, boleto is not acceptable |
 * | `GET /v3/subscriptions/{id}/payments` | the **only** place a hosted-checkout URL exists: `invoiceUrl` on the first charge |
 * | `DELETE /v3/subscriptions/{id}` | the cancel that actually stops the money (D8) |
 *
 * `externalReference` is `licitaqui-user-<id>` — per **account**, never per
 * attempt, which is what makes the two reads idempotent across retries.
 *
 * ## Why `notificationDisabled` is not optional
 *
 * Spec §9: *"Asaas bills us for the billing notifications it sends on our
 * behalf … and they are on by default"*. Every customer is created with the
 * flag, and {@link AsaasClient.createCustomer} is the only way this code makes
 * one, so there is no path that forgets. A customer created without it is
 * fixed with `PUT /v3/notifications/batch` by hand; that is an operator task,
 * not a code path, because it should never be reachable.
 *
 * ## Dry run
 *
 * With `ASAAS_BILLING` anything but `live`, no socket is opened: every method
 * returns `{ status: 'dry_run' }` and the caller writes nothing but an event.
 * That is the default, so a deploy that forgets the variable cannot charge
 * anybody — and the symptom is visible rather than silent, because the
 * subscribe route answers a distinct state for it.
 *
 * ## Errors
 *
 * `AsaasError` carries a **reason code** and Asaas's own stable `code`, never
 * their `description`: an error body can echo a customer's name or document
 * back, and this object ends up in a log line. §12.
 *
 * 400/401/403/404 are permanent — retrying fails identically. 429 and 5xx are
 * retryable. A caller that cannot retry (a route answering a person) turns
 * either into a 503 and says so on screen.
 *
 * ## Timeouts
 *
 * Asaas allows *us* ten seconds to answer their webhook and there is no reason
 * to assume our calls to them are faster, so each call gets 15 s and the
 * orchestration above it (`checkout.ts`) makes at most three. A Vercel Node
 * function's default budget is well above that; the point of the ceiling is
 * that a hung Asaas becomes a 503 with a sentence on screen rather than a
 * timeout with none.
 */

export const DEFAULT_TIMEOUT_MS = 15_000

/** 400/401/403/404: retrying produces the same answer. */
const PERMANENT_STATUSES: ReadonlySet<number> = new Set([400, 401, 403, 404])

export type AsaasFailure =
  | ConfigFault
  | 'invalid_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'network'
  | 'bad_response'

export class AsaasError extends Error {
  readonly reason: AsaasFailure
  readonly status: number | null
  /** Asaas's own stable error code, when the body carried one. Never free text. */
  readonly code: string | null

  constructor(reason: AsaasFailure, options: { status?: number; code?: string } = {}) {
    super(`asaas: ${reason}`)
    this.name = 'AsaasError'
    this.reason = reason
    this.status = options.status ?? null
    this.code = options.code ?? null
  }

  get retryable(): boolean {
    if (this.status !== null && PERMANENT_STATUSES.has(this.status)) return false
    return this.reason === 'rate_limited' || this.reason === 'server_error'
      || this.reason === 'timeout' || this.reason === 'network'
  }
}

export type AsaasCustomer = { id: string }

export type AsaasSubscription = {
  id: string
  status: string | null
  /** `YYYY-MM-DD`. The date of the next charge Asaas will generate. */
  nextDueDate: string | null
  value: number | null
}

export type AsaasPayment = {
  id: string
  status: string | null
  value: number | null
  netValue: number | null
  dueDate: string | null
  paymentDate: string | null
  /** The hosted invoice page. This is the "checkout link". */
  invoiceUrl: string | null
  billingType: string | null
  subscription: string | null
}

export type CustomerRequest = {
  name: string
  cpfCnpj: string
  externalReference: string
  email?: string
  mobilePhone?: string
}

export type SubscriptionRequest = {
  customer: string
  /** Reais as a decimal, from `priceFor(...).reais`. Never centavos. */
  value: number
  /** `YYYY-MM-DD` in the product's clock (BRT). */
  nextDueDate: string
  externalReference: string
  description: string
}

/** `licitaqui-user-7` — per account, never per attempt. */
export function externalReference(userId: number): string {
  return `licitaqui-user-${userId}`
}

export type Transport = (url: string, init: RequestInit) => Promise<Response>

/**
 * A dry-run result. Distinct from a failure: nothing went wrong, nothing
 * happened, and the caller must not pretend a subscription exists.
 */
export const DRY_RUN = Symbol('asaas.dry_run')
export type Maybe<T> = T | typeof DRY_RUN

export class AsaasClient {
  private readonly env: Env
  private readonly transport: Transport
  private readonly timeoutMs: number

  constructor(
    options: { env?: Env; transport?: Transport; timeoutMs?: number } = {},
  ) {
    this.env = options.env ?? process.env
    this.transport = options.transport ?? ((url, init) => fetch(url, init))
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  get environment(): string {
    return asaasEnvironment(this.env)
  }

  get live(): boolean {
    return billingEnabled(this.env)
  }

  get mode(): string {
    return billingMode(this.env)
  }

  /**
   * Why this client cannot call, or `null`.
   *
   * **On `this.env`, not on `process.env`.** The caller must ask the client
   * rather than the environment: a test injects an env, and a `configFault()`
   * read straight off `process.env` answered `no_api_key` for a client that
   * was perfectly configured — which is how the first run of
   * `billing.db.test.ts` turned every checkout into `failed`.
   */
  get fault(): ConfigFault | null {
    return configFault(this.env)
  }

  /** The first customer with this reference, or `null`. */
  async findCustomer(reference: string): Promise<Maybe<AsaasCustomer | null>> {
    const body = await this.request('GET', '/customers', {
      query: { externalReference: reference, limit: '1' },
    })
    if (body === DRY_RUN) return DRY_RUN
    const row = firstRow(body)
    return row && typeof row.id === 'string' ? { id: row.id } : null
  }

  async createCustomer(request: CustomerRequest): Promise<Maybe<AsaasCustomer>> {
    const body = await this.request('POST', '/customers', {
      json: {
        name: request.name,
        cpfCnpj: request.cpfCnpj,
        externalReference: request.externalReference,
        // Spec §9. Not a parameter: there is no caller that should be able to
        // leave it off, because Asaas charges us per message it sends.
        notificationDisabled: true,
        ...(request.email ? { email: request.email } : {}),
        ...(request.mobilePhone ? { mobilePhone: request.mobilePhone } : {}),
      },
    })
    if (body === DRY_RUN) return DRY_RUN
    const id = asRecord(body)?.id
    if (typeof id !== 'string' || !id) throw new AsaasError('bad_response')
    return { id }
  }

  /**
   * The live subscription with this reference, or `null`.
   *
   * Asaas keeps deleted subscriptions in the list with `deleted: true`, and a
   * `status` of `INACTIVE` means it will not charge again, so neither is one we
   * may reuse — reusing a deleted subscription would hand somebody a checkout
   * link that can never be paid.
   */
  async findSubscription(reference: string): Promise<Maybe<AsaasSubscription | null>> {
    const body = await this.request('GET', '/subscriptions', {
      query: { externalReference: reference, limit: '10' },
    })
    if (body === DRY_RUN) return DRY_RUN
    const rows = allRows(body)
    for (const row of rows) {
      if (row.deleted === true) continue
      const status = typeof row.status === 'string' ? row.status.toUpperCase() : null
      if (status === 'INACTIVE' || status === 'EXPIRED') continue
      if (typeof row.id !== 'string' || !row.id) continue
      return subscriptionOf(row)
    }
    return null
  }

  async createSubscription(request: SubscriptionRequest): Promise<Maybe<AsaasSubscription>> {
    const body = await this.request('POST', '/subscriptions', {
      json: {
        customer: request.customer,
        /*
         * **Card only, decided by Sci on 2026-10-10 against a measured
         * refusal.** This was `UNDEFINED`, whose comment claimed it let the
         * payer pick "Pix or card". It does not: `UNDEFINED` offers **boleto**
         * too, and the first sandbox subscription came back
         * `billing_type: BOLETO`.
         *
         * That breaks a published promise. The terms carry a **7-day
         * withdrawal (CDC art. 49)** and a **30-day guarantee**, and Asaas
         * refuses to refund a boleto: *"Somente é possível estornar cobranças
         * cuja a forma de pagamento seja cartão de crédito ou Pix."* So a
         * boleto subscriber could not be refunded through the API at all —
         * only by a manual bank transfer, every time.
         *
         * **And Pix cannot rescue it here.** On an Asaas *subscription* Pix is
         * not a method of its own: you ask for boleto and the boleto carries a
         * Pix QR, which is recorded as `BOLETO` and is therefore equally
         * unrefundable. A standalone Pix *charge* is refundable — that stays
         * available to any future one-off, just not to a subscription.
         *
         * `CREDIT_CARD` is the only value that is both refundable and actually
         * recurring: the card is on file, so a renewal needs nothing from the
         * subscriber. The cost is that `billing.subscribe.methods` ("Você pode
         * pagar com Pix ou cartão") is now false — Sci's sentence to rewrite
         * under legal brief §5, tracked in `docs/CLAIMS.md`.
         */
        billingType: 'CREDIT_CARD',
        value: request.value,
        nextDueDate: request.nextDueDate,
        cycle: 'MONTHLY',
        description: request.description,
        externalReference: request.externalReference,
      },
    })
    if (body === DRY_RUN) return DRY_RUN
    const row = asRecord(body)
    if (!row || typeof row.id !== 'string' || !row.id) throw new AsaasError('bad_response')
    return subscriptionOf(row)
  }

  /** This subscription's charges, newest-first as Asaas returns them. */
  async subscriptionPayments(subscriptionId: string): Promise<Maybe<AsaasPayment[]>> {
    const body = await this.request(
      'GET',
      `/subscriptions/${encodeURIComponent(subscriptionId)}/payments`,
      {},
    )
    if (body === DRY_RUN) return DRY_RUN
    return allRows(body).map(paymentOf)
  }

  async payment(paymentId: string): Promise<Maybe<AsaasPayment>> {
    const body = await this.request('GET', `/payments/${encodeURIComponent(paymentId)}`, {})
    if (body === DRY_RUN) return DRY_RUN
    const row = asRecord(body)
    if (!row || typeof row.id !== 'string') throw new AsaasError('bad_response')
    return paymentOf(row)
  }

  /**
   * Stop the subscription from charging again.
   *
   * `DELETE` is Asaas's own verb for this and it does not refund anything
   * already paid — which is exactly the Prime model the terms describe: auto
   * renewal off, paid access to the end of the period already paid for.
   *
   * A 404 resolves to success. The caller is cancelling something it believes
   * exists, and "Asaas does not have it" and "Asaas will not charge it again"
   * are the same outcome for the person pressing the button; failing here
   * would leave our row live against an Asaas subscription that is gone.
   */
  async deleteSubscription(subscriptionId: string): Promise<Maybe<true>> {
    try {
      const body = await this.request(
        'DELETE',
        `/subscriptions/${encodeURIComponent(subscriptionId)}`,
        {},
      )
      return body === DRY_RUN ? DRY_RUN : true
    } catch (error) {
      if (error instanceof AsaasError && error.status === 404) return true
      throw error
    }
  }

  // -- transport --------------------------------------------------------------

  private async request(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    options: { query?: Record<string, string>; json?: unknown },
  ): Promise<Maybe<unknown>> {
    if (!this.live) return DRY_RUN

    const fault = configFault(this.env)
    if (fault) throw new AsaasError(fault)

    const url = new URL(`${baseUrl(this.env)}${path}`)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    let response: Response
    try {
      response = await this.transport(url.toString(), {
        method,
        headers: {
          // Asaas v3 authenticates with its own header, not `Authorization`.
          access_token: apiKey(this.env),
          accept: 'application/json',
          'user-agent': USER_AGENT,
          ...(options.json === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
        signal: controller.signal,
        // A redirect from a payment API is not something to follow blindly.
        redirect: 'manual',
      })
    } catch (error) {
      const name = (error as { name?: string } | null)?.name
      throw new AsaasError(name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'network')
    } finally {
      clearTimeout(timer)
    }

    const text = await response.text().catch(() => '')
    if (!response.ok) throw failureOf(response.status, text)
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      throw new AsaasError('bad_response', { status: response.status })
    }
  }
}

/**
 * An Asaas error status and body, as a reason code.
 *
 * The body is parsed only for `errors[0].code`, Asaas's own stable identifier.
 * `description` is free text that can contain the customer's name or document
 * and is deliberately dropped (§12).
 */
function failureOf(status: number, text: string): AsaasError {
  let code: string | undefined
  try {
    const parsed = asRecord(JSON.parse(text))
    const errors = parsed?.errors
    if (Array.isArray(errors)) {
      const first = asRecord(errors[0])
      if (typeof first?.code === 'string') code = first.code
    }
  } catch {
    // An unparseable error body is still an error with a status.
  }
  const reason: AsaasFailure =
    status === 400 ? 'invalid_request'
    : status === 401 ? 'unauthorized'
    : status === 403 ? 'forbidden'
    : status === 404 ? 'not_found'
    : status === 429 ? 'rate_limited'
    : 'server_error'
  return new AsaasError(reason, { status, ...(code ? { code } : {}) })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** Asaas list responses are `{ data: [...] }`. */
function allRows(body: unknown): Record<string, unknown>[] {
  const data = asRecord(body)?.data
  if (!Array.isArray(data)) return []
  return data.map(asRecord).filter((row): row is Record<string, unknown> => row !== null)
}

function firstRow(body: unknown): Record<string, unknown> | null {
  return allRows(body)[0] ?? null
}

function subscriptionOf(row: Record<string, unknown>): AsaasSubscription {
  return {
    id: String(row.id),
    status: typeof row.status === 'string' ? row.status.toUpperCase() : null,
    nextDueDate: asDate(row.nextDueDate),
    value: asNumber(row.value),
  }
}

function paymentOf(row: Record<string, unknown>): AsaasPayment {
  return {
    id: typeof row.id === 'string' ? row.id : '',
    status: typeof row.status === 'string' ? row.status.toUpperCase() : null,
    value: asNumber(row.value),
    netValue: asNumber(row.netValue),
    // **`dueDate`, not `nextDueDate`.** A payment has `dueDate`,
    // `originalDueDate`, `paymentDate`, `clientPaymentDate` and
    // `confirmedDate`; `nextDueDate` is a *subscription* field. The
    // 2026-09-25 draft read `payment.nextDueDate` when granting access, which
    // is always absent, so `next_charge_on` would have frozen at its
    // creation-time value and `billing.status.nextCharge` would have shown a
    // stale date from the second month onward.
    dueDate: asDate(row.dueDate),
    paymentDate: asDate(row.paymentDate) ?? asDate(row.clientPaymentDate)
      ?? asDate(row.confirmedDate),
    invoiceUrl: typeof row.invoiceUrl === 'string' ? row.invoiceUrl : null,
    billingType: typeof row.billingType === 'string' ? row.billingType : null,
    subscription: typeof row.subscription === 'string' ? row.subscription : null,
  }
}

/** `YYYY-MM-DD` or nothing. Asaas sends dates as strings in that shape. */
function asDate(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
