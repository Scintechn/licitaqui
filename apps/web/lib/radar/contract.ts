import type { LockedEvidence, PriceBand, PriceEvidence } from './price-band'

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

/**
 * The order the list is read in — `?sort=` on `/radar` and on
 * `GET /api/radar/tenders` (D51).
 *
 * Sci, 2026-10-06: *"The sort can be by Value (Asc/Desc); By Time (prazo)."*
 * Three orders, no more: `deadline` is what the list has always done and stays
 * the default, and the two value orders are the new choice.
 *
 * **`deadline` is the absent value**, not a fourth state. Unlike `group` —
 * where "nothing chosen" is a real, distinguishable intent that `bestGroup()`
 * resolves from the counts — there is nothing for the product to elect here:
 * a list has to come back in some order and the honest default is the one the
 * screen has always shown. So `readSort()` never answers `null`, and
 * `radarHref()` leaves `sort=deadline` out of the URL, which keeps every
 * address the product already draws byte-identical.
 */
export const TENDER_SORTS = ['deadline', 'valueDesc', 'valueAsc'] as const
export type TenderSort = (typeof TENDER_SORTS)[number]

/** Absent means this one, everywhere: URL, API and `listKey`. */
export const DEFAULT_SORT: TenderSort = 'deadline'

export type TenderCard = {
  id: string
  object: string
  /**
   * The short, human title the worker writes to `tenders.short_title` — two
   * to eight words, deterministic where the object allows it and from the
   * model where it does not.
   *
   * `null` until the hourly sweep reaches a newly ingested tender (3.8% of
   * production at the time of writing), so every screen falls back to
   * `tenderTitle(object)`. Never blank: the worker's validator rejects an
   * empty or unfit title rather than storing one.
   */
  shortTitle: string | null
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
  /**
   * How many items the tender has — the board's "7 itens", next to the value
   * on both the Radar card and the Opportunity header. `null` when the items
   * have not been synced yet, which is different from a tender with no items.
   */
  itemCount: number | null
  segments: string[]
  /** The segments of this tender the company matched, and how. */
  matchedSegments: SegmentFit[]
  group: TenderGroup
  /**
   * `situacaoCompraNome`, verbatim: `Divulgada no PNCP` | `Suspensa` |
   * `Revogada` | `Anulada`.
   *
   * On the **card** and not only on the detail, because legal brief §2.2 rule
   * 6 makes this a state of the screen rather than a fact about the tender:
   * the Radar list counts down too, and a countdown on a suspended tender is
   * the same false claim there as on the Opportunity screen. Read it through
   * `lib/radar/tender-status.ts`, never by comparing strings at a call site.
   */
  status: string | null
  /**
   * `dataAtualizacaoGlobal` — when the **agency** last touched the record,
   * which is the date the status banner cites. Not `updated_at`, which is when
   * *our* sweep last read it and would date a suspension to our own cron.
   */
  pncpUpdatedAt: string | null
}

/**
 * The company this list was **actually grouped by** (D19).
 *
 * The header used to compute its own answer from whatever company the screen
 * happened to hold, while the route resolved the CNPJ as
 * `?cnpj= ?? visitors.cnpj` and grouped on *that* company's segments. With no
 * `?cnpj=` in the URL the screen held `null` and rendered *"sem CNAE lido"*
 * directly above *"Compatíveis 13"* and *"seu CNAE atende"* — two sources, and
 * the one asserting a match was the false one.
 *
 * So the route says what it did. This field is the single supplier of every
 * fact in that header, and the cookie CNPJ — which the browser cannot read,
 * because it is `httpOnly` — becomes visible to the screen for the first time.
 *
 * Three states, all of them real:
 *
 * | | |
 * |---|---|
 * | `null` | no CNPJ drove the list at all: a keyword search, and every row is `keyword` |
 * | `company: null` | a CNPJ drove it (query or cookie) and nothing has been read for it yet |
 * | `company` set | that company's segments are what `compatible` and `check` were computed from |
 *
 * **There is deliberately no `cnpj` field.** It was the obvious thing to put
 * here and it would have been the only CNPJ this product sends to page
 * JavaScript that the page did not already know: `visitors.cnpj` reaches the
 * route through an `httpOnly` cookie precisely so the browser cannot read it,
 * and the client snapshot in `list-cache.ts` would then have written it into
 * `sessionStorage`. §12 puts a CNPJ in the same bucket as a CPF. Nothing in the
 * header needs it — *whether* a CNPJ drove the list is `groupedBy !== null`, and
 * when the company has been read its own `CompanyView.cnpj` is already on the
 * wire because the browser typed it.
 */
export type GroupedBy = {
  /** `null` when `companies` holds no row for it yet. */
  company: CompanyView | null
  /**
   * CNAEs on record — main plus secondary, deduplicated — **not** segments.
   * `radar.list.cnaeCount` says "CNAEs"; this is what it counts.
   */
  cnaeCount: number
}

export type TenderListOk = {
  state: 'ready'
  group: TenderGroup
  tenders: TenderCard[]
  /**
   * Which of `tenders` this caller has already marked (card **D23**).
   *
   * **A field on the envelope rather than on `TenderCard`**, because the card
   * is shared with the Landing's "Exemplo" panel and `/conta/favoritos`, and
   * neither has a viewer whose marks it could be describing. It is a fact
   * about this reader and this page, not about the tender.
   *
   * Ids, not booleans in row order: order is the one thing a list is free to
   * change, and an array of flags positioned against another array is a defect
   * waiting for a sort to land.
   *
   * It comes from the **same read as the rows** — one `exists` projected over
   * the page in `listTenders` — which is D23's rule restated one level up. A
   * second request per card would be thirteen answers free to disagree with
   * the one list they are describing. Empty for a visitor: a favourite is a
   * row keyed on `users.id`, so somebody without an account has none rather
   * than an error.
   */
  favourites: string[]

  /** The company the groups above were computed from. `null` means none. */
  groupedBy: GroupedBy | null
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

/**
 * `GET /api/tenders/:id/band?item=N` (E9).
 *
 * `band: null` on a `ready` response is the **normal** answer, not a failure:
 * roughly 1% of open items have enough comparable awards to clear the gate in
 * `price-band.ts`. Modelled as ready-with-null rather than as an error so the
 * client does not retry an ordinary outcome.
 */
export type BandResponse =
  | {
      state: 'ready'
      band: PriceBand | null
      /**
       * What was found when it was not enough for a band (E22).
       *
       * **Free at every rung, and that is deliberate.** Sci's ruling,
       * 2026-10-01: raw evidence free, computation paid. The matched results
       * are public PNCP records of closed tenders; the band's quartiles and
       * the preço-alvo are the work. It rides on `locked` as well, so the
       * ladder is monotonic — gating it at five and not below would show a
       * non-subscriber *less* at four editais than at three.
       *
       * Present whenever any comparable survives, including alongside a band:
       * at five editais it is the context, and below five it is the whole
       * message.
       */
      evidence: PriceEvidence | null
      /*
       * **There is deliberately no `entitled` here.**
       *
       * There was, briefly. An unentitled caller on an item with no band gets
       * `ready` with `band: null`, exactly like a subscriber does, so the
       * screen could not tell them apart and the first plan CTA hid the
       * upsell from the very people it exists for. Carrying `entitled` on
       * `ready` fixed that and created a second problem: entitlement then had
       * two sources, one of them 412 ms away behind a trigram join, which is
       * why the CTA appeared late and vanished on every item chip.
       *
       * Entitlement is now read **once, on the server**, in the page that
       * renders the screen, and passed down as a prop — correct on first
       * paint, correct on a tender with no items to ask about, and never
       * waiting on this request. See `readPriceBandEntitlement`.
       */
    }
  /**
   * The caller's plan does not include the band (E9, `hasPriceBand`).
   *
   * Distinct from `ready` with `band: null`, and the distinction is the whole
   * point: *locked* means a number exists and this plan does not include it,
   * which is what `LockedValue` is honestly for. *Empty* means no number
   * exists for anybody. Collapsing them would either promise a subscriber
   * something that is not there, or tell a visitor nothing is there when the
   * truth is that they have not paid for it.
   */
  | {
      state: 'locked'
      /**
       * **`LockedEvidence`, not `PriceEvidence`** — the count and what was
       * matched, with no price field at all (Sci, 2026-10-02).
       *
       * A `locked` answer is sent if and only if a band exists, and at five
       * editais the four sampled prices rebuild it: the quartiles of five
       * sorted values are `sorted[1..3]`, so four of them give two figures
       * exactly and bracket the third. Sending `PriceEvidence` here handed back
       * the thing the state exists to withhold.
       *
       * The narrower type is the enforcement. `value` is not a nullable field
       * somebody must remember to clear — it does not exist on this branch, so
       * a leak is a compile error rather than a review finding.
       */
      evidence: LockedEvidence | null
    }
  | { state: 'error'; error: ErrorCode; fields?: Record<string, string> }

export type TenderDetail = TenderCard & {
  agencyCnpj: string
  unitName: string | null
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

/**
 * Whether this tender already has an AI reading, and whether *this* caller has
 * paid for it — so the Opportunity screen can name its own button.
 *
 * On the response rather than inside `TenderDetail`, the way `freshness` is:
 * `TenderDetail` extends `TenderCard`, which is shared tender data, and `spent`
 * is a fact about the viewer. `ai_analyses` has no `user_id` at all (§3.2: the
 * analysis is shared), which is exactly why these are two fields.
 */
export type ScreeningAvailability = {
  /** A reading of the edital **as it stands now** exists. */
  ready: boolean
  /** This caller already spent a screening on this tender, so opening is free. */
  spent: boolean
  /**
   * Whether this caller's plan meters triagens at all.
   *
   * `plan_limits` stores `quantity = null` for `promocional`, `essencial` and
   * `pro` — unlimited. Without this field the screen printed *"Usa 1 das suas
   * triagens"* to every founder who had just paid for a plan whose own feature
   * list says *"Triagens de edital sem limite"*. The route already reads the
   * limit; it simply never said so.
   */
  metered: boolean
}

export type TenderOk = {
  state: 'ready'
  tender: TenderDetail
  freshness: Freshness
  screening: ScreeningAvailability
  /**
   * The compatibility checklist (D26), computed server-side because the edital
   * screen does not have the reading and must not be sent it.
   *
   * It is always present: before any triagem it is the three PNCP rows
   * answered and seven `unknown`, which is the state that shows a reader what
   * a triagem would buy.
   */
  checklist: Checklist
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
  /**
   * The same banner the Radar shows (canvas 02 and 04): how long the free
   * window has left and how many screenings are in it. `null` once the caller
   * has an account (task U1) — the banner is a visitor-only affordance.
   */
  visitor?: VisitorView | null
}

export type ScreeningQueued = Analyzing & {
  quota: QuotaView
  visitor?: VisitorView | null
}

export type ScreeningResponse = ScreeningOk | ScreeningQueued | ApiError

/**
 * `GET /api/tenders/:id/screening` — the poll, not the request.
 *
 * `POST` is what checks the quota, charges it and enqueues the job; this reads
 * the row the worker writes, for a caller who has already paid for this exact
 * tender. It therefore adds a fourth answer to the three above: `pending`, the
 * honest "you asked, nothing is written yet" that a `GET` has to be able to
 * say without inventing a job it did not enqueue.
 */
export type ScreeningPending = {
  state: 'pending'
  tenderId: string
  quota: QuotaView
  visitor?: VisitorView | null
}

export type ScreeningReadResponse = ScreeningOk | ScreeningPending | ApiError

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

// ─────────────────────────── the compatibility checklist ─────────────────────

/**
 * The fixed set of conditions a small company is judged on (D26).
 *
 * **Fixed, and that is the whole point.** The block canvas 11 draws says "N de
 * M conferidos", and a denominator invented per tender is not a measurement —
 * it would shrink on the editais that answer least, which is exactly backwards.
 * So the set is declared here, the same for every tender, and a condition this
 * product cannot read does not join it.
 *
 * The first three are answered by **PNCP's structured fields**, before anybody
 * pays for anything. The rest need the edital read, which is what a triagem
 * buys — and that is the honest answer to *"what did my R$ 75 get me"*: the
 * same list, seven rows further on.
 *
 * `deliveryPlace` is here deliberately, and it is not the thing D26's card
 * warns against. The card says not to invent a locality check, because
 * `comparablesForItem` has no UF predicate and *"na sua região"* was removed
 * from the price copy for that reason. This row is a different claim: the
 * worker reads `entrega.local` out of the edital with a page citation, like
 * any other finding. Where delivery happens is read; whether a company can
 * serve it is not asserted by anybody.
 */
export const CHECKLIST_KEYS = [
  'cnae',
  'meEpp',
  'deadline',
  'technicalCertificate',
  'minimumCapital',
  'guarantee',
  'sample',
  'siteVisit',
  'consortium',
  'deliveryPlace',
] as const

export type ChecklistKey = (typeof CHECKLIST_KEYS)[number]

/**
 * Three states, never two — **and only two of them ship today.**
 *
 * `blocker` is declared because it is what this block means and D27 draws
 * against it, and **nothing emits it yet**: joining a barrier to a row needs
 * the worker to name which condition each barrier is about, and the prompt
 * change that would do it was measured against the evaluation gate and failed
 * it. `lib/radar/checklist.ts` has the numbers and **D35** carries the work.
 * A test asserts no row is ever `blocker`, so the gap cannot quietly become
 * "no edital has barriers".
 *
 * `unknown` is the one that has to exist. The board's own prose concedes it —
 * *"o que daqui não dá para saber: sua regularidade fiscal e o que a comissão
 * vai decidir"* — and a two-colour meter buries it, turning "we did not read
 * this" into "this is fine". A row is `unknown` before a triagem and stays
 * `unknown` if the reading could not answer it.
 */
export type ChecklistState = 'ok' | 'blocker' | 'unknown'

/**
 * Where a row's answer came from.
 *
 * A value read from a structured PNCP field and a sentence read out of a PDF
 * with a page citation are not the same kind of true, and one fraction over
 * both asserts that they are. The row carries which it is so the screen can
 * say so.
 */
export type ChecklistSource = 'pncp' | 'ai'

export type ChecklistRow = {
  key: ChecklistKey
  state: ChecklistState
  source: ChecklistSource
  /** The edital page this was read from. `null` for every `pncp` row. */
  page: number | null
  /** `true` when the worker's citation check could not confirm that page. */
  pageUnverified: boolean
}

export type Checklist = {
  /** Every key, always, in `CHECKLIST_KEYS` order. */
  rows: ChecklistRow[]
  /** Rows that are not `unknown`. The numerator. */
  checked: number
  /** `rows.length`. Constant, by design — see `CHECKLIST_KEYS`. */
  total: number
}
