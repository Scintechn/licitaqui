import { sql, type SQL } from 'drizzle-orm'
import { readOrEnqueue, TTL, type Cached } from '@/lib/cache'
import { db, type Executor } from '@/lib/db'
import { JOB_KINDS } from '@/lib/jobs'
import { DEFAULT_SORT } from './contract'
import type { SegmentFit, TenderCard, TenderGroup, TenderSort } from './contract'
import { DIVULGADA } from './tender-status'

/**
 * The Radar list (spec §8 `GET /api/radar/tenders`): every open tender that
 * touches the company's segments or the words they typed, in three groups.
 *
 * ## Compatible / Verificar / Palavra-chave
 *
 * The grouping is one `case` over an array overlap. `tenders.segments` and the
 * `company_segments` view speak the same 14 Portuguese labels — B3 and B6 chose
 * POC 1's strings on both sides precisely so this join needs no translation —
 * so the whole classification is:
 *
 * ```
 * compatible  t.segments && (the company's `compatible` labels)
 * check       t.segments && (the company's `check` labels)
 * keyword     neither, but the text matched what the user typed
 * ```
 *
 * A tender in both buckets is `compatible`: the stronger claim wins, and B6's
 * rule has already made `compatible` hard to earn (it requires the *main*
 * CNAE), so there is nothing left to be cautious about here.
 *
 * Without a search term the `keyword` group is empty by construction, which is
 * the honest answer rather than "everything else in Brazil".
 *
 * ## Search, not ILIKE
 *
 * `tenders.search` is a `pt_unaccent` tsvector spanning the object and every
 * item description, with a GIN index on it. `websearch_to_tsquery` gives the
 * user quoted phrases and `-exclusions` for free, and the whole thing is
 * accent-insensitive: `licitacao` matches `licitação`. An `ILIKE '%…%'` would
 * match neither and could not use the index.
 *
 * ## Freshness
 *
 * The list's TTL is the 30-minute sweep of §3.2, measured on the newest
 * `tenders.updated_at`. Stale enqueues `sync_open_tenders`… except that it does
 * not: see `listFreshness` for why the web must not create that job.
 */

export type TenderFilters = {
  /** UF, e.g. `SP`. */
  state?: string | null
  /** Free text for `websearch_to_tsquery`. */
  q?: string | null
  /** Closed tenders are excluded by default: the Radar is for bidding. */
  includeClosed?: boolean
  limit?: number
  /** Keyset cursor from a previous page. */
  cursor?: string | null
  /**
   * The order (D51). Absent is `DEFAULT_SORT` — the deadline order this list
   * has always had — and produces the same SQL it did before the parameter
   * existed.
   */
  sort?: TenderSort | null
}

export type CompanyMatch = {
  compatible: string[]
  check: string[]
  /** Every segment with its fit, so a card can say how it matched. */
  fits: SegmentFit[]
}

export const DEFAULT_LIMIT = 20
export const MAX_LIMIT = 50

type TenderRow = {
  id: string
  object: string
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
  item_count: string | number | null
  segments: string[] | null
  grp: TenderGroup
  status: string | null
  halted: boolean
  updated_at: Date | string
  pncp_updated_at: Date | string | null
  /** Whether the viewer has marked it (D23). Always `false` with no viewer. */
  favourite: boolean
}

/**
 * Non-Divulgada tenders sort below Divulgada ones (`TENDER_STATUS_AND_WATCH`
 * §3.4), and this is the expression that says so — one definition, shared by
 * the `order by`, the projection and the cursor, because a sort key that does
 * not match its cursor silently skips rows at every page boundary.
 *
 * `is distinct from` rather than `<>`: a null status must be *halted*, not
 * null, or it would sort as unknown and the gate in `tender-status.ts` (which
 * treats unknown as "no urgency") and the list would disagree about the same
 * row. Postgres sorts `false` before `true`, so Divulgada comes first.
 *
 * They are sorted down, never filtered out: a user may be tracking exactly the
 * tender that was suspended, and hiding it is how they would find out too late.
 */
const HALTED = sql`(t.status is distinct from ${DIVULGADA})`

/**
 * The sort key, as an ordered list of ascending expressions — **one definition,
 * read by the `order by`, by the keyset cursor's comparison and by nothing
 * else.** The rule at the head of `HALTED` is the whole reason this is a
 * function and not two pieces of SQL that happen to agree today: a sort key
 * that does not match its cursor silently skips rows at every page boundary.
 *
 * ## Every component is non-null, and every direction is ascending
 *
 * That is what lets the cursor stay a single row comparison (`(a,b,c) > (…)`).
 * Postgres has no row comparison with per-column `desc` or `nulls last`, so
 * both are folded into the expressions instead:
 *
 * - **nulls last, in both value directions.** `estimated_value is null` sorts
 *   `false` before `true`, so the 4 588 open tenders with no declared value
 *   (19% of 24 162, measured 2026-10-06) land after every priced one whichever
 *   way the prices run. Put them first and they own the whole first page of
 *   *menor valor*.
 * - **descending by negation.** `-value` ascending is `value` descending, and
 *   it keeps the comparison one `>`.
 *
 * `estimated_value` is `numeric(16,2)`, so Postgres already compares it
 * numerically; what has to be said out loud is the **cursor** side, where the
 * value arrives as text and a missing `::numeric` would sort `R$ 9` above
 * `R$ 10`. See `cursorKey`.
 */
type SortColumns = {
  halted: SQL
  closeAt: SQL
  value: SQL
  id: SQL
}

/** Inside the CTE, where `halted` is still an expression over `tenders t`. */
const IN_SCOPE: SortColumns = {
  halted: HALTED,
  closeAt: sql`t.proposals_close_at`,
  value: sql`t.estimated_value`,
  id: sql`t.id`,
}

/** Outside it, where `matched` has already projected the same four. */
const IN_MATCHED: SortColumns = {
  halted: sql`halted`,
  closeAt: sql`proposals_close_at`,
  value: sql`estimated_value`,
  id: sql`id`,
}

function sortKey(sort: TenderSort, columns: SortColumns): SQL[] {
  // Nulls last on the deadline too: a tender with no deadline is not urgent,
  // and `null > anything` would otherwise put it first.
  const deadline = sql`coalesce(${columns.closeAt}, 'infinity'::timestamptz)`
  if (sort === 'deadline') return [columns.halted, deadline, columns.id]
  const value = sql`coalesce(${columns.value}, 0)`
  return [
    columns.halted,
    sql`(${columns.value} is null)`,
    sort === 'valueDesc' ? sql`-${value}` : value,
    columns.id,
  ]
}

/**
 * A keyset cursor over whichever sort key minted it.
 *
 * Offset pagination would skip or repeat a tender every time the 30-minute
 * sweep inserts one between two page loads, which on a deadline-ordered list is
 * exactly the tender the user was scrolling towards.
 *
 * `halted` joined the key when B9 pushed stopped tenders below open ones. A
 * cursor minted before that carries two fields; it is read as `halted=false`
 * rather than rejected, so a page-2 request already in flight during the deploy
 * lands on the Divulgada run instead of silently restarting at page 1.
 *
 * ## The sort is in the cursor, and a mismatch restarts the run
 *
 * D51 made the order a choice, and a cursor is only meaningful under the key it
 * was cut from: `(halted, value, id)` compared against a deadline order is not
 * a smaller mistake than no cursor at all, it is the silent-skip failure above.
 * So the sort is written into the cursor and **a cursor that does not name the
 * sort being asked for is discarded** — `decodeCursor` answers `null` and the
 * run starts at page 1.
 *
 * Restarting rather than erroring is the deliberate choice, and the direction of
 * the trade is the point: a restart can only ever show the reader rows they
 * have already seen, while reading the cursor under the wrong key hides rows and
 * says nothing. A `400` was the other candidate and is worse — the only way to
 * reach this state is a request that was already in flight when the order
 * changed, or a hand-edited URL, and neither deserves an error card over a list
 * that works.
 *
 * `deadline` keeps the **exact three-field format it has always had**, so the
 * default order's cursors are byte-identical to the ones in flight today and a
 * page-2 request spanning this deploy still lands where it meant to. Only the
 * value orders carry a tag, and a tag can never be mistaken for the legacy
 * shape: the first field of a deadline cursor is `0` or `1`.
 */
function encodeCursor(row: TenderRow, sort: TenderSort): string {
  const halted = row.halted ? '1' : '0'
  const fields =
    sort === 'deadline'
      ? [
          halted,
          row.proposals_close_at ? new Date(row.proposals_close_at).toISOString() : '',
          row.id,
        ]
      : // `missing` is carried rather than derived from an empty value field,
        // so a tender whose declared value really is `0` and one with no value
        // at all cannot collapse into the same cursor.
        [sort, halted, row.estimated_value === null ? '1' : '0', row.estimated_value ?? '0', row.id]
  return Buffer.from(fields.join('|'), 'utf8').toString('base64url')
}

type Cursor =
  | { sort: 'deadline'; halted: boolean; closeAt: string | null; id: string }
  | { sort: 'valueDesc' | 'valueAsc'; halted: boolean; missing: boolean; value: string; id: string }

/** A plain decimal, which is all `numeric(16,2)` can produce. */
const DECIMAL = /^-?\d+(\.\d+)?$/

function decodeCursor(cursor: string, sort: TenderSort): Cursor | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const parts = raw.split('|')
    const tagged = parts[0] === 'valueDesc' || parts[0] === 'valueAsc'

    // A cursor cut under another order cannot be compared against this one.
    if (tagged ? parts[0] !== sort : sort !== 'deadline') return null

    if (tagged) {
      const [tag, halted, missing, value, id] = parts
      if (!id || parts.length !== 5) return null
      // Validated here rather than trusted into the query: the value reaches
      // SQL as a `::numeric` parameter, and a cursor is a string from the
      // client.
      if (!DECIMAL.test(value ?? '')) return null
      return {
        sort: tag as 'valueDesc' | 'valueAsc',
        halted: halted === '1',
        missing: missing === '1',
        value: value as string,
        id,
      }
    }

    // An id may itself contain no `|` (it is `cnpj-1-sequence/year`), so the
    // field count alone tells the two legacy formats apart.
    const [halted, closeAt, id] =
      parts.length >= 3 ? parts : ['0', parts[0] ?? '', parts[1] ?? '']
    if (!id) return null
    return { sort: 'deadline', halted: halted === '1', closeAt: closeAt || null, id }
  } catch {
    return null
  }
}

/** The cursor's own values, in the same order and with the same arithmetic. */
function cursorKey(cursor: Cursor): SQL[] {
  if (cursor.sort === 'deadline') {
    return [
      sql`${cursor.halted}::boolean`,
      sql`coalesce(${cursor.closeAt}::timestamptz, 'infinity'::timestamptz)`,
      sql`${cursor.id}::text`,
    ]
  }
  // **`::numeric`, not text.** `estimated_value` is `numeric(16,2)` in the
  // column and a string in the row — node-postgres hands numerics over as text
  // so no precision is lost — so this is the one place a value sort could
  // silently become a lexicographic one, putting R$ 9 above R$ 10.
  const value = sql`${cursor.value}::numeric`
  return [
    sql`${cursor.halted}::boolean`,
    sql`${cursor.missing}::boolean`,
    cursor.sort === 'valueDesc' ? sql`-(${value})` : value,
    sql`${cursor.id}::text`,
  ]
}

/** `text[]` for the overlap operator. An empty list must never match. */
function labels(values: string[]): SQL {
  if (values.length === 0) return sql`array[]::text[]`
  return sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`
}

/**
 * The shared `from`/`where` of the list and the counts, plus the `grp` label.
 * One definition, so a filter can never apply to the page and not to the tab
 * count above it.
 */
function scope(match: CompanyMatch, filters: TenderFilters, extra: SQL[] = []): SQL {
  const query = filters.q?.trim() || null
  const conditions: SQL[] = [...extra]

  if (!filters.includeClosed) {
    conditions.push(sql`t.proposals_close_at > now()`)
  }
  if (filters.state) {
    conditions.push(sql`t.state = ${filters.state.toUpperCase()}`)
  }
  if (query) {
    conditions.push(sql`t.search @@ websearch_to_tsquery('pt_unaccent', ${query})`)
  } else {
    // No search term: only tenders the company's CNAEs reach are on the Radar.
    // Everything else would be "every open tender in Brazil", which is the
    // portal the product exists to replace.
    conditions.push(sql`t.segments && ${labels([...match.compatible, ...match.check])}`)
  }

  const where = conditions.length
    ? sql`where ${sql.join(conditions, sql` and `)}`
    : sql``

  return sql`
    from tenders t
    ${where}
  `
}

function groupExpression(match: CompanyMatch): SQL {
  return sql`
    case
      when t.segments && ${labels(match.compatible)} then 'compatible'
      when t.segments && ${labels(match.check)}      then 'check'
      else 'keyword'
    end
  `
}

export type TenderPage = {
  tenders: TenderCard[]
  nextCursor: string | null
  /**
   * The ids on **this page** that `viewerUserId` has marked (card **D23**).
   *
   * A subset of `tenders`, from the same statement as the rows. See
   * {@link favouriteExpression} for why it is one read and not thirteen.
   */
  favourites: string[]
}

/**
 * Has this viewer marked this tender — card **D23**, projected over the page.
 *
 * **One read, which is the whole rule.** D23's store deliberately has no
 * `countFavourites` because the nav badge and the section must come from one
 * query; the list and its stars are the same sentence one level up. Thirteen
 * `GET /api/tenders/:id/favorito` calls would be thirteen answers free to
 * disagree with the list they decorate, and each one a round trip before the
 * star could paint at all.
 *
 * It sits beside `item_count` in the `matched` projection, deliberately — and
 * **what that costs is measured, not assumed.** `explain (analyze)` against
 * production on 2026-10-06 (24 334 open tenders, an account holding four
 * favourites), on the Radar's *default* shape — no search term, so the
 * `segments &&` branch of `scope()` and the index that serves it, which is the
 * plan most readers actually get. 2 155 rows matched, 21 asked for:
 *
 * ```
 *   SubPlan 1  Index Only Scan tender_items_pkey   loops=21   ← item_count
 *   SubPlan 3  Bitmap Heap Scan favourites         loops=1    ← this
 *                Recheck Cond: (user_id = '4'::bigint)
 * ```
 *
 * Two things that plan settles, and both were open questions:
 *
 *  - **The subqueries run after the sort and the limit, not over the match.**
 *    `loops=21` on `item_count` is the page, not the 2 155 matched rows: the
 *    `Sort` orders base columns and the `Result` above it evaluates the target
 *    list for the 21 rows the `Limit` lets through. The claim beside
 *    `item_count` was right, and adding a column here is bounded the same way.
 *  - **`loops=1`, and the correlation is gone from the scan.** The `Recheck
 *    Cond` is `user_id` alone — no `tender_id = t.id` — so Postgres read this
 *    account's `favourites` **once**, hashed them, and answered the `exists`
 *    from the hash. It cost 0.017 ms and two buffer hits for the statement, and
 *    it does not scale with the match count. The hash grows with the account
 *    rather than with the Radar, which is the right direction.
 *
 * `(user_id, tender_id)` being the primary key, plus `favourites_user_recent_idx`
 * on `user_id`, is what makes that one scan a single index read. End to end the
 * projection is inside the run-to-run noise (warm: 15.6 ms with, 12.2 ms
 * without, on a statement whose own `Execution Time` moved 8–16 ms between
 * identical runs), so no figure is claimed for it beyond "not measurable here".
 *
 * No viewer — a visitor, or nobody — projects the constant `false` rather than
 * a subquery against a null id. A favourite is a row keyed on `users.id`; a
 * caller with no account has none, which is not an error and not an empty
 * query.
 */
function favouriteExpression(viewerUserId: number | null): SQL {
  if (viewerUserId === null) return sql`false`
  return sql`exists (
    select 1 from favourites f
     where f.user_id = ${viewerUserId}::bigint and f.tender_id = t.id
  )`
}

export async function listTenders(
  match: CompanyMatch,
  group: TenderGroup,
  filters: TenderFilters,
  database: Executor = db(),
  /**
   * The signed-in reader, for the stars on the cards. `null` for a visitor and
   * on every call that does not need them — the projection is then a constant
   * and the `favourites` table is not touched at all.
   */
  viewerUserId: number | null = null,
): Promise<TenderPage> {
  const limit = Math.min(Math.max(filters.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const sort = filters.sort ?? DEFAULT_SORT
  const cursor = filters.cursor ? decodeCursor(filters.cursor, sort) : null

  // The keyset: the same key the `order by` below uses, compared against the
  // values the previous page's last row wrote into the cursor.
  const after: SQL[] = cursor
    ? [
        sql`(${sql.join(sortKey(sort, IN_SCOPE), sql`, `)}) > (${sql.join(
          cursorKey(cursor),
          sql`, `,
        )})`,
      ]
    : []

  const found = await database.execute<TenderRow>(sql`
    with matched as (
      select t.id, t.object, t.short_title, t.agency_name, t.city, t.state, t.modality_name,
             t.proposals_close_at, t.estimated_value, t.confidential_budget,
             t.price_registration, t.me_epp_summary, t.favored_treatment,
             t.segments, t.updated_at, t.status, t.pncp_updated_at,
             ${HALTED} as halted,
             -- The board's "7 itens" on the card. One indexed count per row of
             -- the page (at most 50), not per row of the tenders table.
             (select count(*) from tender_items i where i.tender_id = t.id) as item_count,
             -- D23's star, from the same read as the row it sits on.
             ${favouriteExpression(viewerUserId)} as favourite,
             ${groupExpression(match)} as grp
        ${scope(match, filters, after)}
    )
    select * from matched
     where grp = ${group}
     order by ${sql.join(sortKey(sort, IN_MATCHED), sql`, `)}
     limit ${limit + 1}
  `)

  const rows = found.rows
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  const nextCursor = rows.length > limit && last ? encodeCursor(last, sort) : null

  return {
    tenders: page.map((row) => toCard(row, match)),
    nextCursor,
    // The page's marked ids, never the whole account's: this is what the cards
    // on screen need, and a star is only ever drawn for a row that is here.
    favourites: page.filter((row) => row.favourite === true).map((row) => row.id),
  }
}

export async function countGroups(
  match: CompanyMatch,
  filters: TenderFilters,
  database: Executor = db(),
): Promise<Record<TenderGroup, number>> {
  const found = await database.execute<{ grp: TenderGroup; n: string | number }>(sql`
    select ${groupExpression(match)} as grp, count(*) as n
      ${scope(match, filters)}
     group by 1
  `)
  const counts: Record<TenderGroup, number> = { compatible: 0, check: 0, keyword: 0 }
  for (const row of found.rows) counts[row.grp] = Number(row.n)
  return counts
}

function toCard(row: TenderRow, match: CompanyMatch): TenderCard {
  const segments = row.segments ?? []
  return {
    id: row.id,
    object: row.object,
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
    group: row.grp,
    status: row.status,
    pncpUpdatedAt: row.pncp_updated_at
      ? new Date(row.pncp_updated_at).toISOString()
      : null,
  }
}

/**
 * How old the list is, and why nothing is enqueued when it is stale.
 *
 * §3.2 gives open tenders 30 minutes, kept by `sync_open_tenders` on a
 * 30-minute schedule. That job is the **scheduler's**: its key is the due
 * instant in Brasília (`licitaqui/scheduler.py`) and its payload is empty
 * because the window comes from a watermark the previous cycle wrote. A web
 * route inventing a key for it would add a second sweep with no watermark
 * relationship to the first — the one case where enqueuing is worse than
 * waiting, since a stale list is at most thirty minutes old and the sweep is
 * already coming.
 *
 * So this reports `fresh` or `stale` honestly and enqueues nothing. The
 * `absent` branch — a database with no open tenders at all — is a fresh deploy
 * or a broken worker, and is surfaced to the caller rather than papered over.
 */
export async function listFreshness(
  filters: Pick<TenderFilters, 'state'>,
  options: { executor?: Executor; now?: Date } = {},
): Promise<Cached<{ newestUpdatedAt: Date }>> {
  return readOrEnqueue<{ newestUpdatedAt: Date }>({
    read: async (executor) => {
      const found = await executor.execute<{ newest: Date | string | null }>(sql`
        select max(updated_at) as newest
          from tenders
         where proposals_close_at > now()
           ${filters.state ? sql`and state = ${filters.state.toUpperCase()}` : sql``}
      `)
      const newest = found.rows[0]?.newest
      if (!newest) return null
      return { data: { newestUpdatedAt: new Date(newest) }, updatedAt: new Date(newest) }
    },
    ttl: TTL.openTenderList,
    // Never used: `enqueue: false`. Named anyway so the shape of the call says
    // which job would have refreshed this, for whoever reads it next.
    refresh: { kind: JOB_KINDS.syncItems, key: 'unused' },
    enqueue: false,
    executor: options.executor,
    now: options.now,
  })
}
