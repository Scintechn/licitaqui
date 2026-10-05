import type { Executor } from '@/lib/db'
import { comparablesForItem } from './comparables'
import { priceEvidence, type PriceEvidence } from './price-band'

/**
 * The evidence rung for every item the Compras.gov.br catalogue cannot reach
 * (D40) — read from `awards` by the trigram path, and **never a band**.
 *
 * ## What B35 took away, measured
 *
 * B35 moved both rungs onto the catalogue. The band got better by every
 * measure — 56% hit and +0.2% bias against the trigram path's 14–31% and
 * −10% to −30% — but the *evidence* rung inherited the catalogue's two SQL
 * filters, `rule = 'exact'` and `kind = 'M'`, and an item that fails either
 * now shows nothing where it used to show past winners. That is not a thin
 * slice of the corpus. Measured on open items, 2026-10-05: `catalog_prices`
 * holds 907 129 rows and **not one `kind = 'S'`**, because
 * `refresh_catalog_prices` gives services no refresh budget at all; 15.0% of
 * mapped items are services; and among the mapped materials **143 506** are
 * `no_match` and **156 013** are `prefix`, none of them band-eligible, plus
 * **13 737** that *are* `rule = 'exact'` and have no recent `catalog_prices`
 * row behind the code. All of them blank.
 *
 * Sci, 2026-10-05: *"the application should present the data from previous won
 * tenders, for Services or Product."* So the fallback is not a services
 * exception — it is every item the catalogue has nothing for.
 *
 * ## Why this may show results and may never show a band
 *
 * Those are two different claims and only one of them is supportable.
 *
 * **The results are real.** They are winning prices from closed PNCP tenders
 * for the same segment, the same canonical unit, a similar description and —
 * since `product-key.ts` — the same product. `comparablesForItem` documents
 * each condition. **Not the same `kind`, though**, and this is the module whose
 * job is the services rung, so it should say so out loud: that query has no
 * `kind` predicate at all (checked, not assumed — there is none in its SQL), so
 * a service subject can match a material candidate wherever segment, canonical
 * unit, description similarity and `sameProduct` all agree. Pre-existing, four
 * filters deep, and defensible under *"da mesma área"* — but it is not what the
 * list above implies on its own. Adding the predicate would change the measured
 * coverage below, so it is **carded on D40 rather than slipped in unmeasured**. For a bespoke service an exact product match is *impossible*
 * — a software licence never matches the way a battery does — so a same-area
 * comparison is the only comparison available, and it does carry information
 * as long as the reader can see what was matched (which is D38's full
 * descriptions, beside every price).
 *
 * **A band over them would not be.** Across the 136 service items B35
 * back-tested, **zero** produced a band from any source, and the four results
 * on Sci's own screen ran **R$ 339,99 to R$ 6.363,00** — a 19× spread. p25–p75
 * over that is a confident-looking figure drawn through unlike things, which is
 * exactly what `MAX_SPREAD` exists to refuse and exactly what a reader would
 * multiply by their quantity. The trigram band's own back-test says the same
 * thing in the aggregate: it put the winner inside its own band 14–31% of the
 * time where ~50% is what a correct quartile band scores by construction.
 *
 * So the guarantee is structural rather than conditional. This function
 * returns {@link PriceEvidence}, a type with **no band field**, and never calls
 * `priceBand`; and the route only reaches it where `catalogBandForItem` has
 * already answered `null`, so a band and this rung cannot co-occur. Both halves
 * are asserted in `fallback-evidence.test.ts` and in the route's own test —
 * including the case where the comparables *would* have produced a band.
 *
 * ## This is the one deliberate `similarity()` exception
 *
 * B35's acceptance criterion — no `similarity()` on the band path — stands
 * unchanged: `catalog-band.ts` is still two primary-key reads and is still the
 * only thing that can produce a band. What does **not** stand is the other
 * half of that card, which planned to delete this path one release later as
 * dead code: it is the evidence rung now, and D40's card says so.
 *
 * What ships here is `similarity()` on the **evidence** path, scoped to items
 * with no catalogue match, because exact product identity is not obtainable
 * for those items by any route we have.
 *
 * It costs what it always cost: `comparablesForItem` is measured at a median
 * of **412 ms** and a worst case of **2 715 ms** (2026-09-28, 8 random open
 * items) — and **949 ms** on a re-measurement of 2026-10-02 that did not
 * reproduce the first, with Neon degraded at the time, so both figures carry
 * their condition rather than one being quoted as the number. There is still
 * no `gin (description gin_trgm_ops)` index on `tender_items`, and the route
 * computes evidence before the plan is consulted. That query is back for every
 * item the catalogue misses — the large majority — so **B21's index and caching
 * decision is now load-bearing again** rather than an optimisation.
 */
export async function fallbackEvidenceForItem(
  tenderId: string,
  itemNumber: number,
  executor?: Executor,
): Promise<PriceEvidence | null> {
  const comparables = await comparablesForItem(tenderId, itemNumber, executor)

  /**
   * **Every result on this rung carries the words it closed under.**
   *
   * `EvidenceRow` falls back to `radar.price.won` — *"Venceu em compras do
   * mesmo item"* — when a sample has no description, and on this rung that
   * sentence is false: the match is same-area, not same-item. The SQL already
   * requires `j.description is not null`, so this filter drops nothing today;
   * it is here so the claim is true by construction rather than by a predicate
   * in another file, and so a test can assert it as code.
   *
   * It is also the rung's whole argument. Nothing here has checked product
   * identity the way five editais and a spread gate would, so the reader is
   * handed what was matched instead of being told the match is right. A result
   * with nothing to read is a price with no way to judge it.
   */
  const describable = comparables.filter((row) => (row.description ?? '').trim() !== '')

  return priceEvidence(describable)
}
