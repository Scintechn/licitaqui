import { sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { applyEvent } from '@/lib/asaas/entitlement'
import { authorizeWebhook, denyWebhook, readEvent } from '@/lib/asaas/webhook'
import { db } from '@/lib/db'
import { rateLimitRequest } from '@/lib/rate-limit'

/**
 * `POST /api/asaas/webhook` — spec §8, §12, task **F2**.
 *
 * Asaas's only way of telling us a founder paid. It authenticates the
 * delivery, **persists the body**, applies it in one transaction, and answers
 * 200.
 *
 * ## Why this route answers 200 to almost everything
 *
 * Asaas is much less forgiving than Telegram and the penalty is worse:
 *
 *  * Only **HTTP 200** counts as success. `201` and `204` are recorded as
 *    failures — which is why {@link ok} returns a body rather than a 204.
 *  * It waits **10 seconds** and does not follow redirects.
 *  * After **15 consecutive failures the queue is paused** for this webhook,
 *    and undelivered events are **deleted after 14 days**.
 *
 * So a paused queue is not "payments arrive late". It is payments we never
 * hear about, on accounts that have been charged, with the evidence gone.
 * Everything that cannot be fixed by retrying — an event we have no rule for,
 * a body we cannot read, a duplicate, a subscription we never created — is 200
 * with the body stored. The single case that returns 500 is our own transient
 * database failure, because that is the one case where a retry helps.
 *
 * An unconfigured token is 503, not 200: answering 200 to an unauthenticated
 * caller while the endpoint is open would be worse than a paused queue.
 *
 * ## No rate limit, deliberately
 *
 * `rateLimitRequest` is per-instance and in-memory, so on Vercel each lambda
 * counts separately and the effective limit is whatever the fan-out happens to
 * be. A 429 is one of Asaas's fifteen strikes. The 2026-09-25 draft set a
 * limit of 600/min here and its own comment acknowledged the hazard; this
 * keeps the limiter only as a **flood guard far above any legitimate volume**,
 * and the token is the gate. 25 founders on one renewal day is a few dozen
 * events; the ceiling below is three orders of magnitude above that, so
 * reaching it means something is wrong that a 429 is the right answer to.
 *
 * ## Idempotency
 *
 * `webhook_events.id` is the Asaas event id and the insert is `on conflict do
 * nothing`, so a redelivery writes nothing and does nothing. The layers that
 * alone cannot cover — one *payment* granting access once across the two or
 * three events that describe it — are in `lib/asaas/entitlement.ts`.
 *
 * **The insert and the apply are one transaction**, which is the correction to
 * the draft's shape: there, the route stored the body and then enqueued a job,
 * so if the enqueue failed the 500 made Asaas retry, the retry found the row
 * already stored, answered 200 and queued nothing — the event was persisted
 * and never processed, with no sweep anywhere that would have found it. Here a
 * failure rolls the insert back too, so the retry genuinely retries.
 *
 * `webhook_events` has existed since migration 0001 with no reader and no
 * writer. This is its first one.
 *
 * ## §12
 *
 * An Asaas body carries the customer's name, CPF/CNPJ, e-mail and phone. It
 * goes into `webhook_events.body` and nowhere else: not into a log line, not
 * into the response. Nothing here logs anything but an event name, an event id
 * and an error code.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** A flood guard, not a quota. See "No rate limit, deliberately" above. */
const RATE_LIMIT = { limit: 10_000, windowMs: 60_000 }

/**
 * Asaas event bodies are a few kilobytes. 256 KiB is far above anything they
 * send and far below anything worth handing to `JSON.parse`.
 *
 * Measured in **bytes**, which the draft got wrong: `String.length` counts
 * UTF-16 code units, so a body of multi-byte characters passed a byte ceiling
 * it had not actually met. It only ever under-rejected, but a check should
 * measure what it says it measures.
 */
const MAX_BODY_BYTES = 256 * 1024

const HEADERS: Record<string, string> = {
  'cache-control': 'private, no-store',
  'x-robots-tag': 'noindex, nofollow',
}

export async function POST(request: Request): Promise<Response> {
  const decision = await rateLimitRequest('asaas-webhook', request.headers, RATE_LIMIT)
  if (!decision.ok) {
    return NextResponse.json(
      { ok: false },
      { status: 429, headers: { ...HEADERS, 'retry-after': String(decision.retryAfter) } },
    )
  }

  const auth = authorizeWebhook(request.headers)
  if (!auth.ok) {
    // The reason is in our log and not in the response: an unauthenticated
    // caller learns nothing either way, and the log line carries no body.
    console.warn(`asaas webhook denied (${auth.reason})`)
    return denyWebhook(auth.reason)
  }

  const raw = await request.text()
  /**
   * **Three ways to answer 200 and do nothing, and each one now says so.**
   *
   * They are 200 because a retry cannot make an oversized, unparseable or
   * unreadable body readable, and fifteen non-2xx answers pause Asaas's
   * delivery queue. But the first version recorded *nothing* for any of them —
   * no log, no `webhook_events` row, nothing to find. If Asaas ever changed
   * the envelope shape, every payment would be dropped with a cheerful 200
   * and the only symptom would be founders without plans. Review named it;
   * B32's rule is the same one the worker's blocked sweep already follows: a
   * run that produced no result has to say so loudly.
   *
   * §12: the body is never logged. Only its size, and why it was refused.
   */
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    console.error(`asaas webhook discarded: body over ${MAX_BODY_BYTES} bytes`)
    return ok()
  }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    console.error('asaas webhook discarded: body is not JSON')
    return ok()
  }

  const event = readEvent(body)
  if (!event) {
    console.error('asaas webhook discarded: no usable id and event in the envelope')
    return ok()
  }

  try {
    const outcome = await db().transaction(async (tx) => {
      const stored = await tx.execute<{ id: string }>(sql`
        insert into webhook_events (id, source, event, body)
        values (${event.id}::text, 'asaas'::text, ${event.event}::text,
                ${JSON.stringify(event.body)}::jsonb)
        on conflict (id) do nothing
        returning id
      `)
      // A redelivery of an event we have already stored. `applyEvent` also
      // refuses on `processed_at`, so running it here would be correct; it is
      // skipped because there is nothing to add and the row is locked by
      // whichever delivery is still inside its own transaction.
      if (stored.rows.length === 0) return { outcome: 'duplicate' as const }
      return applyEvent(event, tx)
    })
    console.info(`asaas webhook ${event.event}: ${outcome.outcome}`)
    return ok()
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'unknown'
    console.error(`POST /api/asaas/webhook failed (${code}) event=${event.event}`)
    // Ours, and transient. The one case where a redelivery helps — and the one
    // case where spending a strike is right.
    return NextResponse.json({ ok: false }, { status: 500, headers: HEADERS })
  }
}

/** Asaas only ever POSTs here. A GET is someone finding the URL. */
export function GET(): Response {
  return NextResponse.json({ ok: false }, { status: 405, headers: HEADERS })
}

/**
 * 200 with a body, not 204.
 *
 * Asaas counts `204` as a failed delivery — their FAQ and their paused-queue
 * page both say only 200 is success, contradicting their own overview page's
 * looser "2xx". Fifteen of those pauses the queue. The body is what makes the
 * 200 unambiguous.
 */
function ok(): Response {
  return NextResponse.json({ ok: true }, { status: 200, headers: HEADERS })
}
