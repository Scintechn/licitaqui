import { sql, type SQL } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'
import { deepLink, type Env } from './config'
import { digestOf, mintToken } from './token'

/**
 * `telegram_links` and `alerts`: connecting a chat, pausing it, letting it go.
 *
 * Every statement here is raw SQL through Drizzle's `execute`, the way the rest
 * of the app reads the database, and every function takes a trailing
 * `Executor` so a route can hand it a transaction.
 *
 * ## The alert row is the subscription
 *
 * The schema already models this and E1 uses it as modelled rather than adding
 * anything: `telegram_links` says *where* to write, and one `alerts` row
 * (`channel = 'telegram'`, `frequency = 'weekly'`) says *whether* and *what*.
 * So `/pausar` is `active = false`, resuming is `active = true`, and the §10
 * entitlements — one keyword, one state — are columns on that row
 * (`value`, `states`) with the caps read from `plan_limits`.
 *
 * That is also why no migration is needed: the only thing missing from the
 * spec's `telegram_links` was somewhere to keep a token's expiry, and
 * `token.ts` puts it inside the token.
 *
 * ## LGPD (§12)
 *
 * A `chat_id` is personal data. It is written here and read by the worker, and
 * it is never logged, never returned to a browser and never put in an error.
 * `linkChat()` returns a `user_id`; the caller already knows which chat it is
 * talking to.
 */

/**
 * A `text[]` literal Postgres will accept.
 *
 * `sql`${['SP']}::text[]`` does **not** work: Drizzle flattens a JS array into
 * one parameter per element, so a one-element array arrives as the bare string
 * `SP` and Postgres answers `malformed array literal`. The same helper, for the
 * same reason, is in `lib/radar/tenders.ts`.
 */
function textArray(values: string[]): SQL {
  if (values.length === 0) return sql`array[]::text[]`
  return sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`
}

/** One Telegram chat belongs to one account, and vice versa. */
export type LinkStatus = {
  linked: boolean
  /** The weekly digest is switched on. False when `/pausar` has been used. */
  active: boolean
  /** §10: one keyword on Básico. `null` when the digest is CNAE-only. */
  keyword: string | null
  /** §10: one state on Básico. */
  states: string[]
}

export const UNLINKED: LinkStatus = { linked: false, active: false, keyword: null, states: [] }

export type IssuedLink = {
  /** `https://t.me/LicitaQuiBot?start=…`. One tap on a phone. */
  url: string
  expiresAt: Date
}

/**
 * Mint a `/start` token for this account and hand back the deep link.
 *
 * Writing the digest is an upsert on `user_id`, which is the primary key, so
 * **issuing a new token invalidates the previous one**: a person who taps
 * "Conectar o Telegram" twice cannot end up with two live links, and a link
 * left open in a tab from yesterday stops working the moment a fresh one is
 * made. The `chat_id` is deliberately left alone — someone re-linking an
 * already-connected account keeps receiving their digest until the new link is
 * actually used.
 */
export async function issueStartLink(
  userId: number,
  options: { env?: Env; now?: Date; database?: Executor } = {},
): Promise<IssuedLink> {
  const env = options.env ?? process.env
  const database = options.database ?? db()
  const minted = mintToken({ env, now: options.now })

  await database.execute(sql`
    insert into telegram_links (user_id, start_token)
    values (${userId}::bigint, ${minted.digest}::text)
    on conflict (user_id) do update set start_token = excluded.start_token
  `)

  return { url: deepLink(minted.token, env), expiresAt: minted.expiresAt }
}

export type LinkOutcome =
  /** The chat is now this account's. Reply with `telegram/start-linked`. */
  | { status: 'linked'; userId: number }
  /** This chat was already on this account. `telegram/start-already-linked`. */
  | { status: 'already_linked'; userId: number }
  /** Unknown, spent or superseded. `telegram/start-token-invalid`. */
  | { status: 'invalid' }

/**
 * Spend a token: attach `chatId` to whichever account issued it.
 *
 * Three cases, and the order matters.
 *
 * 1. **The token is outstanding.** One `update … where start_token = …`
 *    returning the user: setting `chat_id`, stamping `linked_at` and clearing
 *    `start_token` in the same statement is what makes the token single-use
 *    without a second round trip or a transaction.
 *
 * 2. **Nothing matched, but this chat is already linked to this account.**
 *    Telegram redelivers a webhook update until it is acknowledged, and people
 *    tap a link twice. Both arrive as a spent token, and answering "this link
 *    is no longer valid" to somebody who *is* connected is a bug that reads
 *    like a broken product. So the chat is looked up and answered honestly.
 *
 * 3. **Neither.** Genuinely invalid.
 *
 * ### The chat that already belongs to a different account
 *
 * `telegram_links.chat_id` is `unique`, so the update in case 1 would fail on
 * the index. It is not an error: the person is holding a valid token for
 * account B *and* controls the chat currently attached to account A, which is
 * everything anyone could ask before moving it. So the old row is detached
 * first and the chat follows the token. Nothing about account A changes except
 * that it stops having a Telegram chat — which is exactly what happened.
 *
 * The detach is a **separate statement**, not a data-modifying CTE: sub-queries
 * in a `WITH` run concurrently with the main query and "the actual order in
 * which updates are performed is unpredictable", so a CTE that frees the
 * unique index can race the update that needs it freed. Two statements in the
 * caller's transaction are ordered; one clever statement is not. Pass a
 * transaction — `POST /api/telegram/webhook` does.
 */
export async function linkChat(
  input: { digest: string; chatId: number },
  database: Executor = db(),
): Promise<LinkOutcome> {
  const { digest, chatId } = input

  // Who, if anyone, is holding this token. Asked first and on its own: the
  // detach below must not run for a token that turns out to be spent, or a
  // redelivered `/start` would disconnect the person it is greeting.
  const owner = await database.execute<{ user_id: string | number }>(sql`
    select user_id from telegram_links where start_token = ${digest}::text
  `)
  const target = owner.rows[0]

  if (target) {
    // Free the unique index, unless the row holding the chat is the very row
    // we are about to write (someone who re-issued a link and then used it).
    await database.execute(sql`
      update telegram_links
         set chat_id = null, linked_at = null
       where chat_id = ${chatId}::bigint
         and user_id <> ${target.user_id}::bigint
    `)
    const moved = await database.execute<{ user_id: string | number }>(sql`
      update telegram_links
         set chat_id = ${chatId}::bigint,
             linked_at = now(),
             start_token = null
       where start_token = ${digest}::text
      returning user_id
    `)
    const linked = moved.rows[0]
    if (linked) return { status: 'linked', userId: Number(linked.user_id) }
  }

  const existing = await database.execute<{ user_id: string | number }>(sql`
    select user_id from telegram_links
     where chat_id = ${chatId}::bigint and linked_at is not null
  `)
  const already = existing.rows[0]
  if (already) return { status: 'already_linked', userId: Number(already.user_id) }

  return { status: 'invalid' }
}

/** Which account a chat belongs to, or `null`. For `/ajuda` and `/pausar`. */
export async function userForChat(
  chatId: number,
  database: Executor = db(),
): Promise<number | null> {
  const found = await database.execute<{ user_id: string | number }>(sql`
    select user_id from telegram_links
     where chat_id = ${chatId}::bigint and linked_at is not null
  `)
  const row = found.rows[0]
  return row ? Number(row.user_id) : null
}

export async function readLinkStatus(
  userId: number,
  database: Executor = db(),
): Promise<LinkStatus> {
  const found = await database.execute<{
    linked: boolean
    active: boolean | null
    keyword: string | null
    states: string[] | null
  }>(sql`
    select tl.chat_id is not null and tl.linked_at is not null as linked,
           a.active, a.value as keyword, a.states
      from telegram_links tl
      left join alerts a
             on a.user_id = tl.user_id
            and a.channel = 'telegram'
            and a.frequency = 'weekly'
     where tl.user_id = ${userId}::bigint
     order by a.id
     limit 1
  `)
  const row = found.rows[0]
  if (!row) return UNLINKED
  return {
    linked: Boolean(row.linked),
    active: Boolean(row.active),
    keyword: row.keyword ?? null,
    states: row.states ?? [],
  }
}

/**
 * Create or update the one weekly Telegram alert for this account.
 *
 * `states` and `keyword` are already clamped by the caller against
 * `plan_limits` — this is the write, not the policy. It is an upsert in effect
 * rather than in SQL, because `alerts` has no unique index on
 * `(user_id, channel, frequency)` and adding one is a migration.
 */
export async function saveAlert(
  userId: number,
  preferences: { states: string[]; keyword: string | null },
  database: Executor = db(),
): Promise<void> {
  const { states, keyword } = preferences
  // `active` is deliberately untouched. Saving a keyword is not the same
  // gesture as resuming a paused digest, and silently un-pausing somebody who
  // typed `/pausar` an hour ago is the kind of "helpful" that loses trust.
  const updated = await database.execute<{ id: string | number }>(sql`
    update alerts
       set states = ${textArray(states)},
           value = ${keyword}::text,
           kind = ${keyword ? 'keyword' : 'cnae'}::text
     where user_id = ${userId}::bigint
       and channel = 'telegram'
       and frequency = 'weekly'
    returning id
  `)
  if (updated.rows.length > 0) return

  await database.execute(sql`
    insert into alerts (user_id, kind, value, states, channel, frequency, active)
    values (${userId}::bigint, ${keyword ? 'keyword' : 'cnae'}::text, ${keyword}::text,
            ${textArray(states)}, 'telegram', 'weekly', true)
  `)
}

/**
 * Make sure a linked account has something to deliver, without overwriting
 * what they chose.
 *
 * `/conta/alertas` writes the real preferences when the person connects, so
 * this is the safety net for the orders in which that does not happen — a row
 * deleted by hand, a link made from an older deploy. The default state is the
 * one their account already carries (`users.delivery_state`), because a digest
 * filtered to no state at all is every open tender in Brazil, which is the
 * portal this product exists to replace.
 */
export async function ensureAlert(userId: number, database: Executor = db()): Promise<void> {
  await database.execute(sql`
    insert into alerts (user_id, kind, states, channel, frequency, active)
    select ${userId}::bigint, 'cnae',
           case when u.delivery_state is null then '{}'::text[]
                else array[u.delivery_state]::text[] end,
           'telegram', 'weekly', true
      from users u
     where u.id = ${userId}::bigint
       and not exists (select 1 from alerts a
                        where a.user_id = u.id
                          and a.channel = 'telegram'
                          and a.frequency = 'weekly')
  `)
}

/** `/pausar`, and the "Desconectar" control on `/conta/alertas`. */
export async function setAlertActive(
  userId: number,
  active: boolean,
  database: Executor = db(),
): Promise<void> {
  await database.execute(sql`
    update alerts set active = ${active}
     where user_id = ${userId}::bigint and channel = 'telegram'
  `)
}

/**
 * Forget the chat entirely.
 *
 * The `alerts` row is switched off rather than deleted, so reconnecting
 * restores the keyword and state the person chose instead of asking again.
 */
export async function unlinkChat(userId: number, database: Executor = db()): Promise<void> {
  await database.execute(sql`
    delete from telegram_links where user_id = ${userId}::bigint
  `)
  await setAlertActive(userId, false, database)
}

export { digestOf }
