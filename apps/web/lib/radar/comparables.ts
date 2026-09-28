import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'
import type { Comparable } from './price-band'
import { canonicalUnitSql } from './unit'

/**
 * Awarded items comparable to one item of the tender on screen.
 *
 * "Comparable" is three conditions, and each one is doing work:
 *
 *   **same segment** — the coarse filter, and the only one an index can serve
 *   cheaply. It is never sufficient on its own: `Saúde / Hospitalar` holds
 *   1 524 awards covering everything from a syringe to an MRI.
 *
 *   **same canonical unit** — a price per litre and a price per unit are not
 *   the same number. Canonical, not raw: measured 2026-09-28 there are 4 405
 *   spellings and the *unidade* family alone is 57% of the corpus across
 *   eleven of them, so raw equality discards ~93% of real candidates. See
 *   `unit.ts`, which also explains which spellings it refuses to merge.
 *
 *   **similar description** — the one that decides coverage, and the one that
 *   is weakest. Two órgãos buying the same printer write it completely
 *   differently, so trigram similarity cuts ~574 same-segment candidates down
 *   to ~2. That is why only ~1% of items can be priced today, and why **C3**
 *   (a canonical product key) is the card that changes this number. `ncm`
 *   would settle it and is 7.4% populated, so it cannot be the key yet.
 *
 * ## Cost
 *
 * One query per item on the detail page, bounded by {@link MAX_COMPARABLES}.
 * The `%` operator uses `pg_trgm`'s index when one exists; **there is no
 * `gin (description gin_trgm_ops)` index on `tender_items` yet**, so today
 * this is a sequential scan over the segment+unit slice. That is acceptable
 * at the current award volume and will not stay acceptable — the index is a
 * schema change and therefore its own PR (CLAUDE.md), and belongs with C3,
 * which is what makes the join worth indexing.
 */

/**
 * Trigram similarity floor.
 *
 * 0.30 rather than the 0.45 first tried: at 0.45 the sampled coverage was
 * zero, because PNCP descriptions are long and specific and two spellings of
 * one product share few trigrams once both carry brand, capacity and
 * packaging. 0.30 recovers candidates without admitting different products —
 * and the band's own gate (`price-band.ts`) is what refuses a set that turns
 * out to be incoherent, so this threshold controls *recall* while the spread
 * check controls *correctness*.
 */
export const SIMILARITY_FLOOR = 0.3

/**
 * Never read more than this many comparables for one item.
 *
 * The band only needs a distribution, not a census, and an unbounded read
 * would let one broad segment turn a page render into a scan of thousands of
 * rows. Ordered by similarity so the cap keeps the *closest* matches rather
 * than an arbitrary slice — a cap that kept the worst matches would quietly
 * widen every band it touched.
 */
export const MAX_COMPARABLES = 200

type Row = {
  unit_awarded_value: string | null
  awarded_on: Date | string | null
  tender_id: string
}

/**
 * @param tenderId The tender whose item is being priced. **Excluded from its
 *   own comparables**: a tender that has somehow already been awarded must not
 *   help predict itself, which is the leak that would make C4's back-test
 *   meaningless and this number circular.
 */
export async function comparablesForItem(
  tenderId: string,
  itemNumber: number,
  executor?: Executor,
): Promise<Comparable[]> {
  const runner = executor ?? db()
  const unitJ = sql.raw(canonicalUnitSql('j.unit'))
  const unitS = sql.raw(canonicalUnitSql('s.unit'))

  const found = await runner.execute<Row>(sql`
    with subject as (
      select description, segment, unit
        from tender_items
       where tender_id = ${tenderId} and number = ${itemNumber}
    )
    select a.unit_awarded_value, a.awarded_on, j.tender_id
      from subject s
      join tender_items j
        on j.segment = s.segment
       and ${unitJ} = ${unitS}
       and j.tender_id <> ${tenderId}
      join awards a
        on a.tender_id = j.tender_id and a.item_number = j.number
     where a.unit_awarded_value > 0
       -- The project's own rule, and this query ignored it.
       -- worker/licitaqui/awards.py: "Only OK rows belong in a price band --
       -- that is POC 3's rule and it is why the column exists rather than the
       -- rows being dropped." Measured 2026-09-28: 745 of 6094 awards (12.2%)
       -- are not OK -- 655 out_of_range (unit or value errors, exactly the
       -- order-of-magnitude outliers a median must not see), 60 confidential,
       -- and 30 cancelled, which awards.py calls "not a price at any
       -- discount". Including them moved bands in both directions, silently.
       and a.quality = 'OK'
       and s.description is not null
       and j.description is not null
       and similarity(j.description, s.description) >= ${SIMILARITY_FLOOR}
     order by similarity(j.description, s.description) desc
     limit ${MAX_COMPARABLES}
  `)

  return found.rows.map((row) => ({
    unitAwardedValue: Number(row.unit_awarded_value),
    awardedOn: row.awarded_on === null ? null : new Date(row.awarded_on),
    tenderId: row.tender_id,
  }))
}
