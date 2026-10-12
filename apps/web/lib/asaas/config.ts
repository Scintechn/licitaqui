/**
 * Asaas configuration, in one place — task **F2**, spec §8, §9.
 *
 * The house pattern for anything with an environment variable in it: a `*_VAR`
 * constant per name, and every function taking `env` so a test can inject one
 * instead of mutating `process.env`. Same shape as `lib/telegram/config.ts`,
 * `lib/auth/config.ts` and `lib/admin/auth.ts`.
 *
 * ## Why the API key lives on this side
 *
 * The 2026-09-25 draft of this module deliberately held **no** API key, on the
 * grounds that *"spec §3 forbids a web request from calling an external
 * service"*. §3 says no such thing: it is the caching strategy, and the rule
 * CLAUDE.md draws from it names **PNCP, BrasilAPI and OpenRouter** — three
 * data sources whose answers are cached in Postgres and served stale. Asaas is
 * not one of them, and spec §8 is explicit in the other direction:
 *
 * > `POST /api/subscribe` | user | Creates Asaas customer and subscription …
 * > **and returns the checkout link**
 *
 * A founder taps "Assinar" and has to be handed a payment page. Deferring that
 * to the worker means the button answers 202 and the screen polls — and the
 * draft that did exactly that had no way to tell a failed job from a slow one,
 * so a founder whose job failed watched "aguardando" for ever. Three Asaas
 * calls in one request is the cost of a link that exists when the button is
 * released.
 *
 * §12's rule is *"the Asaas key never reaches the browser"*, and a Node route
 * handler is not the browser. Nothing here is imported by a client component;
 * `lib/asaas/client.ts` reads the key and is server-only.
 *
 * ## Fail closed, in both directions
 *
 * `webhookToken()` returns `''` when the variable is missing, and the webhook
 * route turns that into a 503 for everybody: the endpoint is public, it accepts
 * arbitrary JSON, and what it writes decides who has a paid plan. `apiKey()`
 * returns `''` when unset, and the subscribe route turns that into a 503
 * rather than a half-made subscription.
 *
 * ## The kill switch
 *
 * `ASAAS_BILLING` mirrors `WHATSAPP_DELIVERY` and `EMAIL_DELIVERY` in the
 * worker: anything other than the exact string `live` is a **dry run**, in
 * which no HTTP call is made and no money can move. A typo lands in the safe
 * direction, which is the same reasoning `resend.delivery_mode()` gives.
 *
 * **It is NOT in `.env.example`, and this comment said it was.** The sentence
 * that stood here claimed the file named it alongside the other three, two
 * sentences after explaining that the parked draft's version of this switch
 * *"existed only in Python and in no `.env.example`, no README and no doc, so
 * a deploy that forgot it would have created no subscriptions with no
 * symptom"*. The diagnosis was right and the fix was asserted rather than
 * made — review caught it — and the consequence is the failure that paragraph
 * describes: on 17/10 at 12:00 BRT every founder would read
 * `billing.subscribe.error` while one `console.error` said why.
 *
 * It is not in the file because **an agent cannot write `.env*` here**: the
 * permission layer refuses, deliberately, and the same deny rule has already
 * left `S3_BUCKET` and the AWS keys undocumented (see `docs/STATUS.md`'s B4B
 * row, which says so). So it is **Sci's line to add**, it is on the F2 PR, and
 * `G12` carries it beside the production key:
 *
 * ```
 * ASAAS_BILLING=          # live | anything else (dry run)
 * ```
 *
 * ## What is never logged
 *
 * Not the key, not the webhook token (§12), and not a checkout URL: an Asaas
 * `invoiceUrl` identifies one customer's invoice, so it is personal data in
 * the same way a chat id is.
 */

export type Env = Record<string, string | undefined>

/** The sandbox or production API key. `$aact_hmlg_…` / `$aact_prod_…`. */
export const API_KEY_VAR = 'ASAAS_API_KEY'

/**
 * The token Asaas echoes in `asaas-access-token` on every webhook delivery,
 * set once when the webhook is registered.
 */
export const WEBHOOK_TOKEN_VAR = 'ASAAS_WEBHOOK_TOKEN'

/** `sandbox` (the default everywhere) or `production`. */
export const ENV_VAR = 'ASAAS_ENV'

/** `live` enables real calls. Anything else, including unset, is a dry run. */
export const BILLING_VAR = 'ASAAS_BILLING'

export const SANDBOX = 'sandbox'
export const PRODUCTION = 'production'
export const BILLING_LIVE = 'live'
export const BILLING_DRY_RUN = 'dry_run'

export const BASE_URLS: Readonly<Record<string, string>> = Object.freeze({
  [SANDBOX]: 'https://api-sandbox.asaas.com/v3',
  [PRODUCTION]: 'https://api.asaas.com/v3',
})

/**
 * Asaas's key prefixes, which is the only cheap way to catch the mistake that
 * matters most: a production key configured while `ASAAS_ENV=sandbox`, or the
 * reverse. The first would charge real money from a preview deployment.
 */
export const KEY_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
  [SANDBOX]: '$aact_hmlg_',
  [PRODUCTION]: '$aact_prod_',
})

/**
 * Asaas has required a `User-Agent` on every call since 2024-06-13 and
 * answers 403 without one.
 */
export const USER_AGENT = 'LicitaQui/0.1 (+https://www.licitaquiapp.com.br)'

function value(env: Env, name: string): string {
  return (env[name] ?? '').trim()
}

/** Asaas's own domain. Invoice pages are `https://{,sandbox.}asaas.com/i/<id>`. */
export const INVOICE_HOST = 'asaas.com'

/**
 * An Asaas invoice URL, or `null` for anything that is not one.
 *
 * **`invoiceUrl` arrives in a webhook body, and the webhook body is not
 * trustworthy in this particular way.** `webhook.ts` states the forgery bound
 * as *"a forged body cannot invent a subscriber"*, which is true and
 * incomplete: whoever holds `ASAAS_WEBHOOK_TOKEN` cannot invent a subscriber
 * but could, until 2026-10-09, **repoint an existing subscriber's payment
 * link**. `refreshCheckoutUrl` wrote the value straight into
 * `subscriptions.checkout_url`, and that column is both `redirect()`ed to
 * (`conta/plano/actions.ts`) and rendered as the pay-now `href`
 * (`plan-view.tsx`) — an open redirect aimed at the one screen where somebody
 * is about to type card details. Review found it; no test supplied a
 * hostile URL, so the suite was green.
 *
 * Checked here rather than at each site so the two writers (`checkout.ts`'s
 * first invoice and the webhook's refresh) cannot disagree, which is how the
 * `AWAITING` allow-list came to be applied to one of them and not the other.
 *
 * `https` only, and the host must be `asaas.com` or a subdomain of it — the
 * sandbox serves `sandbox.asaas.com`, so both environments pass without this
 * needing to know which one is configured. A `userinfo` prefix cannot smuggle
 * another host past it: `URL.hostname` is the host, and
 * `https://asaas.com@evil.test/` parses with `hostname === 'evil.test'`.
 */
export function safeInvoiceUrl(candidate: string | null | undefined): string | null {
  if (!candidate) return null
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== 'https:') return null
  const host = url.hostname.toLowerCase()
  if (host !== INVOICE_HOST && !host.endsWith(`.${INVOICE_HOST}`)) return null
  return candidate
}

/** The configured API key, or `''` when it is unset. */
export function apiKey(env: Env = process.env): string {
  return value(env, API_KEY_VAR)
}

/**
 * The configured webhook token, or `''` when it is unset.
 *
 * **No minimum length.** The 2026-09-25 draft refused anything under 32
 * characters, on the grounds that 32 is Asaas's own documented floor and a
 * shorter value therefore cannot be a token Asaas accepted. The risk runs the
 * wrong way: if the console ever accepts a shorter one, every delivery gets a
 * 503, fifteen of those pause the queue, and Asaas deletes undelivered events
 * after 14 days — lost payments on accounts that have been charged, which is
 * the one outcome worth more than a strict check. An unset token still fails
 * closed; a short one authenticates and is compared in constant time.
 */
export function webhookToken(env: Env = process.env): string {
  return value(env, WEBHOOK_TOKEN_VAR)
}

/**
 * Which Asaas account we are talking to.
 *
 * Anything unrecognised is the sandbox, for the same reason the worker's kill
 * switch treats a typo as a dry run: the safe direction has to be the one a
 * mistake lands in.
 */
export function asaasEnvironment(env: Env = process.env): string {
  return value(env, ENV_VAR).toLowerCase() === PRODUCTION ? PRODUCTION : SANDBOX
}

/** Whether a checkout link on screen is play money. */
export function isSandbox(env: Env = process.env): boolean {
  return asaasEnvironment(env) === SANDBOX
}

export function baseUrl(env: Env = process.env): string {
  return BASE_URLS[asaasEnvironment(env)]
}

/** `live`, or `dry_run` for every other value including unset. */
export function billingMode(env: Env = process.env): string {
  return value(env, BILLING_VAR).toLowerCase() === BILLING_LIVE ? BILLING_LIVE : BILLING_DRY_RUN
}

export function billingEnabled(env: Env = process.env): boolean {
  return billingMode(env) === BILLING_LIVE
}

/**
 * Why a call cannot be made, or `null` when it can.
 *
 * A single function so the route's 503 and the test's assertion read the same
 * reason, and so a new reason cannot be added in one place and missed in the
 * other. The strings are stable: they reach a log line and `events.props`.
 */
export type ConfigFault = 'no_api_key' | 'key_environment_mismatch'

export function configFault(env: Env = process.env): ConfigFault | null {
  const key = apiKey(env)
  if (!key) return 'no_api_key'
  const expected = KEY_PREFIXES[asaasEnvironment(env)]
  // Only when the key looks like an Asaas key at all: the sandbox's own
  // documentation has used unprefixed keys in the past, and refusing an
  // otherwise-valid key because it does not match a prefix table would be
  // §4d's mistake — pinning a threshold that is not one.
  if (key.startsWith('$aact_') && !key.startsWith(expected)) return 'key_environment_mismatch'
  return null
}
