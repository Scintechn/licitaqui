import {
  bigint,
  boolean,
  char,
  customType,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Drizzle definitions for the tables the web app reads and writes. They mirror
 * `db/migrations/0001_initial.sql` (spec §6.1–6.3) and are deliberately
 * partial: the schema is owned by `db/migrations`, so nothing here may drift
 * from it and nothing here creates or alters a table. Columns are named
 * explicitly rather than inferred, so a rename in one place can never silently
 * rename the other.
 *
 * F1 added the three tables the founders flow needs. R1 added the Radar's,
 * which A3 deliberately left to the card that first reads them.
 *
 * Two conventions worth knowing before adding to this file:
 *
 *  - **`bigint` comes back as a string.** `mode: 'number'` tells Drizzle to
 *    parse it, which is safe for identity columns and row counts and wrong for
 *    anything that could exceed 2^53.
 *  - **`numeric` stays a string.** `tenders.estimated_value` is money; turning
 *    it into a float here would round it before it ever reached a screen. The
 *    contract types carry it as a string and the browser formats it.
 */

/**
 * `citext` — case-insensitive text, the type `founders_list.email` uses so that
 * `Maria@empresa.com` and `maria@empresa.com` are the same founder.
 */
const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
})

export const foundersList = pgTable('founders_list', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  name: text('name').notNull(),
  email: citext('email').notNull().unique(),
  whatsapp: text('whatsapp'),
  cnpj: char('cnpj', { length: 14 }),
  sells: text('sells'),
  /** utm_source, influencer or coupon — never anything that identifies a person. */
  source: text('source'),
  /** 1..48 gets the founder price; null means the waitlist. */
  seat: integer('seat').unique(),
  contactConsent: boolean('contact_consent').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const jobs = pgTable('jobs', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  kind: text('kind').notNull(),
  key: text('key').notNull(),
  priority: integer('priority').notNull().default(5),
  payload: jsonb('payload'),
  status: text('status').notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const events = pgTable('events', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  userId: bigint('user_id', { mode: 'number' }),
  visitorId: uuid('visitor_id'),
  name: text('name').notNull(),
  props: jsonb('props'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ───────────────────────────── §6.1 PNCP cache ─────────────────────────────

/**
 * `tsvector` — `tenders.search`, a `pt_unaccent` vector over the object plus
 * every item description, maintained by the worker. It is never selected and
 * never written from here; it exists in this file so the column list matches
 * the table, and so a query builder cannot invent a different name for it.
 */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
})

export const tenders = pgTable('tenders', {
  /** `numeroControlePNCP`, e.g. `51885242000140-1-000744/2026`. */
  id: text('id').primaryKey(),
  agencyCnpj: char('agency_cnpj', { length: 14 }).notNull(),
  year: integer('year').notNull(),
  sequence: integer('sequence').notNull(),
  object: text('object').notNull(),
  agencyName: text('agency_name'),
  unitName: text('unit_name'),
  city: text('city'),
  state: char('state', { length: 2 }),
  /** M(unicipal) | E(stadual) | F(ederal). */
  sphere: char('sphere', { length: 1 }),
  modalityId: integer('modality_id'),
  modalityName: text('modality_name'),
  status: text('status'),
  /** SRP — the agency buys over time, up to the registered quantities. */
  priceRegistration: boolean('price_registration'),
  proposalsOpenAt: timestamp('proposals_open_at', { withTimezone: true }),
  proposalsCloseAt: timestamp('proposals_close_at', { withTimezone: true }),
  estimatedValue: numeric('estimated_value'),
  confidentialBudget: boolean('confidential_budget'),
  biddingSystemUrl: text('bidding_system_url'),
  /** exclusive | quota | mixed | none, derived from the items. */
  meEppSummary: text('me_epp_summary'),
  favoredTreatment: boolean('favored_treatment'),
  /** POC 1's Portuguese labels — the same vocabulary as `cnae_segments`. */
  segments: text('segments').array(),
  search: tsvector('search'),
  pncpUpdatedAt: timestamp('pncp_updated_at', { withTimezone: true }),
  raw: jsonb('raw'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  nextRefreshAt: timestamp('next_refresh_at', { withTimezone: true }),
})

export const tenderItems = pgTable(
  'tender_items',
  {
    tenderId: text('tender_id').notNull(),
    number: integer('number').notNull(),
    description: text('description'),
    /** M(aterial) | S(ervice). */
    kind: char('kind', { length: 1 }),
    quantity: numeric('quantity'),
    unit: text('unit'),
    unitEstimatedValue: numeric('unit_estimated_value'),
    totalValue: numeric('total_value'),
    ncm: text('ncm'),
    judgmentCriterion: text('judgment_criterion'),
    /** 1 = exclusive to ME/EPP, 2 = reserved quota (PNCP `tipoBeneficio`). */
    benefitId: integer('benefit_id'),
    benefitName: text('benefit_name'),
    segment: text('segment'),
    /** high | medium | low — how the segment was reached (§7.1). */
    relevance: text('relevance'),
    hasAward: boolean('has_award'),
    raw: jsonb('raw'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenderId, table.number] })],
)

export const tenderFiles = pgTable(
  'tender_files',
  {
    tenderId: text('tender_id').notNull(),
    sequence: integer('sequence').notNull(),
    title: text('title'),
    /** Edital, Termo de Referência, ETP… */
    docType: text('doc_type'),
    url: text('url'),
    active: boolean('active'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    sha256: text('sha256'),
    s3Key: text('s3_key'),
    pages: integer('pages'),
    textVersion: integer('text_version'),
    /** A scanned PDF: never send it to the AI (§7.2). */
    noText: boolean('no_text'),
  },
  (table) => [primaryKey({ columns: [table.tenderId, table.sequence] })],
)

// ─────────────────── §6.2 Companies, users and access ───────────────────

export const companies = pgTable('companies', {
  cnpj: char('cnpj', { length: 14 }).primaryKey(),
  legalName: text('legal_name'),
  tradeName: text('trade_name'),
  /** 7-digit CNAE 2.3 subclass. `null` is B5's "the user must type it" flag. */
  mainCnae: text('main_cnae'),
  secondaryCnaes: text('secondary_cnaes').array(),
  size: text('size'),
  isMei: boolean('is_mei'),
  state: char('state', { length: 2 }),
  city: text('city'),
  registrationStatus: text('registration_status'),
  segments: text('segments').array(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const visitors = pgTable('visitors', {
  id: uuid('id').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  cnpj: char('cnpj', { length: 14 }),
  ipHash: text('ip_hash'),
  userAgentHash: text('user_agent_hash'),
  screeningsUsed: integer('screenings_used').notNull().default(0),
  convertedUserId: bigint('converted_user_id', { mode: 'number' }),
})

export const users = pgTable('users', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  email: citext('email').notNull().unique(),
  name: text('name'),
  whatsapp: text('whatsapp'),
  cnpj: char('cnpj', { length: 14 }),
  deliveryState: char('delivery_state', { length: 2 }),
  /** basico | promocional | essencial | pro. */
  plan: text('plan').notNull().default('basico'),
  founderSeat: integer('founder_seat'),
  privacyConsentAt: timestamp('privacy_consent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

export const planLimits = pgTable(
  'plan_limits',
  {
    plan: text('plan').notNull(),
    feature: text('feature').notNull(),
    /** total | month | week. */
    period: text('period'),
    /** `null` means unlimited (§6.2). Not "zero", and not "unset". */
    quantity: integer('quantity'),
  },
  (table) => [primaryKey({ columns: [table.plan, table.feature] })],
)

export const usage = pgTable('usage', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  userId: bigint('user_id', { mode: 'number' }),
  visitorId: uuid('visitor_id'),
  feature: text('feature').notNull(),
  /** What was used, e.g. a tender id. */
  reference: text('reference'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

// ───────────────────── §6.3 AI · §0003 the CNAE bridge ─────────────────────

export const aiAnalyses = pgTable('ai_analyses', {
  id: bigint('id', { mode: 'number' }).generatedAlwaysAsIdentity().primaryKey(),
  tenderId: text('tender_id'),
  /** lite (triagem) | deep (análise completa). */
  mode: text('mode'),
  model: text('model'),
  promptVersion: text('prompt_version'),
  extractionVersion: integer('extraction_version'),
  filesHash: text('files_hash'),
  /** queued | running | ok | failed | no_text. */
  status: text('status'),
  result: jsonb('result'),
  citationCheck: jsonb('citation_check'),
  rules: jsonb('rules'),
  inputTokens: integer('input_tokens'),
  outputTokens: integer('output_tokens'),
  costBrl: numeric('cost_brl'),
  seconds: integer('seconds'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})

/** Task B6's CNAE → segment map (migration 0003). Read-only from the web. */
export const cnaeSegments = pgTable(
  'cnae_segments',
  {
    cnae: text('cnae').notNull(),
    segment: text('segment').notNull(),
    /** compatible | check. */
    fit: text('fit').notNull(),
    note: text('note'),
  },
  (table) => [primaryKey({ columns: [table.cnae, table.segment] })],
)

export const subscriptions = pgTable('subscriptions', {
  userId: bigint('user_id', { mode: 'number' }).notNull(),
  asaasCustomerId: text('asaas_customer_id'),
  asaasSubscriptionId: text('asaas_subscription_id').primaryKey(),
  plan: text('plan'),
  amount: numeric('amount'),
  status: text('status'),
  nextChargeOn: date('next_charge_on'),
  promoEndsOn: date('promo_ends_on'),
  promoNoticeSentAt: timestamp('promo_notice_sent_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})
