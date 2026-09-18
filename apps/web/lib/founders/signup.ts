import { sql } from 'drizzle-orm'
import { db, foundersList, type Executor } from '@/lib/db'
import { eventInsertSelect, type EventName } from '@/lib/events'
import { FOUNDER_SEATS } from './seats'
import type { SignupInput } from './input'

/**
 * The founders signup transaction (spec §6.3).
 *
 * > "assign the seat inside a transaction (lock a control row, or use a
 * > dedicated sequence capped at 48) so two people can never both get seat 48."
 *
 * ## Why this cannot race
 *
 * The transaction's first statement takes a **transaction-scoped advisory lock**
 * on a constant pair of integers. Every signup takes the same lock, so the
 * read-then-insert below is serialised across connections, processes and
 * serverless instances: the lock lives in Postgres, not in one function's
 * memory. COMMIT, ROLLBACK and a dropped connection all release it, so a dead
 * instance cannot wedge the queue.
 *
 * It must be `pg_advisory_xact_lock`, not the session-scoped `pg_advisory_lock`:
 * behind Neon's PgBouncer in transaction mode (§5) a session-scoped lock could
 * be left on a connection that the next request then reuses.
 *
 * The lock must also be **its own statement**. Under READ COMMITTED a statement
 * takes its snapshot before it starts executing, so calling
 * `pg_advisory_xact_lock()` inside the same statement that picks the seat would
 * wait for the lock and still read a snapshot from before the wait. Locking
 * first and reading second is the whole trick.
 *
 * Inside the lock the free seat is the lowest integer in 1..48 that no row
 * holds, which also recycles a seat freed when a founder gives one up. The
 * `seat int unique` constraint stays the hard backstop: were this reasoning
 * ever wrong, the second writer gets a unique violation, never a shared seat.
 *
 * What this deliberately is **not**: `select max(seat) + 1`. Two transactions
 * read the same maximum and both take the same seat — that passes a serial test
 * and fails under load, which is exactly what the card's 60-request test
 * checks.
 *
 * ## One statement, not seven
 *
 * Everything a signup writes — the founder, the `events` row, the queued
 * WhatsApp welcome — happens in a single statement built from data-modifying
 * CTEs. Two reasons:
 *
 *  - **atomicity is visible.** There is no ordering in which a founder holds a
 *    seat and no welcome was queued, or a welcome is queued for nobody.
 *  - **the serialised window is two round trips** (this statement and COMMIT)
 *    instead of seven. Signups queue behind each other by definition; how long
 *    each one holds the lock is the only thing deciding whether 48 people
 *    arriving at once wait a moment or a minute.
 *
 * Nothing here talks to WhatsApp: §3 forbids a slow external call inside a web
 * request, so the message is a `send_whatsapp` job for task E2 to deliver.
 */

/**
 * Advisory-lock coordinates for the founder seat counter. Any constant pair
 * works as long as nothing else in the app uses it; 19537 = 0x4C51 = "LQ".
 */
const SEAT_LOCK = { namespace: 19537, key: 48 } as const

/** The job E2 consumes. One per founder, de-duplicated by the `jobs_dedupe` index. */
export const WELCOME_JOB_KIND = 'send_whatsapp'

/** Templates in `worker/templates/whatsapp/` (task E0). */
export const WELCOME_TEMPLATE = 'founders-welcome'
export const WAITLIST_TEMPLATE = 'founders-waitlist'

/**
 * Priority 3: nobody is blocked on a screen waiting for it (that is priority 1
 * in §7.3), but the confirmation screen has just promised the message, so it
 * must not queue behind the 30-minute PNCP sweeps at priority 5.
 */
const WELCOME_JOB_PRIORITY = 3

/**
 * The two `events.name` values this flow writes. Both come from the catalogue
 * in `lib/events`, which is the one place that knows how an `events` row is
 * written; `satisfies` makes a typo here a type error rather than a gate that
 * silently reads zero.
 */
export const SIGNUP_EVENT = 'founder_signup' satisfies EventName
export const DUPLICATE_EVENT = 'founder_signup_duplicate' satisfies EventName

/**
 * The terms/privacy version stored with each consent, since `founders_list` has
 * no column for it (§6.3 belongs to `db/migrations`). Bump it when the
 * published texts change, so every `events` row says which wording was ticked.
 */
export const CONSENT_TERMS_VERSION = '2026-09-17'

export type SignupOutcome =
  | { status: 'seated'; id: number; seat: number; seatsTaken: number }
  | { status: 'waitlisted'; id: number; position: number }
  | { status: 'already_registered'; id: number; seat: number | null; position: number | null }

export type SignupProvenance = {
  /** When the two Annex B boxes were ticked — the consent record of §12. */
  consentAt: Date
  /** Which version of the terms and privacy texts that was. */
  termsVersion: string
}

type WriteRow = {
  id: string | number
  seat: number | null
  position: number | null
  seats_taken: number | null
}

type DuplicateRow = { id: string | number; seat: number | null; position: number | null }

export async function signUpFounder(
  input: SignupInput,
  provenance: SignupProvenance = { consentAt: new Date(), termsVersion: CONSENT_TERMS_VERSION },
  database: Executor = db(),
): Promise<SignupOutcome> {
  return database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SEAT_LOCK.namespace}, ${SEAT_LOCK.key})`)

    // The LGPD consent record (§12, terms Annex B). No e-mail, no number, no
    // name: the founders_list id is the only link back to the person.
    // Every parameter inside a jsonb_build_object() is cast explicitly:
    // Postgres cannot infer the type of a bare parameter there (42P18,
    // "could not determine data type"), and a null source would fail outright.
    const consentProps = sql`jsonb_build_object(
      'contact_consent', ${input.contactConsent}::boolean,
      'terms_accepted', ${input.acceptedTerms}::boolean,
      'terms_version', ${provenance.termsVersion}::text,
      'privacy_consent_at', ${provenance.consentAt.toISOString()}::text
    )`

    const written = await tx.execute<WriteRow>(sql`
      with new_founder as (
        insert into founders_list
          (name, email, whatsapp, cnpj, sells, source, seat, contact_consent)
        select ${input.name}, ${input.email}, ${input.whatsapp}, ${input.cnpj},
               ${input.sells ?? null}, ${input.source ?? null},
               -- The lowest seat nobody holds, or null once all 48 are taken.
               (select min(g.seat)
                  from generate_series(1, ${FOUNDER_SEATS}::int) as g(seat)
                 where not exists (select 1 from founders_list f where f.seat = g.seat)),
               ${input.contactConsent}
        -- An e-mail already on the list writes nothing at all: no second seat,
        -- no second welcome. The duplicate is answered by the query below.
        on conflict (email) do nothing
        returning id, seat
      ),
      place as (
        select n.id,
               n.seat,
               -- This statement's snapshot cannot see the row it just inserted,
               -- and every other waitlisted row is committed (we hold the lock),
               -- so "everyone already waiting, plus me" is the place in line.
               case
                 when n.seat is null
                 then (select count(*) + 1 from founders_list w where w.seat is null)
               end as position,
               case
                 when n.seat is null then null
                 else (select count(f.seat) + 1 from founders_list f)
               end as seats_taken
          from new_founder n
      ),
      logged as (
        ${eventInsertSelect({
          name: SIGNUP_EVENT,
          props: sql`jsonb_build_object(
            'founders_list_id', p.id,
            'seat', p.seat,
            'waitlist_position', p.position,
            'source', ${input.source ?? null}::text
          ) || ${consentProps}`,
        })}
          from place p
      ),
      queued as (
        insert into jobs (kind, key, priority, payload)
        select ${WELCOME_JOB_KIND}::text, 'founders:' || p.id, ${WELCOME_JOB_PRIORITY}::int,
               jsonb_build_object(
                 'template', case when p.seat is null
                                  then ${WAITLIST_TEMPLATE}::text
                                  else ${WELCOME_TEMPLATE}::text end,
                 -- E2 reads the name and the number from founders_list by id, so
                 -- the queue never holds a second copy of someone's phone number
                 -- and a correction to the row is picked up by the send.
                 'founders_list_id', p.id,
                 'numero_vaga', p.seat,
                 'posicao_espera', p.position
               )
          from place p
        -- The jobs_dedupe index already allows one live job per (kind, key);
        -- saying so here means a retried request cannot fail on it either.
        on conflict do nothing
      )
      select id, seat, position, seats_taken from place
    `)

    const row = written.rows[0]
    if (!row) {
      // Reached only by a repeat submit, which is why it costs an extra round
      // trip and the happy path does not.
      return duplicate(tx, input)
    }

    const id = Number(row.id)
    if (row.seat === null) {
      return { status: 'waitlisted', id, position: Number(row.position ?? 1) }
    }
    return { status: 'seated', id, seat: Number(row.seat), seatsTaken: Number(row.seats_taken) }
  })
}

/** Idempotency: the e-mail is already on the list (§6.3, `email citext unique`). */
async function duplicate(tx: Executor, input: SignupInput): Promise<SignupOutcome> {
  const found = await tx.execute<DuplicateRow>(sql`
    with existing as (
      select l.id,
             l.seat,
             case
               when l.seat is null
               then (select count(*) from founders_list w
                      where w.seat is null and w.id <= l.id)
             end as position
        from founders_list l
       where l.email = ${input.email}
    ),
    logged as (
      ${eventInsertSelect({
        name: DUPLICATE_EVENT,
        props: sql`jsonb_build_object(
          'founders_list_id', e.id,
          'seat', e.seat,
          'waitlist_position', e.position,
          'source', ${input.source ?? null}::text
        )`,
      })}
        from existing e
    )
    select id, seat, position from existing
  `)

  const row = found.rows[0]
  if (!row) {
    // The row vanished between the insert and this read: only possible if it
    // was deleted in the same instant (an LGPD erasure). Fail loudly rather
    // than invent an outcome — the browser retries.
    throw new Error('founders_list row disappeared during signup')
  }
  return {
    status: 'already_registered',
    id: Number(row.id),
    seat: row.seat === null ? null : Number(row.seat),
    position: row.position === null ? null : Number(row.position),
  }
}

/** Seats already handed out. Backs `GET /api/founders/seats`. */
export async function countFounderSeatsTaken(database: Executor = db()): Promise<number> {
  const [row] = await database
    .select({ count: sql<number>`count(${foundersList.seat})::int` })
    .from(foundersList)
  return row?.count ?? 0
}
