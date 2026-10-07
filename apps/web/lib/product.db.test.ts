import { sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import { STATED_LIMITS } from './product'

/**
 * **`plan_limits` must still hold what `docs/product.json` says we sell.**
 *
 * `product.test.ts` closes the copy side: no catalogue string types a quota by
 * hand, and the terms' entitlement table still carries the three phrases. What
 * it cannot do is look at the database — it is a file-reading test, and the
 * numbers are reference data in a table. This is that half.
 *
 * ## Why the numbers are not simply moved into code
 *
 * Because the spec forbids it, twice: `TECHNICAL_SPEC.md:302` calls
 * `plan_limits` *"configurable without a deploy"* and :475 says *"Numbers live
 * in `plan_limits`, not in code"*. Raising Básico from 5 to 8 is one `UPDATE`,
 * and `0002_plan_limits` says in its own header that the table is
 * *"deliberately editable at runtime"*. So this does not replace a `readLimit`
 * call with a constant and no route reads `docs/product.json`. The table stays
 * the authority; `product.json` is the **stated** value, and when the two
 * disagree one of them is a broken promise rather than a configuration.
 *
 * ## Which is why this failing is not automatically a bug in the table
 *
 * A red run here says *"the quota changed and the sentences did not"*. The fix
 * is a decision: either the change was deliberate — then `docs/product.json`
 * moves, `product.test.ts` goes red and names every stale sentence, and
 * somebody rewrites the copy and the terms' §5 table (legal brief §5: Sci
 * writes the clause, not us) — or it was accidental, and the row goes back.
 * Relaxing this test is neither.
 *
 * CDC art. 30 is what makes it that serious: an advertised feature binds the
 * supplier. *"5 triagens de edital por mês"* on `/planos` is an offer, not a
 * caption.
 *
 * ## What it asserts, and the two ways a weaker version would lie
 *
 *  - **The row exists.** `readLimit`'s documented rule is that a missing row
 *    means *"the plan does not include the feature"* — not "unlimited" — so a
 *    deleted row is a product change that a `quantity`-only comparison against
 *    `undefined` could read as a skip. `memory: empty-result-is-not-absence`.
 *  - **The period, not just the quantity.** `month` versus `total` is the
 *    difference between *"five a month"* and *"five for life"*, and D64 found
 *    exactly that mutation. A quantity without its period is half a fact,
 *    which is why `docs/product.json` stores both.
 *
 * Read by its own query rather than through `readLimit`, because the subject
 * here is **the rows**, not the reader: `readLimit` has its own tests, and
 * routing this through it would let a reader bug and a table change cancel
 * out. `(plan, feature)` is the primary key (`0002`'s `on conflict`), so one
 * row per pair is deterministic without an `order by`.
 */

/**
 * **The shared database, asked for by its own name.**
 *
 * The two sibling suites on this table (`plan-limits.db.test.ts`,
 * `keyword-limits.db.test.ts`) ask for `TEST_DATABASE_URL_B2` and fall back
 * silently, and a new file should not add a sixth instance of that: Sci decided
 * on 2026-10-07 that **there is one test database and the others are dropped**
 * (D63, B31), and that card's own acceptance says nothing in `apps/web` may
 * depend on a per-suite database surviving it.
 *
 * Safe here for a reason, not by luck: this suite **writes nothing**. It has no
 * fixtures, so it needs no `RUN_ID` scoping and cannot collide with a lane
 * running beside it. What it reads is reference data every suite in that
 * database shares — which is also why `entitlement.db.test.ts` inserting and
 * deleting `plan_limits` rows is named in D63 as the risk it is. If this suite
 * ever goes red for no reason anybody changed, that is the first thing to look
 * at, not this file.
 */
const url = testDatabaseUrl()
const suite = url ? describe : describe.skip
if (url) process.env.DATABASE_URL = url

afterAll(async () => {
  if (url) await closeDb()
})

type Row = { period: string | null; quantity: number | null }

/**
 * **Outside the database gate, deliberately.**
 *
 * This one assertion reads a file and nothing else, and the gate's whole
 * purpose is the fork pull request with no secrets — so leaving it inside
 * would skip the "a guard over an empty list is green for free" protection in
 * exactly the run where no other assertion in this file executes either.
 */
describe('the quotas the copy sells, as docs/product.json states them', () => {
  it('states exactly the rows the catalogue sweep knows how to check', () => {
    // **Exact equality, and that is the point.** `$planLimitsComment` requires
    // that a row added here is tokenised and swept in the same PR; this is what
    // makes that a rule rather than a wish. So a *new* row reddens this too —
    // the message says so, because the first thing D74 does is add one.
    expect(
      STATED_LIMITS.map(({ plan, feature }) => `${plan}/${feature}`).sort(),
      // Not written `'docs/product.json …'`: `ci-triggers.test.ts` reads a
      // quoted string that *starts* with `docs/` as a build dependency and
      // would take this whole sentence for a path (see D76).
      'planLimits changed. A row added needs a {$token}, a QUOTA_CLAIMS phrase ' +
        'and this list, in the same PR; a row removed needs its copy rewritten ' +
        'first. Either way the sweep in product.test.ts no longer matches it',
    ).toEqual(['basico/screening', 'visitor/days', 'visitor/screening'])
  })
})

suite('plan_limits · the quotas the copy sells', () => {
  it.each(STATED_LIMITS)(
    'holds $plan/$feature at $quantity per $period, as docs/product.json states',
    async ({ plan, feature, period, quantity }) => {
      const found = await db().execute<Row>(sql`
        select period, quantity from plan_limits
         where plan = ${plan} and feature = ${feature}
      `)

      expect(
        found.rows.length,
        `plan_limits has no ${plan}/${feature} row, and a missing row means the ` +
          'plan does not include the feature — but the copy still sells it',
      ).toBe(1)

      const row = found.rows[0]
      expect(
        row.quantity === null ? null : Number(row.quantity),
        `the copy sells ${plan}/${feature} = ${quantity}; plan_limits says ` +
          `${row.quantity}. Either docs/product.json and the sentences move, or ` +
          'the row does — see this file’s header.',
      ).toBe(quantity)
      expect(
        row.period,
        `${plan}/${feature} is sold "per ${period}" and the row says ` +
          `"${row.period}" — "5 a month" and "5 for life" are different promises`,
      ).toBe(period)
    },
  )
})
