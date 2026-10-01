import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { closeDb, db } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import { RUN_ID } from './fixtures'
import { hasPriceBand } from './quota'

/**
 * F5's acceptance criterion, which is the only one a unit test cannot make:
 * *"changing which plans include the band requires no deploy, **demonstrated
 * by changing it**"*.
 *
 * So this changes it. One `update plan_limits`, no rebuild, no restart, and
 * the answer moves — which is the whole argument for the entitlement being a
 * row. Before F5 the same demonstration was impossible: `PRICE_BAND_PLANS` was
 * frozen in `quota.ts`, and the only way to change who got a band was a
 * deploy.
 *
 * Run-scoped plan names, never the real ones. Writing to `promocional` here
 * would be two concurrent runs of this file fighting over a row the whole
 * suite reads — the per-run isolation CLAUDE.md names — and worse, a failed
 * run could leave production's own seed values altered in the test database.
 */

const url = testDatabaseUrl('TEST_DATABASE_URL_R2') ?? testDatabaseUrl()
const suite = url ? describe : describe.skip

const INCLUDED = `plano-com-faixa-${RUN_ID}`
const EXCLUDED = `plano-sem-faixa-${RUN_ID}`
const UNLISTED = `plano-sem-linha-${RUN_ID}`

suite('the price band entitlement, as a row', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url
    await db().execute(sql`
      insert into plan_limits (plan, feature, period, quantity) values
        (${INCLUDED}, 'price_band', null, null),
        (${EXCLUDED}, 'price_band', null, 0)
      on conflict (plan, feature) do update set quantity = excluded.quantity`)
  })

  afterAll(async () => {
    await db().execute(sql`delete from plan_limits where plan like ${`%${RUN_ID}`}`)
    await closeDb()
  })

  it('reads the convention `plan_limits` already documents', async () => {
    // `null` is unlimited, `0` is "the plan does not include this" — the rule
    // `readLimit` and `Limit.quantity` have carried since 0002. A capability
    // needs no third value, because a band is not consumed.
    expect(await hasPriceBand(INCLUDED)).toBe(true)
    expect(await hasPriceBand(EXCLUDED)).toBe(false)
  })

  /**
   * **The criterion, demonstrated.** Two UPDATEs, in both directions, with no
   * deploy between them.
   */
  it('changes who gets a band with one UPDATE and no deploy', async () => {
    expect(await hasPriceBand(EXCLUDED)).toBe(false)

    await db().execute(sql`
      update plan_limits set quantity = null where plan = ${EXCLUDED} and feature = 'price_band'`)
    expect(await hasPriceBand(EXCLUDED), 'granted without a deploy').toBe(true)

    await db().execute(sql`
      update plan_limits set quantity = 0 where plan = ${EXCLUDED} and feature = 'price_band'`)
    expect(await hasPriceBand(EXCLUDED), 'and revoked the same way').toBe(false)
  })

  /**
   * A plan with no row at all answers `false` — but **that is `readLimit`'s
   * rule, not this function's**, and the two halves of the product do not
   * agree on it: the worker reads the same absence as *uncapped*
   * (`worker/licitaqui/telegram_alerts.py`), deliberately, because reading it
   * as zero would silence every founder on `promocional`.
   *
   * Migration `0012` therefore writes a row for **every** plan, so nothing in
   * production depends on which way F6 settles it.
   */
  it('does not depend on a missing row, which F6 has yet to settle', async () => {
    expect(await hasPriceBand(UNLISTED)).toBe(false)
  })

  /**
   * **The deployment order, as an assertion rather than as a sentence in a PR.**
   *
   * This code reads a row that migration `0012` writes, and the two ship in
   * separate PRs because CLAUDE.md requires a schema change to be its own. So
   * there is an order — migrate, then deploy — and the only thing that usually
   * carries it is somebody remembering.
   *
   * Here it is checked instead: once `0012` is applied, every real plan must
   * carry a `price_band` row, and until it is, there must be none. A half-
   * applied state — some plans seeded, some not — is the one shape that would
   * silently deny the band to a paying founder, and it fails here.
   */
  it('agrees with whether migration 0012 has been applied', async () => {
    const applied = await db().execute<{ n: number }>(sql`
      select count(*)::int as n from schema_migrations
       where version = '0012_price_band_entitlement'`)
    const seeded = await db().execute<{ plan: string }>(sql`
      select plan from plan_limits
       where feature = 'price_band' and plan not like ${`%${RUN_ID}`}
       order by plan`)
    const plans = seeded.rows.map((r) => r.plan)

    if (applied.rows[0].n === 0) {
      expect(plans, 'the code must not reach production before the migration').toEqual([])
      return
    }
    expect(plans).toEqual(['basico', 'essencial', 'pro', 'promocional', 'visitor'])
    // And the entitlement matches what `PRICE_BAND_PLANS` used to freeze.
    expect(await hasPriceBand('essencial')).toBe(true)
    expect(await hasPriceBand('promocional')).toBe(true)
    expect(await hasPriceBand('pro')).toBe(true)
    expect(await hasPriceBand('basico')).toBe(false)
    expect(await hasPriceBand('visitor')).toBe(false)
  })
})
