import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WEBHOOK_TOKEN_VAR } from '@/lib/asaas/config'
import { TOKEN_HEADER } from '@/lib/asaas/webhook'

/** What happened, in order. The order is one of the things under test. */
const order = vi.hoisted(() => [] as string[])

const rateLimitRequest = vi.hoisted(() => vi.fn())
const applyEvent = vi.hoisted(() => vi.fn())
const execute = vi.hoisted(() => vi.fn())
const transaction = vi.hoisted(() => vi.fn())

vi.mock('@/lib/rate-limit', () => ({ rateLimitRequest }))
vi.mock('@/lib/asaas/entitlement', () => ({ applyEvent }))
vi.mock('@/lib/db', () => ({ db: () => ({ execute, transaction }) }))

const { GET, POST } = await import('./route')

const TOKEN = 'a-token-asaas-would-have-accepted-0001'

const EVENT = {
  id: 'evt_1',
  event: 'PAYMENT_CONFIRMED',
  payment: { id: 'pay_1', subscription: 'sub_1', status: 'CONFIRMED', value: 57 },
}

/** The transaction the route runs in. One object, so identity is checkable. */
const TX = { execute }

/**
 * `POST /api/asaas/webhook` — spec §8, §12, task **F2**.
 *
 * **The assertions worth having here are about the status code, not about the
 * business.** Asaas counts only HTTP 200 as success, waits ten seconds, does
 * not follow redirects, and **pauses the delivery queue after fifteen
 * consecutive failures** — after which undelivered events are deleted at
 * fourteen days. So an over-eager non-2xx is not a slower payment: it is a
 * payment we never hear about, on an account that has been charged, with the
 * evidence gone.
 *
 * Every case below therefore asks *what does Asaas see?* The grant itself
 * belongs to `lib/asaas/entitlement.ts` and is proven against a real Postgres
 * in `lib/asaas/billing.db.test.ts` — this file mocks it deliberately, so a
 * change to the grant cannot make a status-code test go green or red.
 */
describe('POST /api/asaas/webhook', () => {
  beforeEach(() => {
    order.length = 0
    rateLimitRequest.mockReset()
    applyEvent.mockReset()
    execute.mockReset()
    transaction.mockReset()

    rateLimitRequest.mockResolvedValue({ ok: true, retryAfter: 0 })
    execute.mockImplementation(async () => {
      order.push('insert')
      return { rows: [{ id: 'evt_1' }] }
    })
    applyEvent.mockImplementation(async () => {
      order.push('apply')
      return { outcome: 'granted' }
    })
    transaction.mockImplementation(async (run: (tx: typeof TX) => unknown) => {
      order.push('begin')
      return run(TX)
    })
    process.env[WEBHOOK_TOKEN_VAR] = TOKEN
  })

  function post(token: string | null = TOKEN, raw?: string) {
    return POST(
      new Request('https://x/api/asaas/webhook', {
        method: 'POST',
        headers: token === null ? {} : { [TOKEN_HEADER]: token },
        body: raw ?? JSON.stringify(EVENT),
      }),
    )
  }

  it('applies an authenticated event and answers 200 with a body', async () => {
    const response = await post()
    expect(response.status).toBe(200)
    // 200 **with a body**, never 204: Asaas records a 204 as a failed
    // delivery. Their FAQ and paused-queue page both say only 200 is success,
    // contradicting their own overview page's looser "2xx".
    expect(await response.json()).toEqual({ ok: true })
    expect(applyEvent).toHaveBeenCalledTimes(1)
  })

  it('stores the envelope first, and applies it inside the same transaction', async () => {
    /**
     * Both halves matter. The parked draft stored the body and *then* enqueued
     * a job: if the enqueue threw, the 500 made Asaas retry, the retry found
     * the row already stored, answered 200 and queued nothing — the event
     * persisted and never processed, with no sweep anywhere that would have
     * found it. One transaction makes the retry genuinely retry.
     */
    await post()
    expect(order).toEqual(['begin', 'insert', 'apply'])
    // The same executor, not the pool: that is what makes the rollback cover
    // the insert as well as the grant.
    expect(applyEvent.mock.calls[0]?.[1]).toBe(TX)
    const statement = JSON.stringify(execute.mock.calls[0]?.[0] ?? {})
    expect(statement).toContain('webhook_events')
    expect(statement).toContain('on conflict')
  })

  it('does nothing twice for a redelivered event id', async () => {
    execute.mockImplementation(async () => {
      order.push('insert')
      return { rows: [] }
    })
    const response = await post()
    expect(response.status).toBe(200)
    expect(applyEvent).not.toHaveBeenCalled()
  })

  it('answers 401 to a wrong token and never reaches the database', async () => {
    const response = await post('wrong')
    expect(response.status).toBe(401)
    expect(transaction).not.toHaveBeenCalled()
    expect(applyEvent).not.toHaveBeenCalled()
  })

  it('answers 503 while the token is unconfigured, rather than 200', async () => {
    delete process.env[WEBHOOK_TOKEN_VAR]
    const response = await post()
    // Answering 200 to an unauthenticated caller while the endpoint is open
    // would be worse than a paused queue.
    expect(response.status).toBe(503)
    expect(applyEvent).not.toHaveBeenCalled()
  })

  it('answers 200 to a body it cannot parse', async () => {
    const response = await post(TOKEN, 'not json at all')
    expect(response.status).toBe(200)
    expect(applyEvent).not.toHaveBeenCalled()
  })

  it('answers 200 to a body with no event id', async () => {
    const response = await post(TOKEN, JSON.stringify({ event: 'PAYMENT_CONFIRMED' }))
    expect(response.status).toBe(200)
    expect(applyEvent).not.toHaveBeenCalled()
  })

  it('measures the size ceiling in bytes, not in UTF-16 units', async () => {
    /**
     * `String.length` counts code units, so a body of multi-byte characters
     * passed a byte ceiling it had not met. It only ever under-rejected, but a
     * check should measure what it says it measures.
     */
    const padded = JSON.stringify({ id: 'e', event: 'X', pad: 'é'.repeat(150_000) })
    expect(padded.length).toBeLessThan(256 * 1024)
    expect(Buffer.byteLength(padded, 'utf8')).toBeGreaterThan(256 * 1024)
    const response = await post(TOKEN, padded)
    expect(response.status).toBe(200)
    expect(applyEvent).not.toHaveBeenCalled()
  })

  it('answers 500 only for our own transient failure', async () => {
    // The one case where Asaas retrying actually helps, and therefore the one
    // case where spending a strike is right.
    transaction.mockRejectedValue(Object.assign(new Error('boom'), { code: '08006' }))
    const response = await post()
    expect(response.status).toBe(500)
  })

  it('leaks no driver detail in the response', async () => {
    transaction.mockRejectedValue(
      Object.assign(new Error('relation "subscriptions" does not exist'), { code: '42P01' }),
    )
    const text = JSON.stringify(await (await post()).json())
    expect(text).not.toContain('subscriptions')
    expect(text).not.toContain('relation')
  })

  it('answers 429 with a retry-after when the flood guard trips', async () => {
    rateLimitRequest.mockResolvedValue({ ok: false, retryAfter: 30 })
    const response = await post()
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('30')
  })

  it('awaits the rate-limit decision', async () => {
    /**
     * **The defect this exists for.** The parked routes read
     * `rateLimitRequest(...)` without `await`, and the function is `async`, so
     * `decision.ok` was `undefined`, `!decision.ok` was true, and **every
     * request answered 429**. On this endpoint that is fifteen strikes and a
     * paused queue; on the subscribe path it was a button that never worked.
     * Neither route had a test, and nothing had ever run either of them.
     *
     * A promise is not `{ ok: true }`, so a missing `await` makes this red.
     */
    rateLimitRequest.mockResolvedValue({ ok: true, retryAfter: 0 })
    const response = await post()
    expect(response.status).toBe(200)
    expect(rateLimitRequest.mock.results[0]?.value).toBeInstanceOf(Promise)
  })

  it('never caches, and is never indexed', async () => {
    const response = await post()
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('x-robots-tag')).toContain('noindex')
  })

  it('answers 405 to a GET, because Asaas only ever POSTs', () => {
    expect(GET().status).toBe(405)
  })
})
