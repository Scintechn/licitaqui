import { describe, expect, it, vi } from 'vitest'
import type { Comparable } from './price-band'

const comparablesForItem = vi.hoisted(() => vi.fn(async (): Promise<Comparable[]> => []))
vi.mock('./comparables', () => ({ comparablesForItem }))

const { fallbackEvidenceForItem } = await import('./fallback-evidence')
const { priceBand, priceEvidence, MIN_SAMPLE } = await import('./price-band')

/**
 * **The mechanism** half of D40's split (CLAUDE.md §4c).
 *
 * This file answers one question and answers it as code: *can the fallback
 * rung produce a band.* It cannot assert what a reader sees — `environment:
 * 'node'` has no boxes and runs no effects — so the screen half lives in
 * `price-view.test.tsx` and the path half in
 * `e2e/journeys/service-evidence.spec.ts`.
 *
 * The one check that matters is built so it **cannot pass for free**: the
 * comparables it feeds in are a set `priceBand()` demonstrably accepts, and
 * the test asserts that too. A fixture below `MIN_SAMPLE`, or too scattered,
 * would make "no band came out" true of any implementation — the shape
 * CLAUDE.md §4b calls an assertion that cannot fail.
 */

const AWARDED = new Date('2026-09-01T00:00:00Z')

/** One edital, one price, with words to read — the rung's own requirement. */
function one(tenderId: string, value: number, description: string | null = 'LICENCA DE USO'): Comparable {
  return { tenderId, unitAwardedValue: value, awardedOn: AWARDED, description }
}

/**
 * Eight editais within a few percent of each other: five clears `MIN_SAMPLE`
 * and the spread is nowhere near `MAX_SPREAD`, so `priceBand` returns a band
 * over exactly these rows. Asserted below rather than assumed.
 */
const BANDABLE = [
  one('a', 100),
  one('b', 101),
  one('c', 102),
  one('d', 103),
  one('e', 104),
  one('f', 105),
  one('g', 106),
  one('h', 107),
]

describe('fallbackEvidenceForItem', () => {
  it('is handed comparables that DO support a band, so the next check means something', () => {
    expect(BANDABLE.length).toBeGreaterThanOrEqual(MIN_SAMPLE)
    const band = priceBand(BANDABLE, AWARDED)
    expect(band).not.toBeNull()
    expect(band?.sampleSize).toBe(8)
  })

  it('returns evidence and no band — not even a field one could be written to', async () => {
    comparablesForItem.mockResolvedValueOnce(BANDABLE)
    const found = await fallbackEvidenceForItem('99000000000000-1-000001/2026', 1)

    expect(found).not.toBeNull()
    // **Asserted as the object's own shape**, not as a `toBeUndefined()` on a
    // field name — which would pass just as happily on a typo. Three keys,
    // these three, so adding `band`, `low`, `median` or `sampleSize` to this
    // rung fails here before it can reach a screen.
    expect(Object.keys(found!).sort()).toEqual(['editais', 'samples', 'source'])
    expect(found!.source).toBe('awards')
  })

  it('labels the corpus, because the copy that may be shown depends on it', async () => {
    comparablesForItem.mockResolvedValueOnce([one('a', 204)])
    const found = await fallbackEvidenceForItem('99000000000000-1-000001/2026', 1)
    // `catalogEvidenceForItem` answers `'catalog'`; mislabelling trigram
    // results as catalogue ones is what would put "do mesmo item" over a
    // same-area comparison.
    expect(found?.source).toBe('awards')
    expect(priceEvidence([one('a', 204)])!.source).toBe('awards')
  })

  it('drops a result with no description, because the row it would draw says "do mesmo item"', async () => {
    comparablesForItem.mockResolvedValueOnce([one('a', 204), one('b', 180, null), one('c', 190, '  ')])
    const found = await fallbackEvidenceForItem('99000000000000-1-000001/2026', 1)

    expect(found?.editais).toBe(1)
    expect(found?.samples.map((sample) => sample.tenderId)).toEqual(['a'])
  })

  it('answers null when nothing comparable survives, which is the ordinary case', async () => {
    comparablesForItem.mockResolvedValueOnce([])
    expect(await fallbackEvidenceForItem('99000000000000-1-000001/2026', 1)).toBeNull()

    comparablesForItem.mockResolvedValueOnce([one('a', 204, null)])
    expect(await fallbackEvidenceForItem('99000000000000-1-000001/2026', 2)).toBeNull()
  })

  it('passes the executor through, so it runs inside the route transaction', async () => {
    const executor = { marker: true } as never
    comparablesForItem.mockResolvedValueOnce([one('a', 204)])
    await fallbackEvidenceForItem('99000000000000-1-000001/2026', 7, executor)
    expect(comparablesForItem).toHaveBeenLastCalledWith('99000000000000-1-000001/2026', 7, executor)
  })
})
