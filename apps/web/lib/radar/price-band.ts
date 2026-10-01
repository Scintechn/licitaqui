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
  /**
   * The awarded item's own description (E22).
   *
   * Optional because the band never needed it: five editais and a tight spread
   * were the argument. A thin rung has neither, so it shows this instead.
   */
  description?: string | null
  /**
   * Which edital it came from. Carried so the sample floor can count
   * **editais**, not rows — see {@link MIN_SAMPLE}.
   */
  tenderId: string
}

export type PriceBand = {
  /** 25th percentile of the comparables, in BRL. */
  low: number
  /** Median. What the copy calls the typical closing price. */
  median: number
  /** 75th percentile. */
  high: number
  /**
   * How many **distinct editais** the band rests on — not how many rows.
   *
   * The copy renders this as *"N editais encerrados"*, so it has to be that.
   * `awards` is keyed `(tender_id, item_number, sequence)` and one item
   * routinely carries several rows — lot splits, the ME/EPP quota, a
   * re-homologation — so 126 items in the corpus have more than one. Counting
   * rows would let a single procurement, on a single day, from a single órgão
   * clear a floor whose docstring claims it means five independent prices.
   */
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
 * One past result, as the thin rungs print it (E22).
 *
 * `description` is the awarded item's own words, and it is the whole point: at
 * one or two editais nothing checks the product-identity heuristic, so the
 * screen hands the reader what it matched instead of asserting that it matched
 * correctly.
 */
export type PriceSample = {
  tenderId: string
  /**
   * **A price somebody actually closed at** — never a statistic.
   *
   * This started as the median of the edital's own rows, which interpolates on
   * an even count: two lots at R$ 10 and R$ 20 printed *R$ 15,00*, a figure
   * nobody awarded, attributed to a `tenderId` where the reader can look it up
   * and not find it. {@link priceBand} may interpolate because it never prints
   * the intermediate; this rung is a citation, not a statistic, so it picks a
   * real row and shows that row's own words.
   */
  value: number
  description: string | null
}

/**
 * What a past winner is worth saying when there is not enough for a band.
 *
 * ## Why this exists
 *
 * Measured 2026-10-01 over 600 open items, after the awards backfill took the
 * priced corpus from 5 408 to 23 448: **11.17%** have at least one past winner
 * of the same product, 4.83% have two or more — and **0.67%** show a band.
 * {@link priceBand} returns `null` below {@link MIN_SAMPLE} and the count goes
 * with it, so the screen could not tell *"one winner"* from *"nothing"* and
 * said nothing to 94% of the items it had evidence for.
 *
 * ## What it may say, and what it may not
 *
 * Counts, the individual prices, and what each one was. **Never a median, a
 * quartile or a preço-alvo** — those belong to the band, and the band is
 * earned by five independent editais and a spread the gate checked. A single
 * result with a median drawn through it is a confident-looking number with
 * nothing behind it.
 *
 * ## There is deliberately no range
 *
 * A `{low, high}` over the matched editais was here and was removed on
 * 2026-10-01, for three independent reasons found in one review:
 *
 * 1. **Its extremes could be invisible.** `samples` is capped at
 *    {@link MAX_SAMPLES_SHOWN} and sorted newest-first, and an award with no
 *    date sorts last, so the row driving the low was routinely the one the cap
 *    dropped. A reader was shown *"R$ 1,00 – R$ 210,00 · 5 editais"* with the
 *    R$ 1,00 row absent from the list and of unknown age — a span they could
 *    not check, which is the shape this rung exists to avoid.
 * 2. **It inherited none of {@link MAX_SPREAD}.** `priceBand` refuses an
 *    incoherent sample outright; the range drew one anyway. A caderno at
 *    R$ 9,50 beside a notebook at R$ 3 000 produced a range rather than
 *    silence, which is exactly the wrong-product failure the product gate was
 *    added for.
 * 3. **It handed back the paid band.** Together with the four sampled values it
 *    reconstructed the whole per-edital set at five editais, and `priceBand`
 *    over that set returns the real `low`, `median` and `high` to the cent.
 *
 * The printed samples carry the span instead, where every number has an edital
 * and a description beside it. Anything the reader is told, they can check.
 *
 * ## Free at every rung
 *
 * Sci's ruling, 2026-10-01: **raw evidence free, computation paid**. The
 * matched results are public PNCP records of closed tenders; the band and the
 * preço-alvo are the work. Drawn that way the ladder is monotonic — the
 * alternative, free below five and locked at five, would show a non-subscriber
 * *less* at four editais than at three.
 */
export type PriceEvidence = {
  /** Distinct editais, counted the way {@link PriceBand.sampleSize} is. */
  editais: number
  /** One per edital, newest first, capped by {@link MAX_SAMPLES_SHOWN}. */
  samples: PriceSample[]
}

/**
 * How many matched results a thin rung prints.
 *
 * Four, because that is the most a rung below {@link MIN_SAMPLE} can hold, so
 * the cap never truncates the rungs it exists for. At or above the floor the
 * band speaks and this list is context rather than the argument.
 */
export const MAX_SAMPLES_SHOWN = 4

export function priceEvidence(
  comparables: readonly Comparable[],
  now = new Date(),
): PriceEvidence | null {
  const cutoff = new Date(now)
  cutoff.setMonth(cutoff.getMonth() - MAX_AGE_MONTHS)

  // The band's own freshness and sanity filter, so a price it refused cannot
  // reappear on a thinner rung with less around it to judge by.
  const fresh = comparables.filter(
    (c) =>
      (c.awardedOn === null || c.awardedOn >= cutoff) &&
      Number.isFinite(c.unitAwardedValue) &&
      c.unitAwardedValue > 0,
  )
  if (fresh.length === 0) return null

  // One price per edital. A registro de preços split into 40 lots is one
  // decision, and printing it 40 times would be this rung's version of the
  // defect `priceBand`'s own comment describes.
  const byEdital = new Map<string, { value: number; description: string | null; at: Date | null }[]>()
  for (const item of fresh) {
    const rows = byEdital.get(item.tenderId) ?? []
    rows.push({ value: item.unitAwardedValue, description: item.description ?? null, at: item.awardedOn })
    byEdital.set(item.tenderId, rows)
  }

  // **One real row stands for the edital, chosen rather than computed.**
  //
  // `priceBand` takes each edital's median and may interpolate, because it only
  // ever publishes the quartiles drawn across editais. Here the number is
  // printed beside a `tenderId` and a description, so an interpolated R$ 15,00
  // between lots of R$ 10 and R$ 20 would be a price nobody awarded, cited to
  // an edital that does not contain it — and `description` would come from a
  // third row. The lower-middle row by value is the same choice, made among
  // rows that exist.
  const perEdital = [...byEdital.entries()].map(([tenderId, rows]) => {
    const sorted = [...rows].sort((a, b) => a.value - b.value)
    const chosen = sorted[Math.floor((sorted.length - 1) / 2)]
    return {
      tenderId,
      value: chosen.value,
      // The chosen row's own words, so the description belongs to this price.
      description: chosen.description,
      at: rows.reduce<Date | null>((newest, r) => (r.at && (!newest || r.at > newest) ? r.at : newest), null),
    }
  })

  const samples = [...perEdital]
    // Newest first: the most recent closing is the most useful single data
    // point, and an edital with no date sorts last rather than first.
    .sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0))
    .slice(0, MAX_SAMPLES_SHOWN)
    .map(({ tenderId, value, description }) => ({ tenderId, value, description }))

  return { editais: perEdital.length, samples }
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

  const fresh = comparables.filter(
    (c) =>
      (c.awardedOn === null || c.awardedOn >= cutoff) &&
      Number.isFinite(c.unitAwardedValue) &&
      c.unitAwardedValue > 0,
  )

  // **One price per edital, not one per row**, and the quartiles are taken over
  // those. Counting editais for the floor while taking quartiles over rows was
  // the first version of this fix, and it was worse than the bug it replaced:
  // row duplication *compresses* the inter-quartile range, so the more one
  // edital dominated, the more likely the spread check was to pass. The gate
  // meant to catch an incoherent sample was disarmed by exactly the situation
  // the floor had just been taught to describe.
  //
  // Concretely: a registro de preços split into 40 lots at R$ 1,20, beside four
  // editais at R$ 2,40–2,60. Five editais clears the floor; p25, median and p75
  // are all 1,20; spread is zero; and the screen shows "R$ 1,20 – R$ 1,20 ·
  // 5 editais encerrados" while four of the five paid roughly double.
  //
  // The median of each edital's own rows, because one edital's lots are
  // repeated measurements of one decision — their middle is that decision.
  const byEdital = new Map<string, number[]>()
  for (const item of fresh) {
    const rows = byEdital.get(item.tenderId)
    if (rows) rows.push(item.unitAwardedValue)
    else byEdital.set(item.tenderId, [item.unitAwardedValue])
  }
  if (byEdital.size < MIN_SAMPLE) return null

  const values = [...byEdital.values()]
    .map((rows) => percentile([...rows].sort((a, b) => a - b), 0.5))
    .sort((a, b) => a - b)
  const editais = values.length

  const median = percentile(values, 0.5)
  if (median <= 0) return null

  const low = percentile(values, 0.25)
  const high = percentile(values, 0.75)
  if ((high - low) / median > MAX_SPREAD) return null

  return { low, median, high, sampleSize: editais }
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
