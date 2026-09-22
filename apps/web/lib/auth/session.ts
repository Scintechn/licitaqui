import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'
import { ensureCompanyRow } from '@/lib/radar/company'
import { SESSION_COOKIE, SESSION_COOKIE_SECURE } from './config'

/**
 * Who is signed in, read straight from the request's `Cookie` header.
 *
 * ## Why not `auth()`
 *
 * Auth.js's `auth()` reads the cookie through `next/headers`, which only exists
 * inside a request scope that Next itself creates. Every API route in this app
 * is called directly from the database tests with a plain `Request` — that is
 * how `radar.db.test.ts` exercises the real handlers rather than the libraries
 * under them — and `next/headers` throws there. Server Components, which do run
 * inside that scope, use `auth()`; the route handlers use this.
 *
 * It is not a second implementation of anything risky. The session strategy is
 * `database` (spec §5: "Auth.js with the Postgres adapter"), so the cookie
 * value is an opaque token and the whole of "is this session valid" is one row
 * in `sessions` plus its `expires`. Auth.js's own adapter does exactly this
 * query. The one thing that could drift — the cookie's *name* — cannot, because
 * `lib/auth/config.ts` pins it and `lib/auth/index.ts` configures Auth.js with
 * the same constant.
 *
 * ## LGPD (§12)
 *
 * The token is never logged and never returned. The caller gets the numeric
 * user id, the plan and the CNPJ; the e-mail is fetched only where a screen
 * actually shows it, which is `/conta` and nowhere else.
 */

export type SessionUser = {
  userId: number
  /** §10: `basico | promocional | essencial | pro`. */
  plan: string
  /** The company this account searched last, or the one from the Offer form. */
  cnpj: string | null
  /** 1..48 when this account came from the founders list, else `null`. */
  founderSeat: number | null
  expires: Date
}

/**
 * The value of the Auth.js session cookie in this header, or `null`.
 *
 * Both names are accepted: Auth.js adds the `__Secure-` prefix when the
 * deployment URL is `https`, so production and localhost differ, and a cookie
 * jar can legitimately hold both after a deployment moves.
 */
export function sessionTokenFromCookies(header: string | null): string | null {
  if (!header) return null
  let insecure: string | null = null
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const equals = trimmed.indexOf('=')
    if (equals <= 0) continue
    const name = trimmed.slice(0, equals)
    const value = decodeURIComponent(trimmed.slice(equals + 1))
    if (!value) continue
    // The `__Secure-` cookie wins: a browser will not send it over plain HTTP,
    // so when both arrive the secure one is the current session.
    if (name === SESSION_COOKIE_SECURE) return value
    if (name === SESSION_COOKIE) insecure = value
  }
  return insecure
}

type Row = {
  user_id: string
  plan: string
  cnpj: string | null
  founder_seat: number | null
  expires: Date | string
}

/**
 * The signed-in user this request carries, or `null` for a visitor.
 *
 * An expired row answers `null` rather than being deleted: cleaning up is the
 * `cleanup` job's business (§7.1), and a `GET` that deleted rows would be a way
 * to make the database do work by asking it questions.
 */
export async function readSessionUser(
  cookieHeader: string | null,
  database: Executor = db(),
): Promise<SessionUser | null> {
  const token = sessionTokenFromCookies(cookieHeader)
  if (!token) return null

  const found = await database.execute<Row>(sql`
    select s."userId" as user_id, s.expires, u.plan, u.cnpj, u.founder_seat
      from sessions s
      join users u on u.id = s."userId"
     where s."sessionToken" = ${token}
       and s.expires > now()
  `)
  const row = found.rows[0]
  if (!row) return null

  return {
    userId: Number(row.user_id),
    plan: row.plan,
    cnpj: row.cnpj,
    founderSeat: row.founder_seat === null ? null : Number(row.founder_seat),
    expires: new Date(row.expires),
  }
}

/**
 * Records the CNPJ this account searched, when it has none yet.
 *
 * §6.2 gives `users.cnpj` for it, and E1's weekly digest has no other way to
 * know which company to search for. Only ever fills a `null`: changing a
 * company is an account setting, not a side effect of one search.
 *
 * That reasoning was always right and, until task E3, it deferred to a setting
 * that did not exist — so the first company somebody happened to search became
 * theirs permanently, and a bookkeeper who looked up a client before their own
 * company was stuck with the client. The setting is `setUserCnpj()` below, and
 * this function's restraint is now a division of labour rather than a dead end.
 */
export async function rememberUserCnpj(
  userId: number,
  cnpj: string,
  database: Executor = db(),
): Promise<void> {
  await database.execute(sql`
    update users set cnpj = ${cnpj}
     where id = ${userId}::bigint
       and cnpj is null
       and exists (select 1 from companies c where c.cnpj = ${cnpj})
  `)
}

/**
 * Sets the account's company, deliberately, from the account area (task E3).
 *
 * The counterpart to `rememberUserCnpj`: this one is the gesture the comment
 * above defers to, so it **does** overwrite, and it is reached only from a
 * Server Function that has re-read the session.
 *
 * ## It does not need the company to be known yet
 *
 * `users.cnpj` is a foreign key to `companies` (migration `0001`), which is the
 * real reason `rememberUserCnpj` checks for the row: without one the update
 * does not quietly miss, it raises `users_cnpj_fkey`. The Radar never meets
 * that because it only remembers a CNPJ it has just looked up. A CNPJ typed
 * into `/conta` may never have been looked up at all, and §3 forbids waiting on
 * BrasilAPI inside the request (§9: no SLA) — so `ensureCompanyRow` puts the
 * key in first, as the placeholder the worker itself writes when BrasilAPI
 * cannot answer, and `company_lookup` fills it seconds later.
 *
 * Both statements take the executor they are given, so a caller that passes a
 * transaction gets the placeholder and the account change atomically.
 *
 * The caller validates the CNPJ with `normaliseCnpj` first: fourteen digits
 * with good check digits is the guard. A typo must not be able to leave a row
 * in the BrasilAPI cache that the worker will then spend a request failing to
 * resolve.
 *
 * §12: the CNPJ is never logged here or by the caller.
 */
export async function setUserCnpj(
  userId: number,
  cnpj: string,
  database: Executor = db(),
): Promise<void> {
  await ensureCompanyRow(cnpj, database)
  await database.execute(sql`
    update users set cnpj = ${cnpj} where id = ${userId}::bigint
  `)
}
