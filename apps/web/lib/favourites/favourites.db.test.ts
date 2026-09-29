import { sql } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import { insertFixture, loadFixtures, RUN_AGENCY_CNPJ, RUN_ID } from '@/lib/radar/fixtures'
import {
  addFavourite,
  isFavourite,
  listFavourites,
  removeFavourite,
  toggleFavourite,
} from './store'

/**
 * Marking a tender, against a real Postgres — card **D23**.
 *
 * The behaviours here are the ones the schema promises and the ones a unit
 * test cannot check: idempotence comes from a primary key, the cascades come
 * from foreign keys, and ordering comes from an index. Asserting them against
 * a mock would assert the mock.
 *
 * ## Isolation
 *
 * Every row is scoped by `RUN_ID` through `fixtures.ts` — the tenders under a
 * per-run agency, the users under a per-run e-mail domain. Two concurrent runs
 * of this file cannot see each other's favourites, which matters because B22
 * now runs these suites in CI and B24 is the card for the two suites that
 * still cannot say that.
 */

const url = testDatabaseUrl('TEST_DATABASE_URL_D3') ?? testDatabaseUrl()
const suite = url ? describe : describe.skip
if (url) process.env.DATABASE_URL = url

const DOMAIN = `fav-${RUN_ID}.test.invalid`
const FIXTURES = loadFixtures().slice(0, 3)

async function makeUser(n: number): Promise<number> {
  const found = await db().execute<{ id: string }>(sql`
    insert into users (email) values (${`u${n}@${DOMAIN}`}) returning id
  `)
  return Number(found.rows[0].id)
}

async function cleanup() {
  await db().execute(sql`delete from users where email like ${`%@${DOMAIN}`}`)
  await db().execute(sql`delete from tenders where agency_cnpj = ${RUN_AGENCY_CNPJ}`)
}

suite('favourites (database)', () => {
  beforeEach(async () => {
    await cleanup()
    for (const fixture of FIXTURES) await insertFixture(db(), fixture)
  })

  afterAll(async () => {
    await cleanup()
    await closeDb()
  })

  it('marks a tender, and marking it again is the same fact', async () => {
    // The button is tapped twice by anybody on a slow connection. The
    // migration made `(user_id, tender_id)` the primary key precisely so the
    // second tap is not a second row and not an error the screen must explain.
    const user = await makeUser(1)
    const tender = FIXTURES[0].id

    await addFavourite(user, tender)
    await addFavourite(user, tender)

    expect(await listFavourites(user)).toHaveLength(1)
    expect(await isFavourite(user, tender)).toBe(true)
  })

  it('unmarks, and unmarking something unmarked is not an error', async () => {
    const user = await makeUser(2)
    const tender = FIXTURES[0].id

    await addFavourite(user, tender)
    await removeFavourite(user, tender)
    await removeFavourite(user, tender)

    expect(await listFavourites(user)).toHaveLength(0)
    expect(await isFavourite(user, tender)).toBe(false)
  })

  it('toggles in one statement, so two taps cannot both read "not marked"', async () => {
    // `delete … returning` is what makes this atomic. A read-then-write leaves
    // a window where both taps see "not marked", the second insert is a no-op,
    // and the button then says "Favoritar" on a tender that is marked.
    const user = await makeUser(3)
    const tender = FIXTURES[0].id

    expect(await toggleFavourite(user, tender)).toBe(true)
    expect(await isFavourite(user, tender)).toBe(true)
    expect(await toggleFavourite(user, tender)).toBe(false)
    expect(await isFavourite(user, tender)).toBe(false)
  })

  it('lists newest first, which is what the index is for', async () => {
    const user = await makeUser(4)
    for (const fixture of FIXTURES) await addFavourite(user, fixture.id)

    const listed = await listFavourites(user)
    expect(listed).toHaveLength(3)
    for (let i = 1; i < listed.length; i += 1) {
      expect(listed[i - 1].markedAt.getTime()).toBeGreaterThanOrEqual(listed[i].markedAt.getTime())
    }
  })

  it('never shows one person another person’s marks', async () => {
    const mine = await makeUser(5)
    const theirs = await makeUser(6)
    await addFavourite(mine, FIXTURES[0].id)
    await addFavourite(theirs, FIXTURES[1].id)

    expect((await listFavourites(mine)).map((f) => f.card.id)).toEqual([FIXTURES[0].id])
    expect(await isFavourite(mine, FIXTURES[1].id)).toBe(false)
  })

  it('carries what the card needs to render, not just an id', async () => {
    const user = await makeUser(7)
    await addFavourite(user, FIXTURES[0].id)

    const [one] = await listFavourites(user)
    expect(one.card.id).toBe(FIXTURES[0].id)
    expect(one.card.object.length).toBeGreaterThan(0)
    // The fields the Radar card draws, which the first version did not carry
    // and which is why the section "told nothing worthy".
    expect(one.card).toHaveProperty('shortTitle')
    expect(one.card).toHaveProperty('estimatedValue')
    expect(one.card).toHaveProperty('itemCount')
    expect(one.card).toHaveProperty('meEppSummary')
    // `proposalsCloseAt` may legitimately be null — four of the twenty
    // fixtures have no deadline — so this is about the type, not a value.
    expect(one.card.proposalsCloseAt === null || typeof one.card.proposalsCloseAt === 'string').toBe(
      true,
    )
  })

  it('loses the favourite when the tender goes, rather than rendering a ghost', async () => {
    // The migration cascades. A favourite pointing at a row that no longer
    // exists cannot be rendered, and a list that silently drops items is worse
    // than a count that went down.
    const user = await makeUser(8)
    await addFavourite(user, FIXTURES[0].id)
    await db().execute(sql`delete from tenders where id = ${FIXTURES[0].id}`)

    expect(await listFavourites(user)).toHaveLength(0)
  })

  it('loses them all when the account goes (LGPD art. 16)', async () => {
    const user = await makeUser(9)
    await addFavourite(user, FIXTURES[0].id)
    await db().execute(sql`delete from users where id = ${user}::bigint`)

    const left = await db().execute<{ n: string }>(sql`
      select count(*) as n from favourites where user_id = ${user}::bigint
    `)
    expect(Number(left.rows[0].n)).toBe(0)
  })
})
