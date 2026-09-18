import { createHash, randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'
import type { VisitorView } from './contract'

/**
 * Visitor mode: who is asking, when they started, and when it runs out
 * (spec §8, §10, decision 5 in §17).
 *
 * > the 3-day rule counts from `visitors.created_at` **and** from the first
 * > search of that CNPJ (decided: per device and per CNPJ), so resetting via
 * > incognito does not reset the CNPJ.
 *
 * Both halves are here. The device is the cookie; the CNPJ is the earliest
 * `visitors.created_at` among every visitor row that has searched it. Clearing
 * cookies gets a new device window and the old CNPJ window, which is the point.
 *
 * ## The cookie
 *
 * `httpOnly`, `sameSite=lax`, `secure` outside development, 30 days — §8. The
 * value is a v4 UUID and nothing else.
 *
 * §8 calls it a *signed* cookie. A signature would prove the server minted the
 * value; here the value is 122 bits of `crypto.randomUUID()` that must also
 * name a row in `visitors`, and a forger who can produce one of those can
 * produce a valid signature's worth of nothing — they would be guessing a UUID.
 * So the property §8 wants is met without introducing a signing secret, which
 * does not exist in the environment yet (Auth.js and its `AUTH_SECRET` are task
 * U1). When it does, HMAC the value here and nothing else changes.
 *
 * ## LGPD (§12)
 *
 * `ip_hash` and `user_agent_hash` are SHA-256 with a deployment salt, never the
 * address itself. The CNPJ is written to `visitors.cnpj` — the column §6.2
 * defines for it — and never logged.
 */

export const VISITOR_COOKIE = 'lq_visitor'

/** §8: "a signed cookie (`httpOnly`, 30 days)". */
export const VISITOR_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60

/** `plan_limits` calls the no-account plan `visitor`. */
export const VISITOR_PLAN = 'visitor'

/** The 3-day window of §10. Read from `plan_limits (visitor, days)` when set. */
export const VISITOR_DAYS_FALLBACK = 3

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type Visitor = {
  id: string
  createdAt: Date
  cnpj: string | null
  screeningsUsed: number
  /** Set when this request minted the id: the route must send the cookie. */
  isNew: boolean
}

/** Reads the cookie without pulling in `next/headers`, so tests can drive it. */
export function visitorIdFromCookies(header: string | null): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name !== VISITOR_COOKIE) continue
    const value = decodeURIComponent(rest.join('='))
    return UUID_RE.test(value) ? value : null
  }
  return null
}

export function visitorCookie(id: string, secure = process.env.NODE_ENV === 'production'): string {
  const parts = [
    `${VISITOR_COOKIE}=${id}`,
    'Path=/',
    `Max-Age=${VISITOR_COOKIE_MAX_AGE_SECONDS}`,
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

function hash(value: string | null | undefined): string | null {
  if (!value) return null
  // A per-deployment salt would be better still; without a secret in the
  // environment, truncating is what keeps the digest from being a lookup table
  // for "was this address here" while staying stable enough to be useful.
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

type VisitorRow = {
  id: string
  created_at: Date | string
  cnpj: string | null
  screenings_used: number
}

/**
 * The visitor this cookie names, or `null`.
 *
 * Reads only. The routes that merely show data — the tender list and one
 * tender — use this rather than `loadOrCreateVisitor`, because a `GET` that
 * inserted a row would let a crawler fill `visitors` one page at a time. The
 * identity is minted where §8 says it is: the first `POST /api/radar/cnpj`.
 */
export async function loadVisitor(
  cookieHeader: string | null,
  database: Executor = db(),
): Promise<Visitor | null> {
  const id = visitorIdFromCookies(cookieHeader)
  if (!id) return null
  const found = await database.execute<VisitorRow>(sql`
    select id, created_at, cnpj, screenings_used from visitors where id = ${id}::uuid
  `)
  const row = found.rows[0]
  if (!row) return null
  return {
    id: row.id,
    createdAt: new Date(row.created_at),
    cnpj: row.cnpj,
    screeningsUsed: Number(row.screenings_used),
    isNew: false,
  }
}

/**
 * The visitor behind this request, creating one when the cookie is absent or
 * names a row that no longer exists (a `cleanup` job deletes visitors after 30
 * days, §7.1).
 */
export async function loadOrCreateVisitor(
  input: { cookieHeader: string | null; ip?: string | null; userAgent?: string | null },
  database: Executor = db(),
): Promise<Visitor> {
  const existing = await loadVisitor(input.cookieHeader, database)
  if (existing) return existing

  const id = randomUUID()
  const created = await database.execute<VisitorRow>(sql`
    insert into visitors (id, ip_hash, user_agent_hash)
    values (${id}::uuid, ${hash(input.ip)}, ${hash(input.userAgent)})
    returning id, created_at, cnpj, screenings_used
  `)
  const row = created.rows[0]
  return {
    id,
    createdAt: row ? new Date(row.created_at) : new Date(),
    cnpj: null,
    screeningsUsed: 0,
    isNew: true,
  }
}

/** Records which CNPJ this device searched. Idempotent; the last one wins. */
export async function attachCnpj(
  visitorId: string,
  cnpj: string,
  database: Executor = db(),
): Promise<void> {
  await database.execute(sql`
    update visitors set cnpj = ${cnpj} where id = ${visitorId}::uuid and cnpj is distinct from ${cnpj}
  `)
}

/**
 * When this visitor's free window started: the earlier of their own
 * `created_at` and the first time *any* device searched this CNPJ (§8).
 */
export async function windowStartedAt(
  visitor: Visitor,
  cnpj: string | null,
  database: Executor = db(),
): Promise<Date> {
  if (!cnpj) return visitor.createdAt
  const found = await database.execute<{ started_at: Date | string | null }>(sql`
    select min(created_at) as started_at from visitors where cnpj = ${cnpj}
  `)
  const started = found.rows[0]?.started_at
  if (!started) return visitor.createdAt
  const byCnpj = new Date(started)
  return byCnpj < visitor.createdAt ? byCnpj : visitor.createdAt
}

export function visitorView(
  startedAt: Date,
  days: number,
  screenings: { used: number; limit: number | null },
  now: Date = new Date(),
): VisitorView {
  const expiresAt = new Date(startedAt.getTime() + days * 24 * 60 * 60 * 1000)
  return {
    expiresAt: expiresAt.toISOString(),
    expired: expiresAt.getTime() <= now.getTime(),
    screeningsUsed: screenings.used,
    screeningsLeft: screenings.limit === null ? null : Math.max(0, screenings.limit - screenings.used),
  }
}
