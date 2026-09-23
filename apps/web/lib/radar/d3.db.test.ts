import { sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import { cleanupRun, insertFixture, loadFixtures, RUN_ID } from './fixtures'
import { openTenderStats } from './stats'
import { listTenders } from './tenders'

/**
 * The two pieces of SQL task D3 added, against a real Postgres.
 *
 * 1. `tenders.item_count` on a Radar card — the board's "7 itens", which the
 *    list query did not select before;
 * 2. `openTenderStats()` — the "Hoje no Brasil" strip on the Landing.
 *
 * `TEST_DATABASE_URL_D3` is this task's own isolated, migrated database. It is
 * resolved programmatically and never printed. Without it the file skips, so
 * `pnpm test` stays green on a machine with no database.
 *
 * ## Isolation
 *
 * Every row is written under `fixtures.ts`'s per-run agency, and the segment
 * label carries `RUN_ID`, so `listTenders` can be asked for **exactly this
 * run's tenders** and nothing else — no other run, and no seeded row, can
 * appear in the assertion. The counts, which are global by definition, are
 * taken inside one `repeatable read` transaction that is rolled back: the
 * snapshot is fixed at the first read, so a concurrent suite committing an
 * open tender between the two counts cannot change the delta.
 */

const url = testDatabaseUrl('TEST_DATABASE_URL_D3')
const suite = url ? describe : describe.skip
if (url) process.env.DATABASE_URL = url

/** Matches only this run's rows. Not a real POC 1 segment, and never committed. */
const SEGMENT = `Teste D3 ${RUN_ID}`

const ROLLBACK = new Error('rollback')

/**
 * Two disjoint slices of the 20 captured payloads. Disjoint on purpose: the
 * list test commits its rows, and `insertFixture` is `on conflict do nothing`,
 * so a fixture shared between the two suites would silently not be inserted
 * the second time and the count deltas below would measure nothing.
 */
const WITH_ITEMS = loadFixtures().filter((fixture) => fixture.items > 0)
const LIST_FIXTURES = WITH_ITEMS.slice(0, 3)
const STATS_FIXTURES = WITH_ITEMS.slice(3, 5)

afterAll(async () => {
  if (!url) return
  await cleanupRun(db())
  await closeDb()
})

suite('the Radar list carries an item count', () => {
  it('counts the items PNCP published for each tender on the page', async () => {
    const fixtures = LIST_FIXTURES
    expect(fixtures).toHaveLength(3)

    for (const fixture of fixtures) {
      await insertFixture(db(), fixture, { segments: [SEGMENT] })
    }

    const page = await listTenders(
      { compatible: [SEGMENT], check: [], fits: [] },
      'compatible',
      { includeClosed: true, limit: 50 },
      db(),
    )

    expect(page.tenders.map((tender) => tender.id).sort()).toEqual(
      fixtures.map((fixture) => fixture.id).sort(),
    )
    for (const fixture of fixtures) {
      const card = page.tenders.find((tender) => tender.id === fixture.id)
      expect(card?.itemCount).toBe(fixture.items)
    }
  })
})

suite('openTenderStats', () => {
  it('counts an open ME/EPP tender once in each figure, and a closed one in neither', async () => {
    const [openOne, closedOne] = STATS_FIXTURES

    await expect(
      db().transaction(
        async (tx) => {
          const before = await openTenderStats(tx)
          expect(before).not.toBeNull()

          await insertFixture(tx, openOne, { segments: [SEGMENT] })
          await insertFixture(tx, closedOne, { segments: [SEGMENT] })

          await tx.execute(sql`
            update tenders
               set proposals_close_at = now() + interval '30 days',
                   me_epp_summary = 'exclusive'
             where id = ${openOne.id}
          `)
          await tx.execute(sql`
            update tenders
               set proposals_close_at = now() - interval '30 days',
                   me_epp_summary = 'exclusive'
             where id = ${closedOne.id}
          `)

          const after = await openTenderStats(tx)
          expect(after).not.toBeNull()
          expect(after!.open).toBe(before!.open + 1)
          expect(after!.meEpp).toBe(before!.meEpp + 1)

          // An open tender with no ME/EPP benefit lifts only the first figure.
          await tx.execute(sql`
            update tenders set me_epp_summary = 'none' where id = ${openOne.id}
          `)
          const plain = await openTenderStats(tx)
          expect(plain!.open).toBe(before!.open + 1)
          expect(plain!.meEpp).toBe(before!.meEpp)

          throw ROLLBACK
        },
        { isolationLevel: 'repeatable read' },
      ),
    ).rejects.toBe(ROLLBACK)
  })

  /**
   * The 2026-09-23 correction. Before it, `open` counted every row whose
   * deadline was ahead, whatever the órgão had done to it — 204 of production's
   * 8 028 "editais abertos" were suspended, revoked or annulled.
   *
   * This fails against that version: the old query would have counted the
   * suspended tender in `open`, and had no `halted` to put it in.
   */
  it('a suspended tender with a future deadline is halted, not open', async () => {
    const [tender] = STATS_FIXTURES

    await expect(
      db().transaction(
        async (tx) => {
          await insertFixture(tx, tender, { segments: [SEGMENT] })
          await tx.execute(sql`
            update tenders
               set proposals_close_at = now() + interval '30 days',
                   me_epp_summary = 'exclusive',
                   status = 'Divulgada no PNCP'
             where id = ${tender.id}
          `)
          const open = await openTenderStats(tx)

          // The only change is the órgão's status. The date stays in the future.
          await tx.execute(sql`
            update tenders set status = 'Suspensa' where id = ${tender.id}
          `)
          const halted = await openTenderStats(tx)

          expect(halted!.open).toBe(open!.open - 1)
          expect(halted!.meEpp).toBe(open!.meEpp - 1)
          expect(halted!.halted).toBe(open!.halted + 1)

          // Revogada and Anulada land in the same figure; an unrecognised
          // value must never be counted as open (the `mayShowUrgency` rule).
          for (const status of ['Revogada', 'Anulada', 'Vai Saber']) {
            await tx.execute(sql`update tenders set status = ${status} where id = ${tender.id}`)
            const other = await openTenderStats(tx)
            expect(other!.open).toBe(open!.open - 1)
            expect(other!.halted).toBe(open!.halted + 1)
          }

          throw ROLLBACK
        },
        { isolationLevel: 'repeatable read' },
      ),
    ).rejects.toBe(ROLLBACK)
  })
})
