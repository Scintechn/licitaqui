import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { GET as getTenders } from '@/app/api/radar/tenders/route'
import { SESSION_COOKIE } from '@/lib/auth/config'
import { addFavourite } from '@/lib/favourites/store'
import { closeDb, db } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import { resetRateLimits } from '@/lib/rate-limit'
import type { TenderListResponse } from './contract'
import { RUN_AGENCY_CNPJ, RUN_ID } from './fixtures'
import { listTenders, type CompanyMatch } from './tenders'

/**
 * `listTenders` reports which of the page's tenders the reader has marked —
 * card **D23**, against a real Postgres.
 *
 * ## Why this is a database test and not a unit one
 *
 * The claim is about **one read**. D23's store has no `countFavourites`
 * deliberately, because the nav badge and the list must come from the same
 * query; the list and its stars are that rule one level up. A mock would assert
 * the mock — what is worth asserting is that the `exists` projection lands on
 * the same rows the page returned, under the same `where`, from the same
 * statement, and that it is scoped to **this** account.
 *
 * ## Isolation
 *
 * Every row is scoped by `RUN_ID`: the tenders under `RUN_AGENCY_CNPJ`, the
 * users under a per-run e-mail domain, and the search token below is unique to
 * the run so the result set is provably these rows. Two concurrent runs of this
 * file cannot see each other (CLAUDE.md's per-run rule; a task-scoped prefix
 * would look isolated and not be).
 */

const url = testDatabaseUrl('TEST_DATABASE_URL_D3') ?? testDatabaseUrl()
const suite = url ? describe : describe.skip
if (url) process.env.DATABASE_URL = url

const DOMAIN = `favlist-${RUN_ID}.test.invalid`

/** A single lexeme, so `websearch_to_tsquery` keeps it intact. */
const TOKEN = `favoritolista${RUN_ID}`

/**
 * The object, and the only words in it are this run's own token.
 *
 * **Not a sentence, and the reason is a near miss rather than a bug that
 * happened.** The first version read *"Aquisição de <token> item N"*. A suite
 * elsewhere searches for `longestWord()` of one of its own fixtures with no CNPJ
 * and no limit — `radar.db.test.ts`'s *"finds an unmatched tender by keyword"* —
 * and a row whose object says *Aquisição* matches that query. These rows had the
 * earliest deadlines in the table, so they would have taken the first slots of
 * its twenty and pushed the tender it was looking for off the page.
 *
 * **It was not what made that test fail**, and the measurement is the only reason
 * this comment can say so: `radar.db.test.ts` resolves `TEST_DATABASE_URL_R1` and
 * this file resolves `_D3`, which on 2026-10-06 were **different databases** —
 * so these rows were never visible to it. What *was* visible: R1 held 162
 * run-scoped (`99…`) tenders with nothing running, 58 of them open, orphaned by
 * runs that were killed before their `afterAll`. That is the displacement, it is
 * older than this card, and it is O7 and B24's subject.
 *
 * The precaution stays, because the two variables resolving to one database is a
 * configuration away and `RUN_ID` cannot help here: scoping rows by run keeps two
 * runs of the *same* suite apart, and does nothing about two suites sharing
 * ordinary Portuguese in the one column that is searched across every run at
 * once. The deadlines below are far out for the same reason from the other side —
 * if these rows are ever matched by somebody else's query, they sort last.
 */
function objectFor(n: number): string {
  return `${TOKEN} ${TOKEN}${n}`
}

/** No segments: the search term is what reaches these rows, so the group is `keyword`. */
const MATCH: CompanyMatch = { compatible: [], check: [], fits: [] }

const COUNT = 5
const ids = Array.from(
  { length: COUNT },
  (_, index) => `${RUN_AGENCY_CNPJ}-1-${String(index + 1).padStart(6, '0')}/2026`,
)

async function makeUser(name: string): Promise<number> {
  const found = await db().execute<{ id: string }>(sql`
    insert into users (email) values (${`${name}@${DOMAIN}`}) returning id
  `)
  return Number(found.rows[0].id)
}

async function insertTenders(): Promise<void> {
  // Deadlines an hour apart, so the order the page comes back in is
  // unambiguous — and 300 days out, so these rows sort behind every real
  // fixture rather than ahead of them (see `objectFor`).
  const base = Date.now() + 300 * 24 * 60 * 60 * 1000
  for (const [index, id] of ids.entries()) {
    const closeAt = new Date(base + index * 3_600_000).toISOString()
    await db().execute(sql`
      insert into tenders (
        id, agency_cnpj, year, sequence, object, agency_name, city, state,
        modality_name, status, proposals_close_at, search
      ) values (
        ${id}, ${RUN_AGENCY_CNPJ}, 2026, ${index + 1},
        ${objectFor(index + 1)},
        'Prefeitura de Teste', 'Campinas', 'SP', 'Pregão eletrônico',
        'Divulgada no PNCP', ${closeAt}::timestamptz,
        to_tsvector('pt_unaccent', ${objectFor(index + 1)})
      )
      on conflict (id) do nothing
    `)
  }
}

async function cleanup(): Promise<void> {
  await db().execute(sql`delete from users where email like ${`%@${DOMAIN}`}`)
  await db().execute(sql`delete from tenders where agency_cnpj = ${RUN_AGENCY_CNPJ}`)
}

function page(viewerUserId: number | null, limit = COUNT) {
  return listTenders(MATCH, 'keyword', { q: TOKEN, limit }, db(), viewerUserId)
}

/**
 * One `suite` for the whole file, with the two claims as nested `describe`s.
 *
 * Not two top-level ones, and that is not tidiness: each had its own `afterAll`
 * calling `closeDb()`, and Vitest runs top-level `describe`s in order — so the
 * first block closed the pool and the second opened its fixtures against a
 * closed one. It passed on `db()` happening to rebuild the pool, which is
 * passing on an implementation detail of something else.
 */
suite('favourites on the Radar list (database)', () => {
  beforeAll(async () => {
    await cleanup()
    await insertTenders()
  })

  beforeEach(async () => {
    await db().execute(sql`delete from users where email like ${`%@${DOMAIN}`}`)
  })

  afterAll(async () => {
    await cleanup()
    await closeDb()
  })

  describe('listTenders', () => {
    it('names exactly the marked rows, and leaves the unmarked ones out', async () => {
      const user = await makeUser('reader')
      await addFavourite(user, ids[0])
      await addFavourite(user, ids[3])

      const answer = await page(user)

      expect(answer.tenders.map((row) => row.id)).toEqual(ids)
      expect([...answer.favourites].sort()).toEqual([ids[0], ids[3]].sort())
    })

    it('gives a visitor none, rather than an error or everyone’s', async () => {
      // A favourite is a row keyed on `users.id`. Somebody without an account has
      // none — which is the honest answer and not a 401: the `POST` is where the
      // refusal belongs, because that is the request with nowhere to put a row.
      const other = await makeUser('somebody-else')
      await addFavourite(other, ids[0])

      const answer = await page(null)

      expect(answer.tenders).toHaveLength(COUNT)
      expect(answer.favourites).toEqual([])
    })

    it('never shows one reader another reader’s marks', async () => {
      const mine = await makeUser('mine')
      const theirs = await makeUser('theirs')
      await addFavourite(mine, ids[1])
      await addFavourite(theirs, ids[2])

      expect((await page(mine)).favourites).toEqual([ids[1]])
      expect((await page(theirs)).favourites).toEqual([ids[2]])
    })

    it('is scoped to the page, not to the account', async () => {
      // The star is only ever drawn for a row that is on screen, and an id the
      // cards cannot match is an id the view would carry for nothing. A reader
      // with 200 favourites must not ship 200 ids with every page of 20.
      const user = await makeUser('pager')
      for (const id of ids) await addFavourite(user, id)

      const first = await page(user, 2)

      expect(first.tenders.map((row) => row.id)).toEqual([ids[0], ids[1]])
      expect(first.favourites).toEqual([ids[0], ids[1]])
      expect(first.nextCursor, 'there is a second page').not.toBeNull()
    })

    it('answers from one statement: unmarking is visible on the very next read', async () => {
      // Not a cache and not a second query that can lag: the projection is part of
      // the same `select` as the rows.
      const user = await makeUser('toggler')
      await addFavourite(user, ids[2])
      expect((await page(user)).favourites).toEqual([ids[2]])

      await db().execute(sql`
        delete from favourites where user_id = ${user}::bigint and tender_id = ${ids[2]}
      `)
      expect((await page(user)).favourites).toEqual([])
    })
  })

/**
 * The same claim through the route, because the data layer being right is not
 * evidence the path works (CLAUDE.md §4b).
 *
 * `GET /api/radar/tenders` never read an identity before this card — the cnpj
 * fallback came from `loadVisitor` — so "the route reads the viewer" is a new
 * sentence and the only test that can fail on it is one that signs in.
 */
async function signIn(name: string): Promise<{ userId: number; cookie: string }> {
  const userId = await makeUser(name)
  const token = randomUUID()
  await db().execute(sql`
    insert into sessions ("sessionToken", "userId", expires)
    values (${token}, ${userId}::bigint, now() + interval '30 days')
  `)
  return { userId, cookie: `${SESSION_COOKIE}=${token}` }
}

async function ask(cookie: string | null): Promise<TenderListResponse> {
  await resetRateLimits()
  const response = await getTenders(
    new Request(`http://localhost/api/radar/tenders?group=keyword&q=${TOKEN}&limit=${COUNT}`, {
      headers: cookie ? { cookie } : {},
    }),
  )
  return (await response.json()) as TenderListResponse
}

  describe('GET /api/radar/tenders · the envelope', () => {
    it('names the signed-in reader’s marks among the rows it returned', async () => {
      const { userId, cookie } = await signIn('route-reader')
      await addFavourite(userId, ids[1])

      const answer = await ask(cookie)

      expect(answer.state).toBe('ready')
      if (answer.state !== 'ready') return
      expect(answer.tenders.map((row) => row.id)).toEqual(ids)
      expect(answer.favourites).toEqual([ids[1]])
    })

    it('answers a visitor with an empty array rather than a 401', async () => {
      // Deliberately unlike `POST /api/tenders/:id/favorito`, which refuses: this
      // read has somewhere to put the answer, and §8's rule is that an account
      // adds capability rather than being a precondition for browsing.
      const { userId } = await signIn('somebody-with-marks')
      await addFavourite(userId, ids[0])

      const answer = await ask(null)

      expect(answer.state).toBe('ready')
      if (answer.state !== 'ready') return
      expect(answer.tenders).toHaveLength(COUNT)
      expect(answer.favourites).toEqual([])
    })
  })
})
