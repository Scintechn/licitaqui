/**
 * The price band, and the rule that decides whether it may be shown at all.
 *
 * Sci, 2026-09-28: *"only show the information when we have more 90% of sure…
 * Im ok for items we dont have the correct information because we dont have
 * enough data to mathemacaly predict the information."*
 *
 * So the band is **conditional at the item level**. It is true wherever it
 * appears, because it only appears where the data carries it, and an item with
 * thin or scattered comparables shows nothing rather than a guess.
 *
 * ## This is a rule, not a probability
 *
 * Nothing here claims 90%, or any percentage. There is no model and no
 * back-test yet, so a confidence figure could only be asserted, and an
 * asserted confidence on a price a person will bid against is exactly the kind
 * of sentence `docs/CLAIMS.md` exists to collect. **C4** measures a real hit
 * rate — predict from awards that existed before a closed tender's award date,
 * compare to what actually won — and only then may a number reach a screen.
 * Until it does, the thresholds below are a stated rule and the copy says what
 * it is rather than how sure it is.
 *
 * ## Why these thresholds
 *
 * Measured 2026-09-28 over 200 random items on open editais: 7% reach three
 * comparables, 5% reach five, and **0.5% reach five with a tight spread**. So
 * these numbers are deliberately not tuned for coverage — tuning them down
 * would light up more screens with worse evidence, which is the failure this
 * card was reshaped to avoid. Coverage is raised by better comparables
 * (**C3**), not by a lower bar.
 */

/** One awarded item judged comparable to the item being priced. */
export type Comparable = {
  /** Unit price the winner actually closed at, in BRL. */
  unitAwardedValue: number
  /** When it was awarded, for the recency bound. */
  awardedOn: Date | null
}

export type PriceBand = {
  /** 25th percentile of the comparables, in BRL. */
  low: number
  /** Median. What the copy calls the typical closing price. */
  median: number
  /** 75th percentile. */
  high: number
  /** How many awarded items the band rests on. */
  sampleSize: number
}

/**
 * Minimum comparables before a band means anything.
 *
 * Five rather than three: at three, one outlier moves the median by a third,
 * and the median is the number a person multiplies by their quantity.
 */
export const MIN_SAMPLE = 5

/**
 * Maximum inter-quartile spread, as a fraction of the median.
 *
 * At 0.5 the middle half of the winners fall inside ±25% of the median. Wider
 * than that and the band stops being a useful answer to *"what should I bid"*
 * — it describes a market with no settled price, which is worth saying by
 * showing nothing rather than by drawing a bar four times too wide.
 */
export const MAX_SPREAD = 0.5

/**
 * How old an award may be and still count.
 *
 * Public prices move with the IPCA and with the contract cycle; a winner from
 * two years ago is evidence about a different market. 18 months keeps enough
 * volume to reach {@link MIN_SAMPLE} while excluding the clearly stale, and it
 * is the first threshold **C4** should re-tune once there is a hit rate to
 * tune against.
 */
export const MAX_AGE_MONTHS = 18

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 1) return sorted[0]
  const position = (sorted.length - 1) * fraction
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

/**
 * The band for one item, or `null` when the evidence does not support one.
 *
 * `null` is a first-class answer here and the caller must render **nothing** —
 * not a locked bar, not a placeholder, not "em breve". A locked bar tells a
 * person a number exists and is being withheld from them, which is false: for
 * these items no number exists at all.
 */
export function priceBand(comparables: readonly Comparable[], now = new Date()): PriceBand | null {
  const cutoff = new Date(now)
  cutoff.setMonth(cutoff.getMonth() - MAX_AGE_MONTHS)

  const values = comparables
    .filter((c) => c.awardedOn === null || c.awardedOn >= cutoff)
    .map((c) => c.unitAwardedValue)
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b)

  if (values.length < MIN_SAMPLE) return null

  const median = percentile(values, 0.5)
  if (median <= 0) return null

  const low = percentile(values, 0.25)
  const high = percentile(values, 0.75)
  if ((high - low) / median > MAX_SPREAD) return null

  return { low, median, high, sampleSize: values.length }
}

/**
 * The most a buyer can pay per unit and still keep `marginPct` of the sale.
 *
 * The band says what winners *charged the government*; this is the other
 * direction — what you may pay your own supplier. At a 20% margin, a unit that
 * closes at R$ 100 must be bought for at most R$ 80.
 *
 * Anchored on the **median**, not the high: pricing against the top of the
 * band assumes you will be the most expensive winner, which is the opposite of
 * how these are decided. Returns `null` for a margin outside 0–99%, because a
 * 100% margin implies a supplier cost of zero and a negative one is not a
 * question this answers.
 */
export function targetPurchasePrice(band: PriceBand, marginPct: number): number | null {
  if (!Number.isFinite(marginPct) || marginPct < 0 || marginPct >= 100) return null
  return band.median * (1 - marginPct / 100)
}
