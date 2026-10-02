import { describe, expect, it, vi } from 'vitest'

const comparablesForItem = vi.hoisted(() => vi.fn())
const rateLimitRequest = vi.hoisted(() => vi.fn(async () => ({ ok: true })))

vi.mock('@/lib/radar/comparables', () => ({ comparablesForItem }))
vi.mock('@/lib/rate-limit', () => ({ rateLimitRequest }))
/**
 * `plan_limits`, as a table rather than as a stub of `hasPriceBand` (F5).
 *
 * The entitlement used to be a frozen list in `quota.ts`, so these tests only
 * had to drive `planOf`. It is a row now, and mocking `hasPriceBand` itself
 * would leave the thing under test — *does this plan include the band* —
 * asserted nowhere. So the database answers instead, from the same five rows
 * migration `0012` writes, and the real `readLimit` reads them.
 */
const PLAN_LIMITS: Record<string, { period: string | null; quantity: number | null }> = {
  visitor: { period: null, quantity: 0 },
  basico: { period: null, quantity: 0 },
  promocional: { period: null, quantity: null },
  essencial: { period: null, quantity: null },
  pro: { period: null, quantity: null },
}

vi.mock('@/lib/db', () => ({
  db: () => ({
    execute: async (query: { queryChunks?: unknown[] }) => {
      // The only statement this route runs through `db()` is `readLimit`'s.
      // `plan` is the first bound parameter; drizzle keeps them in order.
      const plan = JSON.stringify(query).match(/"(visitor|basico|promocional|essencial|pro)"/)?.[1]
      const row = plan === undefined ? undefined : PLAN_LIMITS[plan]
      return { rows: row === undefined ? [] : [row] }
    },
  }),
}))

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
    // Computing first must not leak: the figures are gone from the payload, not
    // merely hidden by the client.
    //
    // **This assertion was narrowed by E22, and the narrowing is a decision.**
    // It used to be `not.toContain('100')` over the whole payload — no price,
    // anywhere, for an unentitled caller. E22's ladder sends the matched
    // results at every rung (Sci, 2026-10-01: raw evidence free, computation
    // paid), so the raw value *does* appear now and that blanket assertion
    // would have to fail for the ladder to work at all.
    //
    // So the rule it pins is the one that still holds: the **computation** is
    // what Essencial buys. No median, no quartile, no sampleSize, no
    // preço-alvo. A visitor may see that six editais closed and at what — the
    // public record — and may not see the number drawn through them.
    comparablesForItem.mockResolvedValueOnce(priced(6))
    planOf.mockReturnValueOnce('visitor')
    const body = await (await call()).json()

    expect(body.state).toBe('locked')
    expect(body).not.toHaveProperty('band')
    // Asserted as **the exact key set, at both levels**. Two weaker versions
    // of this check were written first and neither could fail: a substring
    // search for `low`/`high` (which were the evidence range's own field names,
    // so it broke on a *correct* payload), and then a loop over `'median'`,
    // `'sampleSize'`, `'targetPurchasePrice'` — names the line above already
    // makes unreachable, so the loop asserted nothing. An exhaustive key set is
    // what constrains a future change, because anything added anywhere in this
    // payload has to come here and be justified.
    expect(Object.keys(body).sort()).toEqual(['evidence', 'state'])
    expect(Object.keys(body.evidence).sort()).toEqual(['editais', 'matched'])
  })

  it('sends no price at all once a band exists (the reconstruction)', async () => {
    // **Why the locked rung withholds values.** Sci, 2026-10-02. Four sampled
    // prices rebuild the band: over five sorted values the quartiles are
    // `sorted[1..3]`, so four give two figures exactly and bracket the third.
    // This fixture is the verified case — five editais, the oldest also the
    // cheapest — where `samples` plus a min/max returned the real low, median
    // and high to the cent.
    comparablesForItem.mockResolvedValueOnce([
      { unitAwardedValue: 100, awardedOn: new Date('2026-01-01'), tenderId: 'a-1-000001/2026' },
      { unitAwardedValue: 180, awardedOn: new Date('2026-09-01'), tenderId: 'b-1-000001/2026' },
      { unitAwardedValue: 190, awardedOn: new Date('2026-08-01'), tenderId: 'c-1-000001/2026' },
      { unitAwardedValue: 200, awardedOn: new Date('2026-07-01'), tenderId: 'd-1-000001/2026' },
      { unitAwardedValue: 210, awardedOn: new Date('2026-06-01'), tenderId: 'e-1-000001/2026' },
    ])
    planOf.mockReturnValueOnce('visitor')
    const body = await (await call()).json()
    const wire = JSON.stringify(body)

    expect(body.state).toBe('locked')
    // Not one of the five prices, nor the band they would rebuild.
    for (const leaked of ['100', '180', '190', '200', '210']) {
      expect(wire, `price ${leaked} on the wire`).not.toContain(leaked)
    }
    expect(body.evidence.editais).toBe(5)
    expect(body.evidence).not.toHaveProperty('samples')
  })

  it('still says how many editais and what was matched', async () => {
    // The half that stays free. The reader cannot otherwise check whether we
    // matched the right product, and at the top rung the spread gate has not
    // been shown to them either — so the descriptions are the one thing they
    // can judge, and they carry no price with them.
    comparablesForItem.mockResolvedValueOnce(
      [0, 1, 2, 3, 4, 5].map((i) => ({
        unitAwardedValue: 100,
        awardedOn: new Date(`2026-0${i + 1}-01`),
        tenderId: `9900000000000${i}-1-000001/2026`,
        description: i % 2 === 1 ? 'CANETA ESFEROGRAFICA AZUL' : 'CANETA ESFEROGRAF. AZUL CX 50',
      })),
    )
    planOf.mockReturnValueOnce('visitor')
    const body = await (await call()).json()

    expect(body.evidence.editais).toBe(6)
    // Deduplicated, and drawn from the same four newest samples an entitled
    // reader sees: six editais alternate two descriptions, so the four newest
    // carry both and the list is two lines, newest first. `matched.length` is
    // not a second count of editais — see `LockedEvidence`.
    expect(body.evidence.matched).toEqual([
      'CANETA ESFEROGRAFICA AZUL',
      'CANETA ESFEROGRAF. AZUL CX 50',
    ])
  })

  it('hands an unentitled caller the evidence — the ladder is free at every rung', async () => {
    // **The monotonicity the ladder rests on.** Withholding evidence behind the
    // gate would show a visitor the matched results at four editais and nothing
    // at five: crossing the threshold that makes the data *better* would make
    // the screen emptier. Sci's ruling, 2026-10-01.
    comparablesForItem.mockResolvedValueOnce(priced(6))
    planOf.mockReturnValueOnce('visitor')
    const body = await (await call()).json()

    expect(body.evidence.editais).toBe(6)
    // `priced()` carries no descriptions, so there is nothing to list — the
    // count is what survives. The description case is its own test below.
    expect(body.evidence.matched).toEqual([])
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
