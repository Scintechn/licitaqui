'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { startCheckout } from '@/lib/asaas/checkout'
import { AsaasClient, AsaasError, DRY_RUN } from '@/lib/asaas/client'
import { cancelSubscription, readSubscription } from '@/lib/asaas/subscription'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { recordEventSafely } from '@/lib/events'
import { rateLimitRequest } from '@/lib/rate-limit'
import { ACCOUNT_CREATE_PATH, COMPANY_PATH, PLAN_PATH } from '@/lib/routes'
import { withQuery } from '@/lib/url'
import type { PlanState } from './states'

/**
 * What `/conta/plano` actually *does* — tasks **F2** and **D8**.
 *
 * Its own `'use server'` module, like `app/conta/actions.ts` and
 * `app/conta/alertas/actions.ts`, so the view stays pure and renders in a test
 * with no-ops for these.
 *
 * ## Why Server Functions and not `POST /api/subscribe`
 *
 * `docs/TECHNICAL_SPEC.md:438` named a route. The spec row is amended in the
 * same PR as this file, and the reason is worth keeping:
 *
 *  * The button has to hand the person a payment page. A route means client
 *    JavaScript that fetches, reads JSON and assigns `window.location`; a
 *    Server Function can `redirect()` to the Asaas invoice directly, so the
 *    one-click promise is one click with no client bundle at all.
 *  * Every other account mutation in this product is already a Server Function
 *    (`saveCompany`, `connectTelegram`, `savePreferences`), and billing lives
 *    at `/conta/plano` alongside them.
 *  * **One path to money.** A route *and* an action would be two ways to
 *    create a charge, and the second one would be the one nobody tested.
 *
 * `POST /api/asaas/webhook` stays a route, because Asaas has to POST somewhere.
 *
 * ## Both of these re-read the session
 *
 * A Server Function is a POST endpoint with a generated name: the button that
 * calls it is not the only thing that can. So neither takes a user id from its
 * caller — they read the session themselves and act on that account, and a
 * signed-out call redirects instead of doing anything.
 *
 * ## And both are rate limited, which the other action modules are not
 *
 * `saveCompany` writing a CNPJ twice is harmless. These two create and destroy
 * charges at a payment provider, so each gets the limiter the routes use,
 * keyed on the request headers. Asaas has no idempotency-key header, so a
 * double tap is defended twice over: the limiter, and `externalReference`
 * read-before-write inside `startCheckout`.
 *
 * ## §12
 *
 * Nothing here logs a checkout URL (it opens one named customer's invoice), a
 * CNPJ or an e-mail. The `events` rows carry a plan name and nothing else.
 */

/** Tight: each call that gets through can create or destroy a charge. */
const RATE_LIMIT = { limit: 8, windowMs: 60_000 }

/**
 * The `?estado=` values live in `./states`, **not here**: a `'use server'` file
 * may export only async functions, and Next rejects anything else at build
 * time — not at `tsc --noEmit` and not under Vitest. A `const` beside these two
 * functions would have been a green suite and a failed deploy.
 */
const to = (state: PlanState) => withQuery(PLAN_PATH, `estado=${state}`)

async function currentUserId(): Promise<number> {
  const session = await auth()
  const id = session?.user?.id
  if (!id) redirect(ACCOUNT_CREATE_PATH)
  return Number(id)
}

/**
 * `next/headers` returns a read-only view; `rateLimitRequest` only ever calls
 * `.get()` on it. The cast is the narrowest way to say that — copying the
 * headers into a fresh `Headers` would work and would also copy a cookie
 * header for no reason.
 */
async function requestHeaders(): Promise<Headers> {
  return (await headers()) as unknown as Headers
}

/**
 * "Ir para o pagamento" — create the subscription and hand over the invoice.
 *
 * Ends in a `redirect`, always: to Asaas when there is a link, and back to the
 * plan screen with a state otherwise. There is no branch that returns to a
 * screen saying nothing happened.
 */
export async function goToCheckout(): Promise<void> {
  const userId = await currentUserId()
  const decision = await rateLimitRequest('subscribe', await requestHeaders(), RATE_LIMIT)
  if (!decision.ok) return redirect(to('muitas-tentativas'))

  const result = await startCheckout(userId)

  switch (result.outcome) {
    case 'already_active':
      return redirect(to('ativo'))
    case 'needs_company':
      // Asaas requires a document and a name. The screen does not offer this
      // button without a CNPJ, so reaching here means the account lost one
      // between render and submit; `/conta/empresa` is where it is fixed.
      // **The sentence that explains why is Sci's and does not exist** —
      // card F8, and a `docs/CLAIMS.md` row.
      return redirect(COMPANY_PATH)
    case 'dry_run':
      // Loud on purpose: a deploy that forgot `ASAAS_BILLING=live` must not
      // look like a provider outage. The reader sees `billing.subscribe.error`,
      // which is true — we could not open the page — and the operator sees
      // this line.
      console.error('billing: ASAAS_BILLING is not live, no subscription was created')
      return redirect(to('erro'))
    case 'failed':
      return redirect(to('erro'))
    case 'ready':
      break
  }

  // §14's gate metric. A plan name, never the amount and never a URL.
  await recordEventSafely({ name: 'checkout_opened', userId, props: { plan: result.plan } })

  if (result.checkoutUrl) return redirect(result.checkoutUrl)
  // The subscription exists and Asaas has not produced the invoice yet. The
  // screen shows it as pending and the next load picks the link up.
  return redirect(to('aguardando'))
}

/**
 * "Sim, cancelar" — switch off auto-renewal, in one action.
 *
 * ## Asaas first, our row second
 *
 * The order is the whole correctness argument. If our row were written first
 * and the Asaas call then failed, we would show a cancelled subscription that
 * keeps charging every month — the worst outcome available. In this order the
 * failure modes are:
 *
 *  * Asaas refuses → nothing changed, the screen says so, the money keeps
 *    flowing and the person can press again.
 *  * Asaas cancels and our write fails → the subscription stops charging and
 *    our row still says active, which **self-heals**: Asaas sends
 *    `SUBSCRIPTION_DELETED`, and `lib/asaas/entitlement.ts` ends the row.
 *
 * ## It does not refund
 *
 * Terms §8's model: auto-renewal off, paid access to the last day of the
 * period already paid for. `subscriptions.ends_on` is that day, and
 * `expire_subscriptions` in the worker drops the plan when it arrives.
 * `billing.cancel.untilWhen` is the approved sentence that says so.
 *
 * A refund is a different act under a different rule (CDC art. 49 inside 7
 * days, our own guarantee to 30), it is issued from the Asaas console, and
 * `subscriptions.refunded_at` / `refund_reason` record which rule applied.
 * **Nothing writes those two columns** — a webhook cannot know which rule a
 * refund was issued under, and guessing would put a legal classification in
 * the database. Card **F9**.
 *
 * ## The optional reason is not rendered
 *
 * `billing.cancel.reasonLabel` and `reasonHelp` are approved copy for a
 * free-text field and there is **no column to put it in**. Rendering it would
 * be a form field whose answer is discarded, which is worse than not asking.
 * Card **F11**.
 */
export async function confirmCancel(): Promise<void> {
  const userId = await currentUserId()
  const decision = await rateLimitRequest('subscribe-cancel', await requestHeaders(), RATE_LIMIT)
  if (!decision.ok) return redirect(to('muitas-tentativas'))

  const found = await readSubscription(userId)
  if (found.state === 'unavailable') return redirect(to('erro'))
  if (found.state === 'none') return redirect(to('sem-assinatura'))

  const plan = found.subscription.plan
  const asaasSubscriptionId = found.subscription.asaasSubscriptionId
  const client = new AsaasClient()
  if (client.live) {
    try {
      const stopped = await client.deleteSubscription(asaasSubscriptionId)
      if (stopped === DRY_RUN) {
        console.error('billing: cancel reached a dry-run client with live billing')
        return redirect(to('erro'))
      }
    } catch (error) {
      const reason = error instanceof AsaasError ? error.reason : 'unknown'
      console.error(`billing: cancel failed at asaas (${reason})`)
      return redirect(to('erro'))
    }
  } else {
    // Billing is off, so there is nothing at Asaas to stop. The local row is
    // still cancelled, because a dry-run environment in which the cancel
    // screen cannot be exercised is a screen nobody can test. Loud, for the
    // same reason as above.
    console.error('billing: ASAAS_BILLING is not live, cancelling the local row only')
  }

  const result = await db().transaction((tx) => cancelSubscription(userId, tx))
  if (!result.cancelled) return redirect(to('sem-assinatura'))

  await recordEventSafely({ name: 'cancelled', userId, props: { source: 'account', plan } })

  return redirect(to('cancelado'))
}
