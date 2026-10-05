import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { catalogBandForItem as CatalogBand, catalogEvidenceForItem as CatalogEvidence } from '@/lib/radar/catalog-band'
import type { fallbackEvidenceForItem as FallbackEvidence } from '@/lib/radar/fallback-evidence'

/**
 * **Typed mocks, so the fixtures are checked too** (D40).
 *
 * These were `vi.fn(async () => null)`, which types the return as `null` — so
 * every fixture had to enter through `as never` and `tsc` could not see them at
 * all. D40 made `PriceEvidence.source` required precisely so the compiler would
 * force every producer to name its corpus, and in this file, which stands in
 * for both producers, it was forcing nothing: one fixture below had no `source`
 * field and compiled. Typing the mock is what makes that claim true here.
 */
const catalogBandForItem = vi.hoisted(() => vi.fn<typeof CatalogBand>(async () => null))
const catalogEvidenceForItem = vi.hoisted(() => vi.fn<typeof CatalogEvidence>(async () => null))
const fallbackEvidenceForItem = vi.hoisted(() => vi.fn<typeof FallbackEvidence>(async () => null))
const rateLimitRequest = vi.hoisted(() => vi.fn(async () => ({ ok: true })))

vi.mock('@/lib/radar/catalog-band', () => ({ catalogBandForItem, catalogEvidenceForItem }))
vi.mock('@/lib/radar/fallback-evidence', () => ({ fallbackEvidenceForItem }))
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
 * **The gate moved, so the fixtures moved with it** (B35).
 *
 * These tests used to hand the route comparables and let it compute a band,
 * which meant every one of them also exercised `priceBand`'s thresholds. The
 * band is computed by the worker and stored now, so the route's job is the
 * part these tests were always about: the **plan gate** — ready vs locked,
 * what a non-subscriber may see, and that the computation never leaks.
 *
 * `MIN_SAMPLE` and `MAX_SPREAD` are therefore not asserted here any more. They
 * are the worker's, pinned by its own conformance fixtures, and
 * `catalog-band.db.test.ts` pins that a refusal never reaches this route as a
 * band. Keeping them here would have meant a fixture that could not fail.
 */
function banded(sampleSize: number, value = 100) {
  return {
    band: { low: value, median: value, high: value, sampleSize },
    code: 123456,
    windowEnd: '2026-10-01',
    bandVersion: 'price-band-v1:test',
  }
}

/**
 * The evidence rung, as `catalogEvidenceForItem` returns it: the full count
 * plus at most `MAX_SAMPLES_SHOWN` newest rows. The cap is applied in SQL
 * there, so a fixture that returned more than four would be testing a payload
 * the database cannot produce.
 */
function seen(editais: number, value = 100, descriptions: (string | null)[] = []) {
  const shown = Math.min(editais, 4)
  return {
    editais,
    // D40: which corpus answered. `catalogEvidenceForItem` only ever says
    // `catalog`, and the screen's wording depends on it.
    source: 'catalog' as const,
    samples: Array.from({ length: shown }, (_unused, index) => ({
      tenderId: `9900000000000${index}`,
      value,
      description: descriptions[index] ?? null,
    })),
  }
}

describe('GET /api/tenders/:id/band', () => {
  it('answers ready with a band when the evidence clears the gate', async () => {
    catalogBandForItem.mockResolvedValueOnce(banded(6))
    catalogEvidenceForItem.mockResolvedValueOnce(seen(6))
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
    catalogBandForItem.mockResolvedValueOnce(null)
    catalogEvidenceForItem.mockResolvedValueOnce(seen(2))
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
    catalogBandForItem.mockResolvedValueOnce(banded(6))
    catalogEvidenceForItem.mockResolvedValueOnce(seen(6))
    planOf.mockReturnValueOnce('basico')
    const response = await call()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.state).toBe('locked')
    expect(body.band).toBeUndefined()
  })

  it('locks the prices, and still never paywalls an empty set', () => {
    // **This assertion replaced one that required the defect.** The first
    // version returned `locked` before computing anything and the test pinned
    // that with `expect(comparablesForItem).not.toHaveBeenCalled()` — cheaper,
    // and false for ~99 of every 100 items, because both this contract and the
    // screen define locked as "a number exists and this plan does not include
    // it". A visitor would meet a paywall over nothing, pay, and find "ainda
    // sem dados de vencedores" behind it.
    return (async () => {
      // **Sci, 2026-10-05: the prices are the paid thing.** Two comparables
      // with prices IS something to lock, so this case is now `locked` — the
      // reader gets the count and the descriptions and not the money. The
      // property the test was written to protect is unchanged and is asserted
      // below: a paywall must never be shown over an **empty** set.
      catalogBandForItem.mockResolvedValueOnce(null)
      catalogEvidenceForItem.mockResolvedValueOnce(seen(2))
      planOf.mockReturnValueOnce('basico')
      const body = await (await call()).json()

      expect(body.state).toBe('locked')
      expect(body).not.toHaveProperty('band')
      expect(body.evidence.editais).toBe(2)
      expect(JSON.stringify(body)).not.toContain('100')
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
    catalogBandForItem.mockResolvedValueOnce(banded(6))
    catalogEvidenceForItem.mockResolvedValueOnce(seen(6))
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
    catalogBandForItem.mockResolvedValueOnce(banded(5, 190))
    catalogEvidenceForItem.mockResolvedValueOnce({
      editais: 5,
      source: 'catalog',
      samples: [
        { tenderId: 'b', value: 180, description: null },
        { tenderId: 'c', value: 190, description: null },
        { tenderId: 'd', value: 200, description: null },
        { tenderId: 'e', value: 210, description: null },
      ],
    })
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
    catalogBandForItem.mockResolvedValueOnce(banded(6))
    catalogEvidenceForItem.mockResolvedValueOnce(
      seen(6, 100, [
        'CANETA ESFEROGRAFICA AZUL',
        'CANETA ESFEROGRAF. AZUL CX 50',
        'CANETA ESFEROGRAFICA AZUL',
        'CANETA ESFEROGRAF. AZUL CX 50',
      ]),
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
    catalogBandForItem.mockResolvedValueOnce(banded(6))
    catalogEvidenceForItem.mockResolvedValueOnce(seen(6))
    planOf.mockReturnValueOnce('visitor')
    const body = await (await call()).json()

    expect(body.evidence.editais).toBe(6)
    // `seen()` carries no descriptions, so there is nothing to list — the
    // count is what survives. The description case is its own test below.
    expect(body.evidence.matched).toEqual([])
  })

  it.each(['visitor', 'basico'])('locks %s when a band exists', async (plan) => {
    catalogBandForItem.mockClear()
    catalogBandForItem.mockResolvedValueOnce(banded(6))
    catalogEvidenceForItem.mockResolvedValueOnce(seen(6))
    planOf.mockReturnValueOnce(plan)
    expect((await (await call()).json()).state).toBe('locked')
  })

  it.each(['promocional', 'essencial', 'pro'])('serves %s', async (plan) => {
    catalogBandForItem.mockClear()
    catalogBandForItem.mockResolvedValueOnce(banded(6))
    catalogEvidenceForItem.mockResolvedValueOnce(seen(6))
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
    expect(catalogBandForItem).not.toHaveBeenCalled()
  })

  it.each(['?item=0', '?item=-1', '?item=abc', ''])('refuses item %s', async (query) => {
    catalogBandForItem.mockClear()
    const response = await call(ID, query)
    expect(response.status).toBe(400)
    expect((await response.json()).fields.item).toBe('itemInvalid')
    // Never reaches the database: an unparseable item would otherwise become
    // `NaN` in the query and scan for nothing at the cost of a full join.
    expect(catalogBandForItem).not.toHaveBeenCalled()
  })

  it('does not leak the driver error when the read fails', async () => {
    catalogBandForItem.mockRejectedValueOnce(
      Object.assign(new Error('relation x'), { code: '42P01' }) as never,
    )
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
    catalogBandForItem.mockResolvedValueOnce(banded(6))
    catalogEvidenceForItem.mockResolvedValueOnce(seen(6))
    const response = await call()
    expect(response.headers.get('cache-control')).toContain('no-store')
  })
})

/**
 * **D40 — the fallback rung, and that a band can never stand over it.**
 *
 * The card's single most important assertion is negative, and a negative
 * assertion is where §4b's "a test that cannot fail" hides. So each one here
 * arms the failure first: the catalogue mock is made to return a **real band**,
 * or the fallback mock a **real rung**, and the test then asserts the route
 * refused to combine them. Deleting the `band === null && catalogue === null`
 * guard in `route.ts` fails three of these.
 */
function fallback(editais: number, value = 339.99) {
  return {
    editais,
    source: 'awards' as const,
    samples: Array.from({ length: Math.min(editais, 4) }, (_unused, index) => ({
      tenderId: `9800000000000${index}`,
      value: value + index,
      description: `LICENCA DE USO DE SOFTWARE ${index}`,
    })),
  }
}

describe('GET /api/tenders/:id/band — the awards fallback (D40)', () => {
  beforeEach(() => {
    // **`mockReset`, not `mockClear`.** Several tests below prime a `once`
    // value the route is asserted *not* to consume, and `mockClear` leaves
    // that value queued — so the next test silently inherited the previous
    // one's rung and "stays silent when neither corpus has anything" failed
    // holding `editais: 8`. `mockReset` empties the queue and restores the
    // `vi.fn(async () => null)` implementation.
    catalogBandForItem.mockReset()
    catalogEvidenceForItem.mockReset()
    fallbackEvidenceForItem.mockReset()
    planOf.mockReset()
    planOf.mockReturnValue('essencial')
  })

  it('is consulted when the catalogue has neither a band nor prices', async () => {
    catalogBandForItem.mockResolvedValueOnce(null)
    catalogEvidenceForItem.mockResolvedValueOnce(null)
    fallbackEvidenceForItem.mockResolvedValueOnce(fallback(4))

    const body = await (await call()).json()

    expect(fallbackEvidenceForItem).toHaveBeenCalledWith(ID, 1, expect.anything())
    expect(body.state).toBe('ready')
    expect(body.evidence.editais).toBe(4)
    expect(body.evidence.source).toBe('awards')
    // The prices are on the wire, because raw evidence is free at every rung
    // (Sci, 2026-10-01) and here there is no band for them to reconstruct.
    expect(body.evidence.samples[0].value).toBeCloseTo(339.99)
  })

  it('gives an ENTITLED caller no band on the fallback rung — the card’s core claim', async () => {
    catalogBandForItem.mockResolvedValueOnce(null)
    catalogEvidenceForItem.mockResolvedValueOnce(null)
    // Eight editais, which is well past `MIN_SAMPLE`, so the rung is as rich as
    // this path ever gets. **The arming is not here**: `fallbackEvidenceForItem`
    // is mocked, so `priceBand` could not run either way. That the rung cannot
    // compute a band *even from a set `priceBand` accepts* is armed and asserted
    // in `fallback-evidence.test.ts`. What this test pins is the route: a rich
    // fallback rung, an entitled caller, and still no band on the wire.
    fallbackEvidenceForItem.mockResolvedValueOnce(fallback(8))
    planOf.mockReturnValue('essencial')

    const body = await (await call()).json()

    expect(body.state).toBe('ready')
    // `state: 'ready'` above already excludes `locked`, which is the other way
    // a band could be claimed to exist; asserting both would be one assertion
    // and one decoration (§4b).
    expect(body.band).toBeNull()
  })

  it('gives an UNENTITLED caller the descriptions and withholds the prices', async () => {
    // **Reversed by Sci on 2026-10-05**, one day after D40 shipped it. This
    // test asserted the opposite — that the fallback rung went out unnarrowed,
    // because `withoutPrices` existed to stop four prices rebuilding a band
    // and there is no band here to rebuild.
    //
    //   > "The description, ok, all plan can have access. But the price (Won)
    //   > must be hide."
    //
    // So the prices are the paid thing in their own right, not only as band
    // inputs. The descriptions stay free, which is what lets a reader judge
    // whether we matched the right product before paying — the argument that
    // kept the rung visible at all.
    catalogBandForItem.mockResolvedValueOnce(null)
    catalogEvidenceForItem.mockResolvedValueOnce(null)
    fallbackEvidenceForItem.mockResolvedValueOnce(fallback(8))
    planOf.mockReturnValue('visitor')

    const body = await (await call()).json()

    expect(body.state).toBe('locked')
    expect(body).not.toHaveProperty('band')
    expect(body.evidence.editais).toBe(8)
    // The descriptions survive; `LockedEvidence` has no price field at all, so
    // a leak here would be a compile error rather than this assertion.
    expect(body.evidence.matched.length).toBeGreaterThan(0)
    expect(body.evidence).not.toHaveProperty('samples')
  })

  it('is NOT consulted where a band exists, so the two corpora never mix', async () => {
    catalogBandForItem.mockResolvedValueOnce(banded(6))
    catalogEvidenceForItem.mockResolvedValueOnce(seen(6))
    fallbackEvidenceForItem.mockResolvedValueOnce(fallback(8))

    const body = await (await call()).json()

    expect(fallbackEvidenceForItem).not.toHaveBeenCalled()
    expect(body.evidence.source).toBe('catalog')
    expect(body.band.median).toBe(100)
  })

  it('is NOT consulted where the catalogue has prices but no band', async () => {
    /**
     * **The most common evidence state there is, and it had no test.**
     *
     * 947 of 1 028 catalogue codes are refused for `spread_too_wide` — the
     * purchases exist and disagree with each other — so by this card's own
     * census roughly **49 461** open materials have catalogue evidence and no
     * band (53 592 − 4 131). Mutating the guard to `band === null` alone left
     * the whole suite green, because the one test that reaches this state
     * (`answers ready with null — not an error`) asserts `state` and `band` and
     * never `evidence`. Under that regression the catalogue's real same-item
     * results would be silently replaced by same-area ones on all 49 461, and
     * `comparablesForItem` would run on every one of them.
     *
     * Found by the independent review of this diff, not by me.
     */
    catalogBandForItem.mockResolvedValueOnce(null)
    catalogEvidenceForItem.mockResolvedValueOnce(seen(6))
    fallbackEvidenceForItem.mockResolvedValueOnce(fallback(8))

    const body = await (await call()).json()

    expect(fallbackEvidenceForItem).not.toHaveBeenCalled()
    expect(body.state).toBe('ready')
    expect(body.band).toBeNull()
    expect(body.evidence.source).toBe('catalog')
    expect(body.evidence.editais).toBe(6)
  })

  it('is NOT consulted for a band whose catalogue prices aged out', async () => {
    // The one state where the guard does real work: `catalog_bands` holds a
    // band and `catalog_prices` has nothing inside `MAX_AGE_MONTHS`. Falling
    // back here would draw a catalogue band over trigram results — a number
    // and a list of sources that have nothing to do with each other, which no
    // reader could detect.
    catalogBandForItem.mockResolvedValueOnce(banded(6))
    catalogEvidenceForItem.mockResolvedValueOnce(null)
    fallbackEvidenceForItem.mockResolvedValueOnce(fallback(8))

    const body = await (await call()).json()

    expect(fallbackEvidenceForItem).not.toHaveBeenCalled()
    expect(body.state).toBe('ready')
    expect(body.evidence).toBeNull()
  })

  it('never narrows a fallback rung into a locked payload', async () => {
    // Locked requires a band, a band requires the catalogue, and the guard
    // means the fallback was never called — so `withoutPrices` cannot receive
    // trigram results. Armed: the fallback mock is primed with a full rung.
    catalogBandForItem.mockResolvedValueOnce(banded(6))
    catalogEvidenceForItem.mockResolvedValueOnce(null)
    fallbackEvidenceForItem.mockResolvedValueOnce(fallback(8))
    planOf.mockReturnValue('visitor')

    const body = await (await call()).json()

    expect(body.state).toBe('locked')
    // One assertion, not two: `evidence: null` already means no description
    // from the fallback rung reached the wire, so a `JSON.stringify` scan for
    // its text could not fail and would read as coverage (§4b).
    expect(body.evidence).toBeNull()
  })

  it('stays silent when neither corpus has anything', async () => {
    catalogBandForItem.mockResolvedValueOnce(null)
    catalogEvidenceForItem.mockResolvedValueOnce(null)
    fallbackEvidenceForItem.mockResolvedValueOnce(null)

    const body = await (await call()).json()

    expect(body.state).toBe('ready')
    expect(body.band).toBeNull()
    expect(body.evidence).toBeNull()
  })
})
