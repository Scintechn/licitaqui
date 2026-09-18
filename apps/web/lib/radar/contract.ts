/**
 * The wire contract of the Radar routes (spec §8).
 *
 * Pure types and codes: the browser imports this file, so no Drizzle, no `pg`
 * and no copy. Every string a person reads is looked up in
 * `messages.radar.*` from the code the API returns — the API never carries
 * Portuguese.
 *
 * ## The three states, everywhere
 *
 * Each read route answers with the same envelope, because each one goes through
 * `readOrEnqueue()` (§3.1): `ready` with data, `analyzing` with a job to poll.
 * A screen that can render those two can render every Radar route, and the
 * "analyzing" state the design system already draws is wired once.
 */

/** §3.1: how old what we served is, and what is being done about it. */
export type Freshness = {
  /** `fresh` or `stale`. `stale` means a refresh is already queued. */
  state: 'fresh' | 'stale'
  /** ISO 8601. `null` when the row does not record when it was written. */
  updatedAt: string | null
  /** Whole seconds since `updatedAt` — the "atualizado há X min" line. */
  ageSeconds: number | null
}

/** The job a `202` hands back, for `GET /api/jobs/:id`. */
export type JobRef = {
  /** `null` when an identical job was already queued or running. Poll anyway. */
  id: number | null
  kind: string
}

export type Analyzing = {
  state: 'analyzing'
  job: JobRef
}

export type ErrorCode =
  | 'validation'
  | 'bad_request'
  | 'not_found'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'visitor_expired'
  | 'account_required'
  | 'server_error'

export type ApiError = {
  state: 'error'
  error: ErrorCode
  /** `{ cnpj: 'cnpjInvalid' }` — keys under `messages.radar.errors`. */
  fields?: Record<string, string>
  /** Set on `quota_exceeded`: what the plan allows and what is left. */
  quota?: QuotaView
}

// ───────────────────────── POST /api/radar/cnpj ─────────────────────────

/** One of POC 1's 14 segments, with how well the company's CNAEs fit it. */
export type SegmentFit = {
  segment: string
  fit: 'compatible' | 'check'
  /** The fit came from the main CNAE, which is what allows `compatible`. */
  fromMainCnae: boolean
  fromSecondaryCnae: boolean
}

export type CompanyView = {
  /** 14 digits. The browser already knows it — it typed it. */
  cnpj: string
  legalName: string | null
  tradeName: string | null
  mainCnae: string | null
  size: string | null
  isMei: boolean | null
  state: string | null
  city: string | null
  /** Sorted: compatible first, main CNAE first, then alphabetically. */
  segments: SegmentFit[]
}

/** What the visitor (no account) has left, per §10 and `plan_limits`. */
export type VisitorView = {
  /** ISO 8601 — `visitors.created_at` plus the 3-day window. */
  expiresAt: string
  expired: boolean
  screeningsUsed: number
  /** `null` means unlimited. */
  screeningsLeft: number | null
}

export type CnpjOk = {
  state: 'ready'
  company: CompanyView
  freshness: Freshness
  visitor: VisitorView | null
  /**
   * BrasilAPI has no SLA (§9) and answered "not found" or not at all, so the
   * row has no CNAEs. The Radar must ask the user to pick their CNAE by hand
   * rather than show an empty list of segments.
   */
  manualCnae: boolean
}

export type CnpjResponse = CnpjOk | Analyzing | ApiError

// ──────────────────────── GET /api/radar/tenders ────────────────────────

/**
 * §8: "groups Compatible / Check / Keyword".
 *
 * `compatible` — a tender in a segment the company's **main** CNAE covers.
 * `check` — a segment reached through a secondary CNAE, or a main CNAE the map
 * itself rates as arguable. `keyword` — it matched what the user typed and none
 * of their CNAEs; without a search term the group is empty by construction.
 */
export const TENDER_GROUPS = ['compatible', 'check', 'keyword'] as const
export type TenderGroup = (typeof TENDER_GROUPS)[number]

export type TenderCard = {
  id: string
  object: string
  agencyName: string | null
  city: string | null
  state: string | null
  modalityName: string | null
  /** ISO 8601. The deadline the card counts down to. */
  proposalsCloseAt: string | null
  /** A decimal string: money is never a float on this wire. */
  estimatedValue: string | null
  confidentialBudget: boolean
  priceRegistration: boolean
  /** exclusive | quota | mixed | none. */
  meEppSummary: string | null
  favoredTreatment: boolean | null
  segments: string[]
  /** The segments of this tender the company matched, and how. */
  matchedSegments: SegmentFit[]
  group: TenderGroup
}

export type TenderListOk = {
  state: 'ready'
  group: TenderGroup
  tenders: TenderCard[]
  /** How many are in each group under the same filters — the tab counts. */
  counts: Record<TenderGroup, number>
  /** Opaque; pass back as `cursor` for the next page. `null` at the end. */
  nextCursor: string | null
  /** Freshness of the tender list as a whole, i.e. of the 30-minute sweep. */
  freshness: Freshness
}

export type TenderListResponse = TenderListOk | Analyzing | ApiError

// ───────────────────────── GET /api/tenders/:id ─────────────────────────

export type TenderItemView = {
  number: number
  description: string | null
  /** M(aterial) | S(ervice). */
  kind: string | null
  quantity: string | null
  unit: string | null
  unitEstimatedValue: string | null
  totalValue: string | null
  ncm: string | null
  judgmentCriterion: string | null
  benefitId: number | null
  benefitName: string | null
  segment: string | null
  relevance: string | null
  hasAward: boolean | null
}

export type TenderFileView = {
  sequence: number
  title: string | null
  docType: string | null
  url: string | null
  publishedAt: string | null
  pages: number | null
  /** A scanned PDF: there is no text to screen (§7.2). */
  noText: boolean
}

export type TenderDetail = TenderCard & {
  agencyCnpj: string
  unitName: string | null
  status: string | null
  proposalsOpenAt: string | null
  biddingSystemUrl: string | null
  items: TenderItemView[]
  /**
   * §8: "files only with an account". `null` — not `[]` — is the locked block
   * the design system draws; an empty array would mean the agency published
   * nothing.
   */
  files: TenderFileView[] | null
  /** True when proposals have closed: the row is then permanent (§3.2). */
  closed: boolean
}

export type TenderOk = {
  state: 'ready'
  tender: TenderDetail
  freshness: Freshness
}

export type TenderResponse = TenderOk | Analyzing | ApiError

// ───────────────── POST /api/tenders/:id/screening ─────────────────

export type QuotaView = {
  feature: string
  /** visitor | basico | promocional | essencial | pro. */
  plan: string
  /** total | month | week | null. */
  period: string | null
  /** `null` means unlimited (`plan_limits.quantity is null`). */
  limit: number | null
  used: number
  /** `null` when unlimited. */
  left: number | null
}

export type ScreeningOk = {
  state: 'ready'
  tenderId: string
  /** ok | no_text. `no_text` is a scanned PDF, not a failure to answer. */
  status: 'ok' | 'no_text'
  result: unknown
  citationCheck: unknown
  rules: unknown
  /** When the analysis was produced. It is shared across users (§3.2). */
  createdAt: string
  quota: QuotaView
}

export type ScreeningQueued = Analyzing & { quota: QuotaView }

export type ScreeningResponse = ScreeningOk | ScreeningQueued | ApiError

// ───────────────────────── GET /api/jobs/:id ─────────────────────────

export type JobResponse =
  | {
      state: 'ready'
      job: {
        id: number
        kind: string
        status: 'queued' | 'running' | 'done' | 'failed'
        attempts: number
        createdAt: string
        updatedAt: string
      }
    }
  | ApiError
