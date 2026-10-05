import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'
import type { PriceBand } from './price-band'

/**
 * The price band, read from the Compras.gov.br catalogue (B35).
 *
 * ## Why this replaced the trigram path
 *
 * `comparablesForItem` matched an item's free-text description against the
 * `awards` table with `similarity()`, computed the quartiles per request, and
 * was **measured miscalibrated** on 2026-10-02: back-tested over 1 350 items
 * from closed tenders where the winning price is known, it put the winner
 * inside its own band **14–31 % of the time** (p = 0.001 / 0.002) and ran
 * 10–30 % low. A quartile band publishes p25–p75 of its own evidence, so if the
 * winning price were an exchangeable draw it would hold the middle half **by
 * construction** — ~50 % is what a *correct* band scores, and that is the
 * benchmark, not a target. The catalogue source scored **56 %** hit with
 * **+0.2 %** bias on the same items, statistically indistinguishable from
 * correct.
 *
 * So the band is no longer computed from text similarity at read time. It is
 * computed per catalogue code by the worker (`refresh_catalog_prices`) and
 * stored, and this module **reads one row by primary key**.
 *
 * ## The two filters, and why each is load-bearing
 *
 * **`rule = 'exact'`.** `tender_item_codes` records how an item was pointed at
 * a catalogue code, and only an exact head match is band-eligible — the
 * worker's `BAND_ELIGIBLE_RULES`. Prefix matches were measured **+18.6 %
 * biased**: they resolve more items and point a good share of them at the wrong
 * product, which is worse than showing nothing. Reading a prefix row here would
 * reintroduce that bias behind a correct-looking number.
 *
 * **`kind = 'M'`.** Services render nothing, by measurement rather than by
 * policy: across 136 service items, 22.4 % resolved to a CATSER code and
 * **zero** produced a band from any source. `kind = 'S'` is filtered in SQL so
 * a service item costs one index probe and returns null, rather than looking
 * like a band that happens to be missing.
 *
 * ## Why `order by window_end desc limit 1` is still a primary-key read
 *
 * The primary key is `(kind, code, window_end)`, so a code accumulates one row
 * per refresh window. The newest is the live one. The ordering is a backwards
 * walk of the same index — no scan, no `similarity()`, no per-item API call,
 * which is B35's acceptance criterion.
 *
 * ## A refusal is a row, and must not read as a band
 *
 * `catalog_bands` stores refusals: 947 of 1 028 codes are refused for
 * `spread_too_wide`, because the binding constraint is price coherence inside a
 * PDM rather than supply. The table's own `catalog_bands_band_xor_refusal`
 * constraint makes `low`/`median`/`high` null exactly when `refused_reason` is
 * set, so the `low is not null` test below cannot disagree with it. It is
 * stated in SQL anyway rather than inferred in TypeScript: a refusal reaching
 * this function as a band is the one failure that would be invisible on the
 * screen — a number drawn over evidence we rejected.
 */

/** What the screen needs, plus provenance for `/admin` and for tests. */
export type CatalogBandReading = {
  band: PriceBand
  /** The catalogue code the item was matched to, for support and debugging. */
  code: number
  /** The refresh window this band was computed for. */
  windowEnd: string
  /** `BAND_VERSION` from the worker, so a stale band is identifiable. */
  bandVersion: string
}

/**
 * One row, by primary key, or `null`.
 *
 * `null` is the **ordinary** answer and is not an error: the feature ships at
 * ~1.5–2 % of items. Every way of getting there is deliberately collapsed to
 * the same `null` — no code mapped, a non-exact rule, a service, no band row
 * yet, or a stored refusal — because the screen draws nothing in all five
 * cases and a caller that distinguished them would be tempted to say which,
 * which is a sentence nobody has approved.
 */
type Row = {
  code: number
  low: string
  median: string
  high: string
  n_purchases: number
  window_end: Date | string
  band_version: string
}

export async function catalogBandForItem(
  tenderId: string,
  itemNumber: number,
  executor?: Executor,
): Promise<CatalogBandReading | null> {
  const runner = executor ?? db()

  const found = await runner.execute<Row>(sql`
    select b.code,
           b.low,
           b.median,
           b.high,
           b.n_purchases,
           b.window_end,
           b.band_version
      from tender_item_codes c
      join catalog_bands b
        on b.kind = c.kind
       and b.code = c.code
     where c.tender_id = ${tenderId}
       and c.item_number = ${itemNumber}
       and c.rule = 'exact'
       and c.kind = 'M'
       and b.refused_reason is null
       and b.low is not null
     order by b.window_end desc
     limit 1
  `)

  const row = found.rows[0]
  if (row === undefined) return null

  return {
    band: {
      low: Number(row.low),
      median: Number(row.median),
      high: Number(row.high),
      sampleSize: row.n_purchases,
    },
    code: row.code,
    windowEnd: String(row.window_end instanceof Date ? isoDate(row.window_end) : row.window_end),
    bandVersion: row.band_version,
  }
}

/** `YYYY-MM-DD` in UTC — `window_end` is a `date`, and the database is UTC. */
function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10)
}
