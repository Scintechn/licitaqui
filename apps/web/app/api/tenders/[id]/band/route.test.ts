import { describe, expect, it, vi } from 'vitest'

const comparablesForItem = vi.hoisted(() => vi.fn())
const rateLimitRequest = vi.hoisted(() => vi.fn(async () => ({ ok: true })))

vi.mock('@/lib/radar/comparables', () => ({ comparablesForItem }))
vi.mock('@/lib/rate-limit', () => ({ rateLimitRequest }))
vi.mock('@/lib/db', () => ({ db: () => ({}) }))

const { GET } = await import('./route')

const ID = '45699626000176-1-000463/2026'

function call(id = ID, query = '?item=1') {
  return GET(new Request(`https://x/api/tenders/${id}/band${query}`), {
    params: Promise.resolve({ id }),
  })
}

/** Five identical prices: enough to clear the gate, tight enough to pass it. */
function priced(count: number, value = 100) {
  return Array.from({ length: count }, () => ({
    unitAwardedValue: value,
    awardedOn: new Date(),
  }))
}

describe('GET /api/tenders/:id/band', () => {
  it('answers ready with a band when the evidence clears the gate', async () => {
    comparablesForItem.mockResolvedValueOnce(priced(6))
    const body = await (await call()).json()

    expect(body.state).toBe('ready')
    expect(body.band.median).toBe(100)
    expect(body.band.sampleSize).toBe(6)
  })

  it('answers ready with null — not an error — when it does not', async () => {
    // **The normal case.** Measured 2026-09-28, roughly 1% of open items clear
    // the gate. A 404 or an error state here would make the client treat the
    // ordinary outcome as a failure and retry it, and would push the screen
    // into an error card for an item that is simply new.
    comparablesForItem.mockResolvedValueOnce(priced(2))
    const response = await call()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.state).toBe('ready')
    expect(body.band).toBeNull()
  })

  it('refuses an id that is not a PNCP control number', async () => {
    const response = await call('not-a-tender')
    expect(response.status).toBe(400)
    expect((await response.json()).fields.id).toBe('tenderIdInvalid')
    expect(comparablesForItem).not.toHaveBeenCalled()
  })

  it.each(['?item=0', '?item=-1', '?item=abc', ''])('refuses item %s', async (query) => {
    comparablesForItem.mockClear()
    const response = await call(ID, query)
    expect(response.status).toBe(400)
    expect((await response.json()).fields.item).toBe('itemInvalid')
    // Never reaches the database: an unparseable item would otherwise become
    // `NaN` in the query and scan for nothing at the cost of a full join.
    expect(comparablesForItem).not.toHaveBeenCalled()
  })

  it('does not leak the driver error when the read fails', async () => {
    comparablesForItem.mockRejectedValueOnce(Object.assign(new Error('relation x'), { code: '42P01' }))
    const response = await call()
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.error).toBe('server_error')
    expect(JSON.stringify(body)).not.toContain('relation x')
  })

  it('is rate limited like every other read', async () => {
    rateLimitRequest.mockResolvedValueOnce({ ok: false, retryAfter: 30 } as never)
    const response = await call()

    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('30')
  })

  it('never caches: a band changes as awards land', async () => {
    comparablesForItem.mockResolvedValueOnce(priced(6))
    const response = await call()
    expect(response.headers.get('cache-control')).toContain('no-store')
  })
})
