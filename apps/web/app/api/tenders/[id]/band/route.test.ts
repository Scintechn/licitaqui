import { describe, expect, it, vi } from 'vitest'

const comparablesForItem = vi.hoisted(() => vi.fn())
const rateLimitRequest = vi.hoisted(() => vi.fn(async () => ({ ok: true })))

vi.mock('@/lib/radar/comparables', () => ({ comparablesForItem }))
vi.mock('@/lib/rate-limit', () => ({ rateLimitRequest }))
vi.mock('@/lib/db', () => ({ db: () => ({}) }))

const readViewer = vi.hoisted(() => vi.fn(async () => null))
const planOf = vi.hoisted(() => vi.fn(() => 'essencial'))
vi.mock('@/lib/auth/viewer', () => ({ readViewer, planOf }))

const { GET } = await import('./route')

const ID = '45699626000176-1-000463/2026'

function call(id = ID, query = '?item=1') {
  return GET(new Request(`https://x/api/tenders/${id}/band${query}`), {
    params: Promise.resolve({ id }),
  })
}

/**
 * Identical prices from *different* editais: enough to clear the gate, tight
 * enough to pass it.
 *
 * The distinct `tenderId` matters. The first version of this helper gave every
 * comparable the same (absent) one, and once the gate started counting editais
 * rather than rows it correctly read six rows as a single procurement and
 * refused the band — the fixture, not the code, was wrong.
 */
function priced(count: number, value = 100) {
  return Array.from({ length: count }, (_unused, index) => ({
    unitAwardedValue: value,
    awardedOn: new Date(),
    tenderId: `9900000000000${index}-1-000001/2026`,
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

  it('answers locked — not empty — when the plan does not include the band', async () => {
    // **The distinction is the point.** `band: null` says no number exists for
    // anybody; `locked` says one does and this plan has not paid for it.
    // Collapsing them would tell a visitor the data is missing when the truth
    // is that the feature is sold, which is the inverse of E9's own complaint
    // that "a paying subscriber sees exactly what an anonymous visitor sees".
    comparablesForItem.mockResolvedValueOnce(priced(6))
    planOf.mockReturnValueOnce('basico')
    const response = await call()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.state).toBe('locked')
    expect(body.band).toBeUndefined()
  })

  it('says ready-empty, not locked, when there is no number to lock', () => {
    // **This assertion replaced one that required the defect.** The first
    // version returned `locked` before computing anything and the test pinned
    // that with `expect(comparablesForItem).not.toHaveBeenCalled()` — cheaper,
    // and false for ~99 of every 100 items, because both this contract and the
    // screen define locked as "a number exists and this plan does not include
    // it". A visitor would meet a paywall over nothing, pay, and find "ainda
    // sem dados de vencedores" behind it.
    return (async () => {
      comparablesForItem.mockResolvedValueOnce(priced(2))
      planOf.mockReturnValueOnce('basico')
      const body = await (await call()).json()

      expect(body.state).toBe('ready')
      expect(body.band).toBeNull()
      // **No `entitled` on the wire.** It rode here briefly, and the screen
      // drove its plan CTA off it — which put entitlement 412 ms behind a
      // trigram join and made the CTA flicker on every item chip and never
      // appear on a tender with no items. The screen now reads it on the
      // server before rendering, so this answer must not carry a second copy.
      expect(body).not.toHaveProperty('entitled')
    })()
  })

  it('never hands an unentitled caller the band itself', async () => {
    // Computing first must not leak: the figure is gone from the payload, not
    // merely hidden by the client.
    comparablesForItem.mockResolvedValueOnce(priced(6))
    planOf.mockReturnValueOnce('visitor')
    const body = await (await call()).json()

    expect(JSON.stringify(body)).not.toContain('100')
  })

  it.each(['visitor', 'basico'])('locks %s when a band exists', async (plan) => {
    comparablesForItem.mockClear()
    comparablesForItem.mockResolvedValueOnce(priced(6))
    planOf.mockReturnValueOnce(plan)
    expect((await (await call()).json()).state).toBe('locked')
  })

  it.each(['promocional', 'essencial', 'pro'])('serves %s', async (plan) => {
    comparablesForItem.mockClear()
    comparablesForItem.mockResolvedValueOnce(priced(6))
    planOf.mockReturnValueOnce(plan)
    // `promocional` is included because 0002 gives founders "same entitlements
    // as Essencial" — the whole of what they are buying on 08/10.
    const body = await (await call()).json()
    expect(body.state).toBe('ready')
    expect(body).not.toHaveProperty('entitled')
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
