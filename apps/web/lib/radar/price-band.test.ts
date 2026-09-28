import { describe, expect, it } from 'vitest'
import {
  MAX_AGE_MONTHS,
  MAX_SPREAD,
  MIN_SAMPLE,
  priceBand,
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
