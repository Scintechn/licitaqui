import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db, pool } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import { FEATURES, hasSpentOn, readLimit, spend } from './quota'

/**
 * `hasSpentOn` — the gate on `GET /api/tenders/:id/screening`.
 *
 * That route hands back an analysis without charging anything, because the
 * screen polls it every three seconds. The reason it is not a hole in §10 is
 * this predicate: an analysis is cached and **shared across users** (§3.2), so
 * the read is allowed only to a caller who already spent a screening on that
 * exact tender through the `POST`. Get this wrong and every visitor reads every
 * analysis in the database for free.
 *
 * Own database variable, own visitor per test, and every row scoped by a **per
 * run** id — never a per-task constant (CLAUDE.md). Skips with no database, so
 * `pnpm test` stays green in CI, which runs with no secrets.
 */

const url = testDatabaseUrl('TEST_DATABASE_URL_D4') ?? testDatabaseUrl()
const suite = url ? describe : describe.skip

const RUN_ID = randomUUID().replace(/-/g, '').slice(0, 8)
const TENDER_A = `tender-${RUN_ID}-a`
const TENDER_B = `tender-${RUN_ID}-b`

/** A visitor row of our own: `usage.visitor_id` references it. */
async function givenVisitor(): Promise<string> {
  const id = randomUUID()
  await pool().query('insert into visitors (id) values ($1::uuid)', [id])
  return id
}

const visitors: string[] = []

async function cleanup() {
  if (visitors.length === 0) return
  // `usage` cascades from `visitors`.
  await pool().query('delete from visitors where id = any($1::uuid[])', [visitors.splice(0)])
}

suite('hasSpentOn', () => {
  beforeAll(() => {
    process.env.DATABASE_URL = url
  })
  beforeEach(cleanup)
  afterAll(async () => {
    await cleanup()
    await closeDb()
  })

  async function newVisitor() {
    const id = await givenVisitor()
    visitors.push(id)
    return { visitorId: id } as const
  }

  it('is false before anything has been asked for', async () => {
    const spender = await newVisitor()
    const limit = await readLimit('visitor', FEATURES.screening, db())
    expect(await hasSpentOn(spender, limit, TENDER_A, db())).toBe(false)
  })

  it('is true for the tender that was paid for, and only that one', async () => {
    const spender = await newVisitor()
    const limit = await readLimit('visitor', FEATURES.screening, db())

    const outcome = await spend(spender, limit, TENDER_A, db())
    expect(outcome.charged).toBe(true)

    expect(await hasSpentOn(spender, limit, TENDER_A, db())).toBe(true)
    expect(await hasSpentOn(spender, limit, TENDER_B, db())).toBe(false)
  })

  it('does not leak one visitor’s screening to the next', async () => {
    const paid = await newVisitor()
    const other = await newVisitor()
    const limit = await readLimit('visitor', FEATURES.screening, db())

    await spend(paid, limit, TENDER_A, db())

    // The analysis is shared (§3.2); the right to read it is not.
    expect(await hasSpentOn(other, limit, TENDER_A, db())).toBe(false)
  })

  it('stays true on the second ask, which `spend` does not charge for', async () => {
    const spender = await newVisitor()
    const limit = await readLimit('visitor', FEATURES.screening, db())

    await spend(spender, limit, TENDER_A, db())
    const again = await spend(spender, limit, TENDER_A, db())

    expect(again.allowed).toBe(true)
    expect(again.charged).toBe(false)
    expect(again.quota.used).toBe(1)
    expect(await hasSpentOn(spender, limit, TENDER_A, db())).toBe(true)
  })

  it('is false for a tender the quota refused', async () => {
    const spender = await newVisitor()
    const limit = await readLimit('visitor', FEATURES.screening, db())
    // §10: the visitor gets two in total.
    expect(limit.quantity).toBe(2)

    await spend(spender, limit, `${TENDER_A}-1`, db())
    await spend(spender, limit, `${TENDER_A}-2`, db())
    const refused = await spend(spender, limit, TENDER_B, db())

    expect(refused.allowed).toBe(false)
    expect(await hasSpentOn(spender, limit, TENDER_B, db())).toBe(false)
  })
})
