import { describe, expect, it } from 'vitest'
import {
  MAX_AGE_MONTHS,
  MAX_SPREAD,
  MIN_SAMPLE,
  priceBand,
  priceEvidence,
  targetPurchasePrice,
  type Comparable,
} from './price-band'

const NOW = new Date('2026-09-28T12:00:00Z')

/** One award each, from a *different* edital — the ordinary case. */
function comparables(values: number[], awardedOn: Date | null = new Date('2026-06-01')): Comparable[] {
  return values.map((unitAwardedValue, index) => ({
    unitAwardedValue,
    awardedOn,
    tenderId: `9900000000000${index}-1-000001/2026`,
  }))
}

/** Several awards from the **same** edital — lot splits, quotas, re-homologation. */
function fromOneEdital(values: number[]): Comparable[] {
  return values.map((unitAwardedValue) => ({
    unitAwardedValue,
    awardedOn: new Date('2026-06-01'),
    tenderId: '99000000000001-1-000001/2026',
  }))
}

describe('priceBand', () => {
  it('is null below the sample floor, however tidy the numbers are', () => {
    // Four identical prices look like certainty and are not: four órgãos is
    // not a market. The floor is about evidence, not about spread, so a
    // perfect-looking sample still fails it.
    expect(priceBand(comparables([100, 100, 100, 100]), NOW)).toBeNull()
    expect(priceBand(comparables([100, 100, 100, 100, 100]), NOW)).not.toBeNull()
    expect(MIN_SAMPLE).toBe(5)
  })

  it('counts editais, not award rows', () => {
    // `awards` is keyed (tender_id, item_number, sequence) and one item
    // routinely carries several rows — lot splits, the ME/EPP quota, a
    // re-homologation. 126 items in the corpus have more than one.
    //
    // Five rows from one procurement is **one price wearing five hats**: one
    // órgão, one day, one decision. Counting rows would let it clear a floor
    // whose docstring claims five independent prices, and the copy beneath the
    // figure says "N editais encerrados" — so the number has to be editais.
    expect(priceBand(fromOneEdital([100, 100, 100, 100, 100]), NOW)).toBeNull()

    // The same five prices from five editais do pass, and report five.
    expect(priceBand(comparables([100, 100, 100, 100, 100]), NOW)?.sampleSize).toBe(5)
  })

  it('does not let one edital with many lots decide the price', () => {
    // **The scenario that survived the first fix.** A registro de preços split
    // into 40 lots at R$ 1,20, beside four editais that paid roughly double.
    //
    // Counting editais for the floor while taking quartiles over rows made the
    // spread check *more* likely to pass the more one edital dominated: forty
    // identical values put p25, median and p75 all at 1,20 and the spread at
    // zero. The screen would have read "R$ 1,20 – R$ 1,20 · 5 editais
    // encerrados" — literally true and materially false.
    const dominated = [
      ...Array.from({ length: 40 }, () => ({
        unitAwardedValue: 1.2,
        awardedOn: new Date('2026-06-01'),
        tenderId: '88000000000777-1-000001/2026',
      })),
      ...comparables([2.4, 2.5, 2.55, 2.6]),
    ]

    const band = priceBand(dominated, NOW)
    expect(band).not.toBeNull()
    // One price per edital: [1.20, 2.40, 2.50, 2.55, 2.60]. The median is a
    // real edital's price, not the loudest one's.
    expect(band?.sampleSize).toBe(5)
    expect(band?.median).toBe(2.5)
    expect(band?.low).toBeGreaterThan(1.2)
  })

  it('takes each edital’s own median when its lots disagree', () => {
    // Lots within one edital are repeated measurements of a single decision,
    // so their middle is that decision — not their first row, not their mean.
    const lots = [
      ...[10, 20, 30].map((unitAwardedValue) => ({
        unitAwardedValue,
        awardedOn: new Date('2026-06-01'),
        tenderId: '88000000000777-1-000001/2026',
      })),
      ...comparables([20, 20, 20, 20]),
    ]
    expect(priceBand(lots, NOW)?.median).toBe(20)
  })

  it('is null when the middle half of the winners disagree too much', () => {
    // A band four times too wide is not an answer to "what should I bid" — it
    // describes a market with no settled price, which is worth saying by
    // showing nothing.
    const scattered = priceBand(comparables([10, 20, 100, 400, 900, 2000]), NOW)
    expect(scattered).toBeNull()
  })

  it('returns the quartiles when the evidence holds', () => {
    const band = priceBand(comparables([80, 90, 100, 110, 120]), NOW)
    expect(band).not.toBeNull()
    expect(band?.median).toBe(100)
    expect(band?.low).toBe(90)
    expect(band?.high).toBe(110)
    expect(band?.sampleSize).toBe(5)
  })

  it('drops awards old enough to describe a different market', () => {
    const stale = new Date(NOW)
    stale.setMonth(stale.getMonth() - (MAX_AGE_MONTHS + 1))
    // Five stale + four fresh: the stale ones are excluded, so the survivors
    // fall below MIN_SAMPLE and the band refuses rather than quietly resting
    // on two-year-old prices.
    const mixed = [...comparables([100, 100, 100, 100, 100], stale), ...comparables([100, 100, 100, 100])]
    expect(priceBand(mixed, NOW)).toBeNull()

    const fresh = [...comparables([100, 100, 100, 100, 100], stale), ...comparables([100, 100, 100, 100, 100])]
    expect(priceBand(fresh, NOW)?.sampleSize).toBe(5)
  })

  it('keeps an award whose date is unknown rather than guessing it is old', () => {
    // `awarded_on` is nullable in the table. Dropping unknowns would discard
    // real evidence; treating them as stale would be inventing a date.
    expect(priceBand(comparables([100, 100, 100, 100, 100], null), NOW)?.sampleSize).toBe(5)
  })

  it('ignores zero and negative prices instead of letting them drag the median', () => {
    // A zero unit price is a data fault, not a free item, and it would pull
    // the 25th percentile to the floor and widen the spread past the gate —
    // failing the band for a reason that has nothing to do with the market.
    const withFaults = comparables([0, -5, 100, 100, 100, 100, 100])
    expect(priceBand(withFaults, NOW)?.sampleSize).toBe(5)
    expect(priceBand(withFaults, NOW)?.median).toBe(100)
  })

  it('accepts a spread exactly at the limit and refuses one past it', () => {
    // Median 100, IQR 50 → exactly MAX_SPREAD. The boundary is asserted
    // because "<=" versus "<" here is the difference between a band and none
    // on every item that sits on it.
    const atLimit = comparables([50, 75, 100, 125, 150])
    const band = priceBand(atLimit, NOW)
    expect(band).not.toBeNull()
    expect(band && (band.high - band.low) / band.median).toBeCloseTo(MAX_SPREAD, 10)

    expect(priceBand(comparables([40, 70, 100, 130, 160]), NOW)).toBeNull()
  })
})

describe('targetPurchasePrice', () => {
  it('answers what you may pay, not what winners charged', () => {
    const band = priceBand(comparables([80, 90, 100, 110, 120]), NOW)!
    // At a 20% margin a unit closing at R$ 100 must be bought for R$ 80.
    expect(targetPurchasePrice(band, 20)).toBeCloseTo(80, 10)
  })

  it('anchors on the median, never the top of the band', () => {
    // Pricing against `high` assumes you will be the most expensive winner,
    // which is the opposite of how these are decided.
    const band = priceBand(comparables([80, 90, 100, 110, 120]), NOW)!
    expect(targetPurchasePrice(band, 0)).toBe(band.median)
    expect(targetPurchasePrice(band, 0)).not.toBe(band.high)
  })

  it('refuses a margin that is not a margin', () => {
    const band = priceBand(comparables([100, 100, 100, 100, 100]), NOW)!
    expect(targetPurchasePrice(band, 100)).toBeNull()
    expect(targetPurchasePrice(band, -1)).toBeNull()
    expect(targetPurchasePrice(band, Number.NaN)).toBeNull()
  })
})

/**
 * E22 — the rungs below the band.
 *
 * Measured 2026-10-01 over 600 open items: 11.17% have at least one past
 * winner of the same product and 0.67% show a band, because everything under
 * `MIN_SAMPLE` was discarded along with its count. These assert what a thin
 * rung may say — and, more importantly, what it may not.
 */
describe('priceEvidence', () => {
  const at = (iso: string) => new Date(iso)
  const NOW = new Date('2026-10-01T00:00:00.000Z')
  const one = (
    tenderId: string,
    value: number,
    description: string | null = 'Perfurador Papel material: ferro fundido',
    awardedOn: Date | null = at('2026-06-01T00:00:00.000Z'),
  ): Comparable => ({ tenderId, unitAwardedValue: value, awardedOn, description })

  it('says nothing when there is nothing', () => {
    expect(priceEvidence([], NOW)).toBeNull()
  })

  /**
   * A low and a high drawn through one price reads as two sources agreeing,
   * and there is one.
   */
  it('shows a single result as a result, never as a range', () => {
    const found = priceEvidence([one('a', 204)], NOW)
    expect(found).toMatchObject({ editais: 1, range: null })
    expect(found?.samples).toHaveLength(1)
    expect(found?.samples[0].value).toBe(204)
  })

  it('carries what was matched, which is the point of a thin rung', () => {
    // Nothing checks the product-identity heuristic at one edital — no spread,
    // nothing to outvote a wrong match — so the screen hands the reader the
    // description instead of asserting the match was right.
    const found = priceEvidence(
      [one('a', 204, 'PERFURADOR DE PAPEL 02 FUROS AÇO FUNDIDO 100 FOLHAS')],
      NOW,
    )
    expect(found?.samples[0].description).toBe('PERFURADOR DE PAPEL 02 FUROS AÇO FUNDIDO 100 FOLHAS')
  })

  it('ranges across editais once there is more than one', () => {
    const found = priceEvidence([one('a', 204), one('b', 180), one('c', 230)], NOW)
    expect(found).toMatchObject({ editais: 3, range: { low: 180, high: 230 } })
  })

  /**
   * One edital's lots are one decision. Counting rows would let a registro de
   * preços split into 40 lots read as 40 agreeing sources — the defect
   * `priceBand`'s own comment describes, one rung down.
   */
  it('counts editais, never rows', () => {
    const lots = Array.from({ length: 40 }, () => one('a', 1.2))
    const found = priceEvidence([...lots, one('b', 2.4)], NOW)
    expect(found?.editais).toBe(2)
    expect(found?.samples).toHaveLength(2)
  })

  it('applies the band’s freshness rule, so nothing it refused appears here', () => {
    const stale = one('old', 999, 'antigo', at('2024-01-01T00:00:00.000Z'))
    const found = priceEvidence([stale, one('a', 204)], NOW)
    expect(found?.editais).toBe(1)
    expect(found?.samples[0].value).toBe(204)
  })

  it('refuses a value the band would refuse', () => {
    expect(priceEvidence([one('a', 0), one('b', -5)], NOW)).toBeNull()
  })

  it('shows the newest results first, and caps them', () => {
    const found = priceEvidence(
      [
        one('a', 1, 'um', at('2026-01-01T00:00:00.000Z')),
        one('b', 2, 'dois', at('2026-05-01T00:00:00.000Z')),
        one('c', 3, 'três', at('2026-09-01T00:00:00.000Z')),
        one('d', 4, 'quatro', at('2026-08-01T00:00:00.000Z')),
        one('e', 5, 'cinco', at('2026-07-01T00:00:00.000Z')),
      ],
      NOW,
    )
    expect(found?.editais).toBe(5)
    expect(found?.samples.map((s) => s.description)).toEqual(['três', 'quatro', 'cinco', 'dois'])
  })

  /**
   * The rung is **not** a weaker band. A median, a quartile or a preço-alvo is
   * earned by five independent editais and a spread the gate checked, and a
   * thin rung has neither.
   */
  it('exposes no median, quartile or target price', () => {
    const found = priceEvidence([one('a', 204), one('b', 180)], NOW) as unknown as Record<string, unknown>
    for (const forbidden of ['median', 'low', 'high', 'sampleSize', 'target']) {
      expect(Object.keys(found), forbidden).not.toContain(forbidden)
    }
  })

  /**
   * **Monotonic with the band**: anything the band accepts, the evidence also
   * describes. The ladder would be incoherent if a stronger rung existed where
   * a weaker one said nothing.
   */
  it('always has something to say wherever the band does', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((t, i) => one(t, 200 + i))
    expect(priceBand(five, NOW)).not.toBeNull()
    expect(priceEvidence(five, NOW)?.editais).toBe(5)
  })
})
