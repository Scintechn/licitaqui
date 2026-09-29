import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'
import type { TenderCard, TenderGroup } from '@/lib/radar/contract'
import type { CompanyMatch } from '@/lib/radar/tenders'

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

/**
 * A marked tender, as the section renders it.
 *
 * **A `TenderCard`, the same shape the Radar list uses**, plus when it was
 * marked. The first version carried four fields — the raw `object`, the
 * agency, the state and a date — and Sci's verdict was the right one: *"even
 * closed of a good UX… tells nothing worthy"*. The object is a wall of text;
 * `short_title` is the two-to-eight-word title the worker writes and every
 * other screen shows. Reusing the card means the value, the deadline
 * countdown, the item count and the ME/EPP tags come for free and cannot
 * drift from how the Radar draws them.
 */
export type Favourite = {
  card: TenderCard
  /** When the person marked it. The section is newest-first on this. */
  markedAt: Date
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
 * Everything this person marked, newest first, as cards.
 *
 * `join tenders` rather than a left join: the migration cascades a deleted
 * tender, so a favourite without one cannot exist — and if one ever did, an
 * inner join drops it rather than rendering a card with no object, which is
 * the honest failure.
 *
 * **`match` decides the compatibility badge**, and it is the account's own
 * CNPJ rather than a stored value. Sci's decision, 2026-09-29: a badge frozen
 * at the moment of marking would keep claiming "compatível" after the CNPJ
 * changed or the segment map improved — a claim about the past rendered as a
 * claim about now.
 */
export async function listFavourites(
  userId: number,
  match: CompanyMatch = { compatible: [], check: [], fits: [] },
  database: Executor = db(),
): Promise<Favourite[]> {
  const found = await database.execute<Row>(sql`
    select f.created_at,
           t.id, t.object, t.short_title, t.agency_name, t.city, t.state,
           t.modality_name, t.proposals_close_at, t.estimated_value,
           t.confidential_budget, t.price_registration, t.me_epp_summary,
           t.favored_treatment, t.segments, t.status, t.pncp_updated_at,
           (select count(*) from tender_items i where i.tender_id = t.id) as item_count
      from favourites f
      join tenders t on t.id = f.tender_id
     where f.user_id = ${userId}::bigint
     order by f.created_at desc, f.tender_id
  `)
  return found.rows.map((row) => {
    const segments = row.segments ?? []
    return {
      markedAt: new Date(row.created_at),
      card: {
        id: row.id,
        object: row.object ?? '',
        shortTitle: row.short_title,
        agencyName: row.agency_name,
        city: row.city,
        state: row.state,
        modalityName: row.modality_name,
        proposalsCloseAt: row.proposals_close_at
          ? new Date(row.proposals_close_at).toISOString()
          : null,
        estimatedValue: row.estimated_value,
        confidentialBudget: Boolean(row.confidential_budget),
        priceRegistration: Boolean(row.price_registration),
        meEppSummary: row.me_epp_summary,
        favoredTreatment: row.favored_treatment,
        itemCount: row.item_count === null ? null : Number(row.item_count),
        segments,
        matchedSegments: match.fits.filter((fit) => segments.includes(fit.segment)),
        // The badge, from the account's CNPJ. `keyword` is the honest answer
        // for a tender that matches no segment of theirs: it is here because
        // they put it here, not because the segments agreed.
        group: groupFor(segments, match),
        status: row.status,
        pncpUpdatedAt: row.pncp_updated_at ? new Date(row.pncp_updated_at).toISOString() : null,
      },
    }
  })
}

/** The same three-way split the Radar list makes, in TypeScript rather than SQL. */
function groupFor(segments: string[], match: CompanyMatch): TenderGroup {
  if (segments.some((segment) => match.compatible.includes(segment))) return 'compatible'
  if (segments.some((segment) => match.check.includes(segment))) return 'check'
  return 'keyword'
}

type Row = {
  created_at: Date | string
  id: string
  object: string | null
  short_title: string | null
  agency_name: string | null
  city: string | null
  state: string | null
  modality_name: string | null
  proposals_close_at: Date | string | null
  estimated_value: string | null
  confidential_budget: boolean | null
  price_registration: boolean | null
  me_epp_summary: string | null
  favored_treatment: boolean | null
  segments: string[] | null
  status: string | null
  pncp_updated_at: Date | string | null
  item_count: string | number | null
}
