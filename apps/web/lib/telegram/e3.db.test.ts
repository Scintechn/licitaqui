import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { POST as telegramWebhook } from '@/app/api/telegram/webhook/route'
import { rememberUserCnpj, setUserCnpj } from '@/lib/auth/session'
import { closeDb, db, pool } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import { resetRateLimits } from '@/lib/rate-limit'
import { linkPhase } from './handoff'
import { issueStartLink, readLinkStatus } from './link'
import { SECRET_HEADER } from './webhook'

/**
 * E3's two server-side facts, against the real database.
 *
 * E1's own suite (`e1.db.test.ts`) already drives the full `/start` path and is
 * left alone. What is new here is narrower and is exactly what the screen now
 * depends on:
 *
 *  1. **`pending`** — `telegram_links` can say "a token is outstanding", which
 *     is the state E1 could not distinguish from "never tried". No column was
 *     added for it; it is the two columns migration `0001` already has.
 *  2. **`setUserCnpj`** — the account setting overwrites, where
 *     `rememberUserCnpj` deliberately does not. The pair is tested together
 *     because the whole of task E3's third problem is the difference between
 *     them.
 *
 * Own `RUN_ID` per Vitest process, never a per-task constant (CLAUDE.md), and
 * every row is reachable from the run-scoped e-mail that `cleanup()` deletes
 * by. Skips without a database, so `pnpm test` stays green in CI.
 */

const url = testDatabaseUrl('TEST_DATABASE_URL_E1') ?? testDatabaseUrl()
const suite = url ? describe : describe.skip

const RUN_ID = randomUUID().replace(/-/g, '').slice(0, 8)
const RUN_NUMBER = Number.parseInt(RUN_ID, 16)

const EMAIL = (what: string) => `e3-${RUN_ID}-${what}@example.test`
/** Negative and far outside anything Telegram allocates — see `e1.db.test.ts`. */
const CHAT = (n: number) => -(910_000_000_000 + (RUN_NUMBER % 10_000_000) * 100 + n)

const WEBHOOK_SECRET = `e3-test-webhook-secret-${RUN_ID}`
const LINK_SECRET = `e3-test-link-secret-${RUN_ID}`

/**
 * Run-scoped CNPJs. `companies` is global and its rows outlive a user, so two
 * concurrent runs sharing a CNPJ would have one of them deleting a row the
 * other's `users.cnpj` still points at — a foreign-key error that looks like a
 * product bug. Fourteen digits is all the schema asks; the check digits belong
 * to `normaliseCnpj`, which is the action's guard and is tested where it lives.
 */
const CNPJ_PREFIX = String(RUN_NUMBER % 100_000_000).padStart(8, '0')
const CNPJ = (n: number) => `${CNPJ_PREFIX}${String(n).padStart(4, '0')}00`

const FIRST = CNPJ(1)
const SECOND = CNPJ(2)
/** Never inserted into `companies` by the test — only `setUserCnpj` may create it. */
const UNKNOWN = CNPJ(3)
/** Never inserted at all: what `rememberUserCnpj` must refuse to write. */
const NEVER_CACHED = CNPJ(4)

let updateId = 5_000_000

function post(body: unknown): Promise<Response> {
  return telegramWebhook(
    new Request('https://licitaquiapp.test/api/telegram/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: WEBHOOK_SECRET },
      body: JSON.stringify(body),
    }),
  )
}

function startUpdate(chatId: number, token: string) {
  updateId += 1
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: chatId, type: 'private' },
      text: `/start ${token}`,
    },
  }
}

async function makeUser(what: string, cnpj: string | null = null): Promise<number> {
  // `users.cnpj` references `companies.cnpj`, so a starting company has to
  // exist before it can be pointed at — which is the whole reason E3 needed
  // `ensureCompanyRow`.
  if (cnpj) await makeCompany(cnpj)
  const { rows } = await pool().query<{ id: string }>(
    `insert into users (email, name, cnpj, plan, delivery_state)
     values ($1, $2, $3, 'basico', 'SP')
     returning id`,
    [EMAIL(what), `Fulano ${what}`, cnpj],
  )
  return Number(rows[0].id)
}

/** A cached company, the way `company_lookup` leaves one. */
async function makeCompany(cnpj: string): Promise<void> {
  await pool().query(
    `insert into companies (cnpj, legal_name, main_cnae, updated_at)
     values ($1, 'Empresa de Teste', '4761003', now())
     on conflict (cnpj) do nothing`,
    [cnpj],
  )
}

async function companyRow(
  cnpj: string,
): Promise<{ legal_name: string | null; updated_at: Date } | null> {
  const { rows } = await pool().query<{ legal_name: string | null; updated_at: Date }>(
    `select legal_name, updated_at from companies where cnpj = $1`,
    [cnpj],
  )
  return rows[0] ?? null
}

async function cnpjOf(userId: number): Promise<string | null> {
  const found = await db().execute<{ cnpj: string | null }>(sql`
    select cnpj from users where id = ${userId}::bigint
  `)
  return found.rows[0]?.cnpj ?? null
}

async function cleanup() {
  const { rows } = await pool().query<{ id: string }>(
    `select id from users where email like $1`,
    [`e3-${RUN_ID}-%`],
  )
  const ids = rows.map((row) => row.id)
  if (ids.length > 0) {
    // `events.user_id` is `on delete set null`, not cascade.
    await pool().query(`delete from events where user_id = any($1::bigint[])`, [ids])
    await pool().query(
      `delete from jobs where kind = 'send_telegram'
         and (payload ->> 'userId') = any($1::text[])`,
      [ids],
    )
  }
  await pool().query(
    `delete from jobs where kind = 'send_telegram' and (payload ->> 'chatId')::bigint in
       (select generate_series($1::bigint, $2::bigint))`,
    [CHAT(40), CHAT(0)],
  )
  // `telegram_links` and `alerts` cascade from `users`.
  await pool().query(`delete from users where email like $1`, [`e3-${RUN_ID}-%`])
  // After the users, never before: `users.cnpj` references these.
  await pool().query(`delete from companies where cnpj like $1`, [`${CNPJ_PREFIX}%`])
}

suite('E3 · the linking journey (database)', () => {
  beforeAll(() => {
    process.env.DATABASE_URL = url
    process.env.DATABASE_POOL_MAX = '20'
    process.env.DATABASE_CONNECT_TIMEOUT_MS = '120000'
    process.env.DATABASE_QUERY_TIMEOUT_MS = '120000'
    process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET
    process.env.TELEGRAM_LINK_SECRET = LINK_SECRET
    // No `WORKER_URL`, so `wakeWorker()` returns before any I/O.
    delete process.env.WORKER_URL
  })

  beforeEach(async () => {
    resetRateLimits()
    await cleanup()
  })

  afterAll(async () => {
    await cleanup()
    await closeDb()
  }, 60_000)

  describe('the state E1 could not see', () => {
    it('is not pending before anyone presses anything', async () => {
      const userId = await makeUser('fresh')
      const status = await readLinkStatus(userId)
      expect(status).toMatchObject({ linked: false, pending: false })
    })

    it('is pending from the moment a token is issued', async () => {
      const userId = await makeUser('issued')
      await issueStartLink(userId)

      const status = await readLinkStatus(userId)
      expect(status.pending).toBe(true)
      expect(status.linked).toBe(false)

      // Which is the whole point: with the browser's cookie gone, the screen
      // now says "nothing came back" instead of offering a fresh "Conectar".
      expect(linkPhase({ ...status, handoffToken: null }).phase).toBe('failed')
    })

    it('stops being pending the moment the /start lands', async () => {
      const userId = await makeUser('spent')
      const { token } = await issueStartLink(userId)

      await post(startUpdate(CHAT(1), token))

      const status = await readLinkStatus(userId)
      expect(status).toMatchObject({ linked: true, pending: false })
      // A cookie left behind by the attempt that worked must not out-vote it.
      expect(linkPhase({ ...status, handoffToken: token }).phase).toBe('linked')
    })
  })

  describe('the company is no longer permanent', () => {
    it('rememberUserCnpj still refuses to overwrite — deliberately', async () => {
      const userId = await makeUser('remember', FIRST)
      await rememberUserCnpj(userId, SECOND)
      expect(await cnpjOf(userId)).toBe(FIRST)
    })

    it('setUserCnpj changes the company, which is what the setting is for', async () => {
      const userId = await makeUser('change', FIRST)
      await setUserCnpj(userId, SECOND)
      expect(await cnpjOf(userId)).toBe(SECOND)
    })

    it('sets a company nobody has ever looked up, and leaves it refreshable', async () => {
      // §3: no web request reads BrasilAPI. `users.cnpj` is a foreign key, so
      // the key goes in as a placeholder and `company_lookup` fills it. The
      // epoch stamp is what keeps it stale — a placeholder dated `now()` would
      // read as fresh and never be refilled.
      const userId = await makeUser('unknown-company')
      await setUserCnpj(userId, UNKNOWN)

      expect(await cnpjOf(userId)).toBe(UNKNOWN)
      const row = await companyRow(UNKNOWN)
      expect(row?.legal_name).toBe(null)
      expect(row?.updated_at.getTime()).toBe(0)

      // The same CNPJ through the Radar's path writes nothing at all, which is
      // exactly the gap that made the company permanent.
      const other = await makeUser('unknown-remember')
      await rememberUserCnpj(other, NEVER_CACHED)
      expect(await cnpjOf(other)).toBe(null)
    })

    it('never blanks a company that is already cached', async () => {
      await makeCompany(SECOND)
      const userId = await makeUser('keeps-cache')
      await setUserCnpj(userId, SECOND)
      expect((await companyRow(SECOND))?.legal_name).toBe('Empresa de Teste')
    })

    it('touches only the account it was given', async () => {
      const mine = await makeUser('mine', FIRST)
      const theirs = await makeUser('theirs', FIRST)
      await setUserCnpj(mine, SECOND)
      expect(await cnpjOf(theirs)).toBe(FIRST)
    })
  })
})
