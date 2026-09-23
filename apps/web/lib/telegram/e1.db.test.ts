import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { POST as telegramWebhook } from '@/app/api/telegram/webhook/route'
import { closeDb, db, pool } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import { resetRateLimits } from '@/lib/rate-limit'
import { issueStartLink, readLinkStatus, saveAlert, userForChat } from './link'
import { SECRET_HEADER } from './webhook'

/**
 * E1's linking flow, against the real database and the real route handler.
 *
 * The card's exit criterion is *"link in one tap from phone"*. A phone is a
 * person with a Telegram app, which no test has — but everything between the
 * tap and the confirmation is code, and all of it is driven here: the token is
 * minted the way the button mints it, the update is POSTed the way Telegram
 * POSTs it (secret header and all), and the assertions are on
 * `telegram_links`, `alerts`, `jobs` and `events` as they actually end up.
 *
 * ## The route, not the libraries
 *
 * Every case calls the exported `POST`, so the rate limiter, the constant-time
 * header check, the JSON parse, the update reader, the transaction and the job
 * enqueue all take part. A test of `linkChat()` alone would have missed the
 * redelivery case, which is the one that reads like a broken product.
 *
 * ## Isolation
 *
 * Own `RUN_ID` per Vitest process, never a per-task constant (CLAUDE.md), and
 * every row written here is reachable from the run-scoped e-mail or chat id
 * that `cleanup()` deletes by. No predicate in this file looks at an age, so
 * there is nothing for a cross-run sweep to get wrong.
 *
 * Skips without a database, so `pnpm test` stays green in CI.
 */

const url = testDatabaseUrl('TEST_DATABASE_URL_E1') ?? testDatabaseUrl()
const suite = url ? describe : describe.skip

const RUN_ID = randomUUID().replace(/-/g, '').slice(0, 8)
const RUN_NUMBER = Number.parseInt(RUN_ID, 16)

const EMAIL = (what: string) => `e1-${RUN_ID}-${what}@example.test`

/**
 * Chat ids far outside anything Telegram allocates to a person, and negative,
 * which Telegram reserves for groups — so one of these escaping into a real
 * `sendMessage` could not reach anybody. Run-scoped: `chat_id` is `unique`, and
 * two concurrent runs colliding on it would fail on the index.
 */
const CHAT = (n: number) => -(900_000_000_000 + (RUN_NUMBER % 10_000_000) * 100 + n)

const WEBHOOK_SECRET = `e1-test-webhook-secret-${RUN_ID}`
const LINK_SECRET = `e1-test-link-secret-${RUN_ID}`

/**
 * Telegram update ids, **run-scoped like everything else here**.
 *
 * This was a bare `let updateId = 1`, and it was the one thing in this file
 * that ignored the rule the docstring above states. The reply job's key is
 * `reply:<update_id>` and `jobs_dedupe` is a *shared* partial unique index, so
 * two runs of this suite both asking about update 2 do not collide on a row —
 * far worse, the second one **deduplicates against the first**, `queuedReply`
 * hands back the other run's payload, and the assertion fails against a chat
 * id it has never heard of. Exactly the failure CLAUDE.md describes: "a
 * task-scoped prefix looks isolated and is not".
 *
 * Each run gets its own thousand-wide band, and `cleanup()` deletes the band.
 * E3's suite takes the upper half of the same band so the two cannot meet.
 */
const UPDATE_ID_BASE = (RUN_NUMBER % 10_000_000) * 1_000
let updateId = UPDATE_ID_BASE

function post(body: unknown, secret: string = WEBHOOK_SECRET): Promise<Response> {
  return telegramWebhook(
    new Request('https://licitaquiapp.test/api/telegram/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: secret },
      body: JSON.stringify(body),
    }),
  )
}

/** What Telegram sends when someone taps `t.me/LicitaQuiBot?start=<token>`. */
function startUpdate(chatId: number, token?: string) {
  updateId += 1
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: chatId, type: 'private' },
      text: token ? `/start ${token}` : '/start',
    },
  }
}

function command(chatId: number, text: string) {
  updateId += 1
  return {
    update_id: updateId,
    message: { message_id: updateId, chat: { id: chatId, type: 'private' }, text },
  }
}

async function makeUser(what: string): Promise<number> {
  const { rows } = await pool().query<{ id: string }>(
    `insert into users (email, name, cnpj, plan, delivery_state)
     values ($1, $2, null, 'basico', 'SP')
     returning id`,
    [EMAIL(what), `Fulano ${what}`],
  )
  return Number(rows[0].id)
}

async function queuedReply(updateOfInterest: number): Promise<{
  kind: string
  payload: { template: string; user_id?: number; chat_id?: number }
  priority: number
} | null> {
  const { rows } = await pool().query<{
    kind: string
    payload: { template: string; user_id?: number; chat_id?: number }
    priority: number
  }>(`select kind, payload, priority from jobs where key = $1`, [`reply:${updateOfInterest}`])
  return rows[0] ?? null
}

async function cleanup() {
  const { rows } = await pool().query<{ id: string }>(
    `select id from users where email like $1`,
    [`e1-${RUN_ID}-%`],
  )
  const ids = rows.map((row) => row.id)
  if (ids.length > 0) {
    // `events.user_id` is `on delete set null`, not cascade.
    await pool().query(`delete from events where user_id = any($1::bigint[])`, [ids])
    await pool().query(
      `delete from jobs where kind = 'send_telegram'
         and (payload ->> 'user_id') = any($1::text[])`,
      [ids],
    )
  }
  await pool().query(
    `delete from jobs where kind = 'send_telegram' and (payload ->> 'chat_id')::bigint in
       (select generate_series($1::bigint, $2::bigint))`,
    [CHAT(40), CHAT(0)],
  )
  // By key as well as by payload. A reply enqueued for a template this suite
  // did not expect still holds `reply:<id>` in the shared dedupe index, and a
  // row left there poisons the *next* run rather than this one.
  await pool().query(
    `delete from jobs where kind = 'send_telegram'
       and key in (select 'reply:' || generate_series($1::bigint, $2::bigint))`,
    [UPDATE_ID_BASE, UPDATE_ID_BASE + 999],
  )
  // `telegram_links` and `alerts` cascade from `users`.
  await pool().query(`delete from users where email like $1`, [`e1-${RUN_ID}-%`])
}

suite('E1 · Telegram linking (database)', () => {
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

  // -- the gate -------------------------------------------------------------

  it('refuses a delivery with the wrong secret, and writes nothing', async () => {
    const userId = await makeUser('gate')
    const { url: link } = await issueStartLink(userId)
    const token = new URL(link).searchParams.get('start') as string

    const response = await post(startUpdate(CHAT(1), token), 'not-the-secret-at-all')

    expect(response.status).toBe(401)
    expect(await userForChat(CHAT(1))).toBeNull()
  }, 60_000)

  it('fails closed when no secret is configured', async () => {
    const saved = process.env.TELEGRAM_WEBHOOK_SECRET
    delete process.env.TELEGRAM_WEBHOOK_SECRET
    try {
      const response = await post(startUpdate(CHAT(2)), 'anything')
      expect(response.status).toBe(503)
    } finally {
      process.env.TELEGRAM_WEBHOOK_SECRET = saved
    }
  }, 60_000)

  it('answers a GET with 405 rather than doing anything', async () => {
    const { GET } = await import('@/app/api/telegram/webhook/route')
    expect(GET().status).toBe(405)
  }, 60_000)

  // -- the happy path -------------------------------------------------------

  it('links the chat, subscribes it, and queues the greeting', async () => {
    const userId = await makeUser('happy')
    const link = await issueStartLink(userId)

    // The deep link is what the button hands the phone.
    expect(link.url).toMatch(/^https:\/\/t\.me\/LicitaQuiBot\?start=[A-Za-z0-9_-]{1,64}$/)
    expect(link.expiresAt.getTime()).toBeGreaterThan(Date.now())

    const token = new URL(link.url).searchParams.get('start') as string
    const update = startUpdate(CHAT(3), token)
    const response = await post(update)

    expect(response.status).toBe(200)
    expect(await userForChat(CHAT(3))).toBe(userId)

    const status = await readLinkStatus(userId)
    expect(status).toMatchObject({ linked: true, active: true })
    // `ensureAlert` seeded the state from the account, so the first digest is
    // not "every open tender in Brazil".
    expect(status.states).toEqual(['SP'])

    const job = await queuedReply(update.update_id)
    expect(job).toMatchObject({
      kind: 'send_telegram',
      priority: 1,
      payload: { template: 'start-linked', user_id: userId },
    })
    // §12: the payload for a *linked* account carries no chat id — the worker
    // reads it from `telegram_links`.
    expect(job?.payload.chat_id).toBeUndefined()

    const events = await db().execute<{ name: string }>(sql`
      select name from events where user_id = ${userId}::bigint
    `)
    expect(events.rows.map((row) => row.name)).toContain('telegram_linked')
  }, 60_000)

  it('spends the token exactly once', async () => {
    const userId = await makeUser('once')
    const { url: link } = await issueStartLink(userId)
    const token = new URL(link).searchParams.get('start') as string

    await post(startUpdate(CHAT(4), token))

    // A different chat replaying the same token gets nothing.
    const replay = startUpdate(CHAT(5), token)
    await post(replay)

    expect(await userForChat(CHAT(5))).toBeNull()
    expect((await queuedReply(replay.update_id))?.payload).toMatchObject({
      template: 'start-token-invalid',
      chat_id: CHAT(5),
    })
  }, 60_000)

  it('greets the same person again rather than telling them the link is broken', async () => {
    // Telegram redelivers an update until it is acknowledged, and people tap
    // twice. Both arrive as a spent token from a chat that *is* connected.
    const userId = await makeUser('redeliver')
    const { url: link } = await issueStartLink(userId)
    const token = new URL(link).searchParams.get('start') as string

    await post(startUpdate(CHAT(6), token))
    const again = startUpdate(CHAT(6), token)
    await post(again)

    expect(await userForChat(CHAT(6))).toBe(userId)
    expect((await queuedReply(again.update_id))?.payload).toMatchObject({
      template: 'start-already-linked',
      user_id: userId,
    })
  }, 60_000)

  it('dedupes a redelivered update instead of queueing a second reply', async () => {
    const userId = await makeUser('dedupe')
    const { url: link } = await issueStartLink(userId)
    const token = new URL(link).searchParams.get('start') as string
    const update = startUpdate(CHAT(7), token)

    await post(update)
    await post(update) // byte-for-byte the same delivery

    const { rows } = await pool().query<{ n: string }>(
      `select count(*) as n from jobs where key = $1`,
      [`reply:${update.update_id}`],
    )
    expect(Number(rows[0].n)).toBe(1)
    void userId
  }, 60_000)

  it('moves a chat that changes accounts, and leaves the old one unlinked', async () => {
    const first = await makeUser('first')
    const second = await makeUser('second')

    const a = new URL((await issueStartLink(first)).url).searchParams.get('start') as string
    await post(startUpdate(CHAT(8), a))
    expect(await userForChat(CHAT(8))).toBe(first)

    const b = new URL((await issueStartLink(second)).url).searchParams.get('start') as string
    await post(startUpdate(CHAT(8), b))

    expect(await userForChat(CHAT(8))).toBe(second)
    expect((await readLinkStatus(first)).linked).toBe(false)
  }, 60_000)

  it('invalidates the previous link when a new one is issued', async () => {
    const userId = await makeUser('supersede')
    const stale = new URL((await issueStartLink(userId)).url).searchParams.get('start') as string
    await issueStartLink(userId) // the person tapped "Conectar" a second time

    const update = startUpdate(CHAT(9), stale)
    await post(update)

    expect(await userForChat(CHAT(9))).toBeNull()
    expect((await queuedReply(update.update_id))?.payload.template).toBe('start-token-invalid')
  }, 60_000)

  // -- the other commands ---------------------------------------------------

  it('answers a bare /start with the way to connect', async () => {
    const update = startUpdate(CHAT(10))
    await post(update)
    expect((await queuedReply(update.update_id))?.payload).toMatchObject({
      template: 'start-no-token',
      chat_id: CHAT(10),
    })
  }, 60_000)

  it('pauses the digest on /pausar without touching the account', async () => {
    const userId = await makeUser('pause')
    const token = new URL((await issueStartLink(userId)).url).searchParams.get('start') as string
    await post(startUpdate(CHAT(11), token))

    const stop = command(CHAT(11), '/pausar')
    await post(stop)

    const status = await readLinkStatus(userId)
    expect(status.active).toBe(false)
    // Still connected: `/pausar` stops the messages, it does not disconnect.
    expect(status.linked).toBe(true)
    expect((await queuedReply(stop.update_id))?.payload).toMatchObject({
      template: 'stop',
      user_id: userId,
    })
  }, 60_000)

  it('answers /ajuda to a stranger without an account', async () => {
    const help = command(CHAT(12), '/ajuda')
    await post(help)
    expect((await queuedReply(help.update_id))?.payload).toMatchObject({
      template: 'help',
      chat_id: CHAT(12),
    })
  }, 60_000)

  it('ignores conversation, and queues nothing', async () => {
    const chatter = command(CHAT(13), 'bom dia, tudo bem?')
    const response = await post(chatter)
    expect(response.status).toBe(200)
    expect(await queuedReply(chatter.update_id)).toBeNull()
  }, 60_000)

  // -- preferences ----------------------------------------------------------

  it('keeps the keyword and state the screen saved, and the pause with them', async () => {
    const userId = await makeUser('prefs')
    const token = new URL((await issueStartLink(userId)).url).searchParams.get('start') as string
    await post(startUpdate(CHAT(14), token))

    await post(command(CHAT(14), '/pausar'))
    await saveAlert(userId, { states: ['RJ'], keyword: 'material hospitalar' })

    const status = await readLinkStatus(userId)
    expect(status.states).toEqual(['RJ'])
    expect(status.keyword).toBe('material hospitalar')
    // Saving a filter is not the same gesture as resuming.
    expect(status.active).toBe(false)
  }, 60_000)
})
