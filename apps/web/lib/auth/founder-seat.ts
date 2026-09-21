import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'

/**
 * Connecting a new account to its founder seat (spec §6.2, §6.3).
 *
 * `founders_list.seat` is 1..48, assigned when the person signed the Offer
 * form (task F1). `users.founder_seat` is the same number on the account they
 * later create. Nothing joined the two, because until now there were no
 * accounts.
 *
 * ## How they are matched: by e-mail, once, at account creation
 *
 * The e-mail is the only thing the two rows share — `founders_list.email` and
 * `users.email` are both `citext`, so `Maria@empresa.com` and the address
 * Google hands back are the same founder. The CNPJ would be a second signal,
 * but `founders_list.cnpj` is optional on the form and a shared accountant's
 * CNPJ is not evidence of anything, so the e-mail decides alone.
 *
 * It runs at creation and on every sign-in, not only the first: a founder who
 * signs up for the Offer *after* creating their account would otherwise never
 * get their seat, and that ordering is the likely one during founders week.
 * The statement is idempotent and only ever fills a `null`, so a seat can never
 * be reassigned or moved by signing in again.
 *
 * ## What it does *not* do
 *
 * It does not change `users.plan`. A seat is the right to buy Promocional at
 * R$ 26 (§10); it is not the plan itself, and billing is task F2 at M5. Setting
 * `plan = 'promocional'` here would hand 48 people unlimited screenings for
 * free, six weeks before anything can charge them. The seat is recorded, the
 * plan stays `basico`, and F2 reads `users.founder_seat` to price the
 * subscription.
 *
 * ## LGPD (§12)
 *
 * The e-mail never leaves the statement: it is a bound parameter, it is not
 * returned, and the only thing logged anywhere is the seat number, which
 * identifies nobody on its own.
 */

/** Spec §6.2: `founder_seat int` with a `between 1 and 48` check. */
export const MAX_SEAT = 48

/**
 * Copies this user's founders-list seat onto their account, if they have one
 * and do not already have a seat recorded.
 *
 * Returns the seat the user ends up with, or `null` when they are not a
 * founder. Safe to call on every sign-in.
 */
export async function linkFounderSeat(
  userId: number | string,
  database: Executor = db(),
): Promise<number | null> {
  const updated = await database.execute<{ founder_seat: number | null }>(sql`
    update users u
       set founder_seat = f.seat
      from founders_list f
     where u.id = ${String(userId)}::bigint
       and u.founder_seat is null
       and f.email = u.email
       and f.seat is not null
       and f.seat between 1 and ${MAX_SEAT}
       -- Two accounts can never hold one seat: users.founder_seat is unique,
       -- and this refuses rather than races for it.
       and not exists (select 1 from users x where x.founder_seat = f.seat)
     returning u.founder_seat
  `)

  const seat = updated.rows[0]?.founder_seat
  if (seat !== undefined && seat !== null) return Number(seat)

  // No update: either they are not on the list, or they already had a seat.
  const current = await database.execute<{ founder_seat: number | null }>(sql`
    select founder_seat from users where id = ${String(userId)}::bigint
  `)
  const existing = current.rows[0]?.founder_seat
  return existing === undefined || existing === null ? null : Number(existing)
}
