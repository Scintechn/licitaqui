import { sql } from 'drizzle-orm'
import { PERMANENT, readOrEnqueue, TTL, type Cached, type CacheRead } from '@/lib/cache'
import { db, type Executor } from '@/lib/db'
import { JOB_KINDS, syncItemsJobKey } from '@/lib/jobs'
import type { SegmentFit, TenderDetail, TenderFileView, TenderItemView } from './contract'

/**
 * One tender: header, items, and — only with an account — its files
 * (spec §8 `GET /api/tenders/:id`).
 *
 * ## Which TTL
 *
 * §3.2 gives the header 6 h and the items 12 h while the tender is open, and
 * **permanent** once it closes. A closed tender cannot change: the agency has
 * stopped receiving proposals, so re-reading it from PNCP spends a request to
 * learn nothing, and this is the single largest saving in the cache design —
 * most of the tenders a user ever opens are already closed.
 *
 * The page needs both header and items, so the row's age is the *older* of the
 * two: `least(t.updated_at, min(i.updated_at))`. Serving a 6-hour-old header
 * beside two-day-old items and calling the pair fresh is how a stale-while-
 * revalidate cache quietly stops revalidating.
 *
 * ## Which job
 *
 * `sync_items`, keyed on the bare tender id — the key
 * `licitaqui.sync_tenders._enqueue_followups` uses, so a refresh this route
 * queues and a follow-up the sweep queues de-duplicate against each other. It
 * re-reads the items from PNCP and rolls `me_epp_summary`, `favored_treatment`,
 * `segments` and the `search` vector back onto the tender, which is everything
 * this page shows except the header fields the sweep itself owns.
 *
 * There is deliberately **no** per-tender header job: none exists in §7.1, and
 * inventing a kind the worker has no handler for would queue rows that fail
 * four times over forty minutes and land in `failed`.
 *
 * ## A tender we have never seen
 *
 * `sync_items` logs "unknown tender, nothing to do" when the row is missing —
 * it cannot create one, because the header comes from the sweep. So an unknown
 * id is a `404`, not a `202`: answering "analyzing" would promise a screen that
 * would poll for sixty seconds and then show nothing.
 */

type HeaderRow = {
  id: string
  agency_cnpj: string
  object: string
  agency_name: string | null
  unit_name: string | null
  city: string | null
  state: string | null
  modality_name: string | null
  status: string | null
  price_registration: boolean | null
  proposals_open_at: Date | string | null
  proposals_close_at: Date | string | null
  estimated_value: string | null
  confidential_budget: boolean | null
  bidding_system_url: string | null
  me_epp_summary: string | null
  favored_treatment: boolean | null
  segments: string[] | null
  updated_at: Date | string
  /** The older of the header and the oldest item — see the note above. */
  cache_updated_at: Date | string
  closed: boolean
}

type ItemRow = {
  number: number
  description: string | null
  kind: string | null
  quantity: string | null
  unit: string | null
  unit_estimated_value: string | null
  total_value: string | null
  ncm: string | null
  judgment_criterion: string | null
  benefit_id: number | null
  benefit_name: string | null
  segment: string | null
  relevance: string | null
  has_award: boolean | null
}

type FileRow = {
  sequence: number
  title: string | null
  doc_type: string | null
  url: string | null
  published_at: Date | string | null
  pages: number | null
  no_text: boolean | null
}

export type TenderReadOptions = {
  /** §8: "files only with an account". */
  withFiles: boolean
  /** The viewer's segments, so each card can say how it matched. */
  fits?: SegmentFit[]
}

export async function readTender(
  tenderId: string,
  options: TenderReadOptions,
  database: Executor = db(),
): Promise<CacheRead<TenderDetail> | null> {
  const header = await database.execute<HeaderRow>(sql`
    select t.id, t.agency_cnpj, t.object, t.agency_name, t.unit_name, t.city, t.state,
           t.modality_name, t.status, t.price_registration, t.proposals_open_at,
           t.proposals_close_at, t.estimated_value, t.confidential_budget,
           t.bidding_system_url, t.me_epp_summary, t.favored_treatment, t.segments,
           t.updated_at,
           least(t.updated_at, coalesce((select min(i.updated_at) from tender_items i
                                          where i.tender_id = t.id), t.updated_at))
             as cache_updated_at,
           (t.proposals_close_at is not null and t.proposals_close_at <= now()) as closed
      from tenders t
     where t.id = ${tenderId}
  `)
  const row = header.rows[0]
  if (!row) return null

  const items = await database.execute<ItemRow>(sql`
    select number, description, kind, quantity, unit, unit_estimated_value, total_value,
           ncm, judgment_criterion, benefit_id, benefit_name, segment, relevance, has_award
      from tender_items
     where tender_id = ${tenderId}
     order by number
  `)

  // The list is not merely hidden behind a locked block in the UI: the request
  // never asks for it, so an unauthenticated response cannot carry the URLs.
  const files = options.withFiles
    ? await database.execute<FileRow>(sql`
        select sequence, title, doc_type, url, published_at, pages, no_text
          from tender_files
         where tender_id = ${tenderId} and coalesce(active, true)
         order by sequence
      `)
    : null

  const segments = row.segments ?? []
  const fits = options.fits ?? []

  const detail: TenderDetail = {
    id: row.id,
    agencyCnpj: row.agency_cnpj,
    object: row.object,
    agencyName: row.agency_name,
    unitName: row.unit_name,
    city: row.city,
    state: row.state,
    modalityName: row.modality_name,
    status: row.status,
    priceRegistration: Boolean(row.price_registration),
    proposalsOpenAt: row.proposals_open_at ? new Date(row.proposals_open_at).toISOString() : null,
    proposalsCloseAt: row.proposals_close_at
      ? new Date(row.proposals_close_at).toISOString()
      : null,
    estimatedValue: row.estimated_value,
    confidentialBudget: Boolean(row.confidential_budget),
    biddingSystemUrl: row.bidding_system_url,
    meEppSummary: row.me_epp_summary,
    favoredTreatment: row.favored_treatment,
    segments,
    matchedSegments: fits.filter((fit) => segments.includes(fit.segment)),
    // A detail page is opened from a group, so the card's group is the caller's
    // to know; on its own the tender has no group.
    group: 'keyword',
    items: items.rows.map(toItem),
    files: files ? files.rows.map(toFile) : null,
    closed: Boolean(row.closed),
  }

  return {
    data: detail,
    updatedAt: new Date(row.cache_updated_at),
    // §3.2: permanent after closing. Nothing to refresh, so nothing is queued.
    ttl: detail.closed ? PERMANENT : TTL.tenderItems,
  }
}

export async function tenderOrRefresh(
  tenderId: string,
  options: TenderReadOptions & { executor?: Executor; now?: Date },
): Promise<Cached<TenderDetail>> {
  return readOrEnqueue<TenderDetail>({
    read: (executor) => readTender(tenderId, options, executor),
    ttl: TTL.tenderItems,
    refresh: {
      kind: JOB_KINDS.syncItems,
      key: syncItemsJobKey(tenderId),
      payload: { tender_id: tenderId },
    },
    // An id we hold no header for cannot be fetched by `sync_items` — it reads
    // `tenders` and returns when the row is missing. So `absent` queues nothing
    // and the route answers 404 rather than a promise it cannot keep.
    enqueueWhenAbsent: false,
    executor: options.executor,
    now: options.now,
  })
}

function toItem(row: ItemRow): TenderItemView {
  return {
    number: Number(row.number),
    description: row.description,
    kind: row.kind,
    quantity: row.quantity,
    unit: row.unit,
    unitEstimatedValue: row.unit_estimated_value,
    totalValue: row.total_value,
    ncm: row.ncm,
    judgmentCriterion: row.judgment_criterion,
    benefitId: row.benefit_id === null ? null : Number(row.benefit_id),
    benefitName: row.benefit_name,
    segment: row.segment,
    relevance: row.relevance,
    hasAward: row.has_award,
  }
}

function toFile(row: FileRow): TenderFileView {
  return {
    sequence: Number(row.sequence),
    title: row.title,
    docType: row.doc_type,
    url: row.url,
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
    pages: row.pages === null ? null : Number(row.pages),
    noText: Boolean(row.no_text),
  }
}
