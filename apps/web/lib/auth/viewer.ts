import { db, type Executor } from '@/lib/db'
import type { VisitorView } from '@/lib/radar/contract'
import { FEATURES, readLimit, type Spender } from '@/lib/radar/quota'
import {
  loadOrCreateVisitor,
  loadVisitor,
  visitorView,
  VISITOR_DAYS_FALLBACK,
  VISITOR_PLAN,
  type Visitor,
} from '@/lib/radar/visitor'
import { readSessionUser, type SessionUser } from './session'

/**
 * "Who is asking?" — the one seam every Radar route goes through (spec §8, §10).
 *
 * Before U1 the answer was always "a visitor", and each route said so in its
 * own words. Now there are two answers and they differ in four places — the
 * plan whose `plan_limits` apply, what `usage` rows are charged to, whether the
 * 3-day window exists at all, and whether the edital files are unlocked — so
 * they are decided here, once, and the routes read the result.
 *
 * ## An account adds capability; it is never a precondition
 *
 * `readViewer` answers `null` rather than refusing when nobody is identified,
 * and every caller keeps working. Anonymous browsing of `/radar` and the two
 * free screenings behave exactly as they did before U1: same cookie, same rows,
 * same numbers. That is the rule the card is strictest about and the reason
 * this file returns a *description* of the caller rather than a decision about
 * them.
 *
 * ## The visitor window does not apply to an account
 *
 * §10 gives the 3 days to "Visitante (sem conta)". A signed-in user on Básico
 * has a monthly quota and no expiry, so `visitorWindow()` is `null` for them
 * and the banner the screens draw from it disappears — which is also what
 * `VisitorView` being nullable in the contract already anticipated.
 */

export type Viewer =
  | { kind: 'user'; user: SessionUser }
  | { kind: 'visitor'; visitor: Visitor }

/** The plan whose `plan_limits` rows govern this caller. */
export function planOf(viewer: Viewer | null): string {
  return viewer?.kind === 'user' ? viewer.user.plan : VISITOR_PLAN
}

/**
 * Who the `usage` row is charged to.
 *
 * Per account, or per device. Not per CNPJ: §17's decision 5 scopes "per device
 * and per CNPJ" to the **3-day window**, which `windowStartedAt()` implements,
 * and the terms say the same. See the note in `lib/radar/quota.ts`.
 */
export function spenderOf(viewer: Viewer): Spender {
  if (viewer.kind === 'user') return { userId: viewer.user.userId }
  return { visitorId: viewer.visitor.id }
}

/** §8: "files only with an account". */
export function hasAccount(viewer: Viewer | null): boolean {
  return viewer?.kind === 'user'
}

/** The CNPJ this caller last searched, wherever it is stored for them. */
export function cnpjOf(viewer: Viewer | null): string | null {
  if (!viewer) return null
  return viewer.kind === 'user' ? viewer.user.cnpj : viewer.visitor.cnpj
}

/**
 * The caller, without creating anything. Use from every `GET`: a read that
 * inserted a `visitors` row would let a crawler fill the table one URL at a
 * time (see `loadVisitor`).
 */
export async function readViewer(
  cookieHeader: string | null,
  database: Executor = db(),
): Promise<Viewer | null> {
  const user = await readSessionUser(cookieHeader, database)
  if (user) return { kind: 'user', user }
  const visitor = await loadVisitor(cookieHeader, database)
  return visitor ? { kind: 'visitor', visitor } : null
}

/**
 * The caller, minting a visitor identity when there is none. Use from the two
 * `POST`s that §8 says create one.
 *
 * A signed-in user never gets a `visitors` row: they have an account, the row
 * would count nothing, and it would give them a second identity to spend from.
 */
export async function readOrCreateViewer(
  input: { cookieHeader: string | null; ip?: string | null; userAgent?: string | null },
  database: Executor = db(),
): Promise<Viewer> {
  const user = await readSessionUser(input.cookieHeader, database)
  if (user) return { kind: 'user', user }
  return { kind: 'visitor', visitor: await loadOrCreateVisitor(input, database) }
}

/**
 * The free-window banner (§10), or `null` for an account.
 *
 * `startedAt` is the earlier of this device's `created_at` and the first time
 * any device searched this CNPJ — the caller computes it with
 * `windowStartedAt()`, because only the caller knows which CNPJ is in play.
 */
export async function visitorWindow(
  viewer: Viewer | null,
  startedAt: Date,
  screenings: { used: number; limit: number | null },
  database: Executor = db(),
): Promise<VisitorView | null> {
  if (!viewer || viewer.kind !== 'visitor') return null
  const days = await readLimit(VISITOR_PLAN, FEATURES.days, database)
  return visitorView(startedAt, days.quantity ?? VISITOR_DAYS_FALLBACK, screenings)
}
