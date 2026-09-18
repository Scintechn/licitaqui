import { sql, type SQL } from 'drizzle-orm'
import { readOrEnqueue, TTL, type Cached } from '@/lib/cache'
import { db, type Executor } from '@/lib/db'
import { JOB_KINDS } from '@/lib/jobs'
import type { SegmentFit, TenderCard, TenderGroup } from './contract'

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
  grp: TenderGroup
  updated_at: Date | string
}

/**
 * A keyset cursor over the sort key `(proposals_close_at, id)`.
 *
 * Offset pagination would skip or repeat a tender every time the 30-minute
 * sweep inserts one between two page loads, which on a deadline-ordered list is
 * exactly the tender the user was scrolling towards.
 */
function encodeCursor(row: TenderRow): string {
  const closeAt = row.proposals_close_at ? new Date(row.proposals_close_at).toISOString() : ''
  return Buffer.from(`${closeAt}|${row.id}`, 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): { closeAt: string | null; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const separator = raw.indexOf('|')
    if (separator < 0) return null
    const closeAt = raw.slice(0, separator)
    const id = raw.slice(separator + 1)
    if (!id) return null
    return { closeAt: closeAt || null, id }
  } catch {
    return null
  }
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
}

export async function listTenders(
  match: CompanyMatch,
  group: TenderGroup,
  filters: TenderFilters,
  database: Executor = db(),
): Promise<TenderPage> {
  const limit = Math.min(Math.max(filters.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
  const cursor = filters.cursor ? decodeCursor(filters.cursor) : null

  // Nulls last on both the order and the cursor: a tender with no deadline is
  // not urgent, and `null > anything` would otherwise put it first.
  const after: SQL[] = cursor
    ? [
        sql`(
          coalesce(t.proposals_close_at, 'infinity'::timestamptz),
          t.id
        ) > (
          coalesce(${cursor.closeAt}::timestamptz, 'infinity'::timestamptz),
          ${cursor.id}::text
        )`,
      ]
    : []

  const found = await database.execute<TenderRow>(sql`
    with matched as (
      select t.id, t.object, t.agency_name, t.city, t.state, t.modality_name,
             t.proposals_close_at, t.estimated_value, t.confidential_budget,
             t.price_registration, t.me_epp_summary, t.favored_treatment,
             t.segments, t.updated_at,
             ${groupExpression(match)} as grp
        ${scope(match, filters, after)}
    )
    select * from matched
     where grp = ${group}
     order by coalesce(proposals_close_at, 'infinity'::timestamptz), id
     limit ${limit + 1}
  `)

  const rows = found.rows
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  const nextCursor = rows.length > limit && last ? encodeCursor(last) : null

  return { tenders: page.map((row) => toCard(row, match)), nextCursor }
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
    segments,
    matchedSegments: match.fits.filter((fit) => segments.includes(fit.segment)),
    group: row.grp,
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
