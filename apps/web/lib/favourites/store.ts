import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'

/**
 * Marking a tender, and finding it again — card **D23**.
 *
 * Sci, 2026-09-29: *"I plan to have another section 'Favorites' when the user
 * marked a tenders as Favorite and we have this section with all followers
 * Tenders"*.
 *
 * ## The word
 *
 * **Favoritar**, not *acompanhar*. `Concorrentes.dc.html` already spends
 * *Acompanhar* on following a rival **company**, and `Alertas.dc.html`
 * promises *"quando quem você acompanha ganha"* — a sentence that reads
 * correctly only while *acompanhar* means competitors. Two features, two
 * words, and no approved copy had to be rewritten.
 *
 * ## The count comes from the list
 *
 * The card is explicit about this and it is the whole reason this module has
 * no `countFavourites`: the nav badge and the section are **one read**. A
 * second query would be a second answer, free to disagree — and a badge saying
 * 4 above a list showing 3 is the shape of defect this repo keeps finding,
 * where two readers of the same fact reach different conclusions. Ask
 * {@link listFavourites} and take `.length`.
 *
 * Where the badge must be cheap and the list is not wanted, {@link isFavourite}
 * answers one row from the primary key.
 */

/** A marked tender, as the section renders it. */
export type Favourite = {
  tenderId: string
  object: string
  agencyName: string | null
  state: string | null
  /** `null` when PNCP published none, which the card must not read as "today". */
  closeAt: Date | null
  /** When the person marked it. The section is newest-first on this. */
  markedAt: Date
}

type Row = {
  tender_id: string
  object: string | null
  agency_name: string | null
  state: string | null
  proposals_close_at: Date | string | null
  created_at: Date | string
}

/**
 * Mark a tender, or do nothing if it is already marked.
 *
 * **Idempotent on purpose**, and the primary key is what makes it so. That
 * button gets tapped twice by anybody on a slow connection, and the migration
 * made `(user_id, tender_id)` the key precisely so the second tap is the same
 * fact rather than a second row or an error the screen has to explain.
 *
 * Returns whether the row is now present, which is always `true` — the boolean
 * exists so {@link toggleFavourite} can report the resulting state without a
 * second read.
 */
export async function addFavourite(
  userId: number,
  tenderId: string,
  database: Executor = db(),
): Promise<boolean> {
  await database.execute(sql`
    insert into favourites (user_id, tender_id)
    values (${userId}::bigint, ${tenderId})
    on conflict (user_id, tender_id) do nothing
  `)
  return true
}

/** Unmark a tender, or do nothing if it was not marked. */
export async function removeFavourite(
  userId: number,
  tenderId: string,
  database: Executor = db(),
): Promise<boolean> {
  await database.execute(sql`
    delete from favourites
     where user_id = ${userId}::bigint and tender_id = ${tenderId}
  `)
  return false
}

/**
 * Flip the mark, and say what it became.
 *
 * **One statement, not a read then a write.** Checking and then inserting
 * leaves a window in which two taps both see "not marked" and the second is a
 * no-op that reports the wrong state — the button then says *Favoritar* on a
 * tender that is marked. `delete … returning` tells us whether a row existed,
 * atomically, and only inserts when it did not.
 */
export async function toggleFavourite(
  userId: number,
  tenderId: string,
  database: Executor = db(),
): Promise<boolean> {
  const removed = await database.execute<{ tender_id: string }>(sql`
    delete from favourites
     where user_id = ${userId}::bigint and tender_id = ${tenderId}
    returning tender_id
  `)
  if (removed.rows.length > 0) return false
  return addFavourite(userId, tenderId, database)
}

/** Whether this person has marked this tender. One row, off the primary key. */
export async function isFavourite(
  userId: number,
  tenderId: string,
  database: Executor = db(),
): Promise<boolean> {
  const found = await database.execute<{ one: number }>(sql`
    select 1 as one from favourites
     where user_id = ${userId}::bigint and tender_id = ${tenderId}
  `)
  return found.rows.length > 0
}

/**
 * Everything this person marked, newest first.
 *
 * `join tenders` rather than a left join: the migration cascades a deleted
 * tender, so a favourite without one cannot exist — and if it ever did, an
 * inner join drops it rather than rendering a card with no object, which is
 * the honest failure.
 */
export async function listFavourites(
  userId: number,
  database: Executor = db(),
): Promise<Favourite[]> {
  const found = await database.execute<Row>(sql`
    select f.tender_id, f.created_at,
           t.object, t.agency_name, t.state, t.proposals_close_at
      from favourites f
      join tenders t on t.id = f.tender_id
     where f.user_id = ${userId}::bigint
     order by f.created_at desc, f.tender_id
  `)
  return found.rows.map((row) => ({
    tenderId: row.tender_id,
    object: row.object ?? '',
    agencyName: row.agency_name,
    state: row.state,
    closeAt: row.proposals_close_at === null ? null : new Date(row.proposals_close_at),
    markedAt: new Date(row.created_at),
  }))
}
