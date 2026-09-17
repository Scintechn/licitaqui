-- 0001_initial — LicitaQui schema, spec §6.1–6.3.
-- Conventions: English snake_case, timestamptz, raw PNCP payloads kept in `raw jsonb`
-- with their original Portuguese field names.

create extension if not exists unaccent;
create extension if not exists pg_trgm;
create extension if not exists citext;

-- Portuguese full-text search that ignores accents: "licitacao" must match "licitação".
-- Immutable so it can be used in generated columns and indexes.
do $$
begin
  if not exists (select 1 from pg_ts_config where cfgname = 'pt_unaccent') then
    create text search configuration pt_unaccent (copy = portuguese);
    alter text search configuration pt_unaccent
      alter mapping for hword, hword_part, word with unaccent, portuguese_stem;
  end if;
end $$;

-- ───────────────────────────── §6.1 PNCP cache ─────────────────────────────

create table if not exists tenders (
  id                   text primary key,          -- numero_controle_pncp
  agency_cnpj          char(14) not null,
  year                 int  not null,
  sequence             int  not null,
  object               text not null,             -- "objeto"
  agency_name          text,
  unit_name            text,
  city                 text,
  state                char(2),
  sphere               char(1),                   -- M(unicipal) | E(stadual) | F(ederal)
  modality_id          int,
  modality_name        text,
  status               text,
  price_registration   boolean,                   -- SRP
  proposals_open_at    timestamptz,
  proposals_close_at   timestamptz,
  estimated_value      numeric(16,2),
  confidential_budget  boolean default false,     -- "orçamento sigiloso"
  bidding_system_url   text,
  me_epp_summary       text,                      -- exclusive | quota | mixed | none
  favored_treatment    boolean,                   -- value vs EPP cap, computed in code
  segments             text[],
  search               tsvector,                  -- object + item descriptions, maintained by the worker
  pncp_updated_at      timestamptz,
  raw                  jsonb,
  updated_at           timestamptz not null default now(),
  next_refresh_at      timestamptz,
  constraint tenders_agency_year_sequence_key unique (agency_cnpj, year, sequence),
  constraint tenders_me_epp_summary_check
    check (me_epp_summary is null or me_epp_summary in ('exclusive','quota','mixed','none'))
);

create index if not exists tenders_proposals_close_at_idx on tenders (proposals_close_at);
create index if not exists tenders_search_idx              on tenders using gin (search);
create index if not exists tenders_state_close_idx         on tenders (state, proposals_close_at);
create index if not exists tenders_next_refresh_at_idx     on tenders (next_refresh_at)
  where next_refresh_at is not null;
create index if not exists tenders_segments_idx            on tenders using gin (segments);

create table if not exists tender_items (
  tender_id            text not null references tenders(id) on delete cascade,
  number               int  not null,
  description          text,
  kind                 char(1),                   -- M(aterial) | S(ervice)
  quantity             numeric,
  unit                 text,
  unit_estimated_value numeric(16,4),
  total_value          numeric(16,2),
  ncm                  text,
  judgment_criterion   text,
  benefit_id           int,
  benefit_name         text,                      -- "Participação exclusiva para ME/EPP"
  segment              text,
  relevance            text,                      -- high | medium | low
  has_award            boolean,
  raw                  jsonb,
  updated_at           timestamptz not null default now(),
  primary key (tender_id, number),
  constraint tender_items_relevance_check
    check (relevance is null or relevance in ('high','medium','low'))
);

create index if not exists tender_items_segment_idx on tender_items (segment);
create index if not exists tender_items_ncm_idx     on tender_items (ncm);

create table if not exists tender_files (
  tender_id    text not null references tenders(id) on delete cascade,
  sequence     int  not null,
  title        text,
  doc_type     text,                              -- Edital, Termo de Referência, ETP…
  url          text,
  active       boolean,
  published_at timestamptz,
  sha256       text,
  s3_key       text,
  pages        int,
  text_version int,                               -- EXTRACTION_VERSION
  no_text      boolean default false,             -- scanned PDF: never call the AI
  primary key (tender_id, sequence)
);

create table if not exists awards (
  tender_id          text not null,
  item_number        int  not null,
  sequence           int  not null default 1,
  supplier_doc       text,                        -- CNPJ; CPF MASKED on write (spec §12)
  supplier_name      text,                        -- natural person: initials only
  person_type        char(2),
  company_size       text,
  unit_awarded_value numeric(16,4),
  awarded_quantity   numeric,
  discount_pct       numeric(6,2),
  awarded_on         date,
  quality            text,                        -- OK | confidential | out_of_range | cancelled
  raw                jsonb,
  primary key (tender_id, item_number, sequence)
);

create index if not exists awards_awarded_on_idx   on awards (awarded_on);
create index if not exists awards_supplier_doc_idx on awards (supplier_doc);

-- ─────────────────── §6.2 Companies, users and access ───────────────────

create table if not exists companies (            -- BrasilAPI cache
  cnpj                char(14) primary key,
  legal_name          text,
  trade_name          text,
  main_cnae           text,
  secondary_cnaes     text[],
  size                text,
  is_mei              boolean,
  state               char(2),
  city                text,
  registration_status text,
  segments            text[],
  updated_at          timestamptz not null default now()
);

create table if not exists visitors (             -- no-account mode: 3 days, 2 screenings
  id                uuid primary key,
  created_at        timestamptz not null default now(),
  cnpj              char(14),
  ip_hash           text,
  user_agent_hash   text,
  screenings_used   int not null default 0,
  converted_user_id bigint
);

create index if not exists visitors_cnpj_idx on visitors (cnpj);

create table if not exists users (
  id                 bigint generated always as identity primary key,
  email              citext unique not null,
  name               text,
  whatsapp           text,
  cnpj               char(14) references companies(cnpj),
  delivery_state     char(2),
  plan               text not null default 'basico',
  founder_seat       int unique,                  -- 1..48 from the founders list
  privacy_consent_at timestamptz,
  created_at         timestamptz not null default now(),
  constraint users_plan_check
    check (plan in ('basico','promocional','essencial','pro')),
  constraint users_founder_seat_range
    check (founder_seat is null or (founder_seat between 1 and 48))
);

alter table visitors
  add constraint visitors_converted_user_id_fkey
  foreign key (converted_user_id) references users(id) on delete set null;

-- Auth.js (NextAuth v5) Postgres adapter tables. Spec §5 decided Auth.js over the
-- Neon Auth schema the Vercel integration provisioned.
create table if not exists accounts (
  id                  bigint generated always as identity primary key,
  "userId"            bigint not null references users(id) on delete cascade,
  type                text not null,
  provider            text not null,
  "providerAccountId" text not null,
  refresh_token       text,
  access_token        text,
  expires_at          bigint,
  token_type          text,
  scope               text,
  id_token            text,
  session_state       text,
  unique (provider, "providerAccountId")
);

create table if not exists sessions (
  id             bigint generated always as identity primary key,
  "sessionToken" text not null unique,
  "userId"       bigint not null references users(id) on delete cascade,
  expires        timestamptz not null
);

create table if not exists verification_token (
  identifier text not null,
  token      text not null,
  expires    timestamptz not null,
  primary key (identifier, token)
);

create table if not exists plan_limits (          -- configurable without a deploy
  plan     text not null,
  feature  text not null,
  period   text,
  quantity int,
  primary key (plan, feature)
);

create table if not exists usage (
  id         bigint generated always as identity primary key,
  user_id    bigint references users(id) on delete cascade,
  visitor_id uuid   references visitors(id) on delete cascade,
  feature    text not null,
  reference  text,                                -- e.g. tender_id
  created_at timestamptz not null default now()
);

create index if not exists usage_user_feature_idx    on usage (user_id, feature, created_at);
create index if not exists usage_visitor_feature_idx on usage (visitor_id, feature, created_at);

-- ───────── §6.3 AI, alerts, payments, founders, queue and events ─────────

create table if not exists ai_analyses (
  id                 bigint generated always as identity primary key,
  tender_id          text references tenders(id) on delete cascade,
  mode               text,                        -- lite | deep
  model              text,
  prompt_version     text,
  extraction_version int,
  files_hash         text,
  status             text,                        -- queued | running | ok | failed | no_text
  result             jsonb,
  citation_check     jsonb,
  rules              jsonb,
  input_tokens       int,
  output_tokens      int,
  cost_brl           numeric(10,4),
  seconds            int,
  created_at         timestamptz not null default now(),
  unique (tender_id, mode, prompt_version, extraction_version, files_hash),
  constraint ai_analyses_mode_check   check (mode is null or mode in ('lite','deep')),
  constraint ai_analyses_status_check
    check (status is null or status in ('queued','running','ok','failed','no_text'))
);

create table if not exists telegram_links (
  user_id     bigint primary key references users(id) on delete cascade,
  chat_id     bigint unique,
  start_token text unique,
  linked_at   timestamptz
);

create table if not exists alerts (
  id        bigint generated always as identity primary key,
  user_id   bigint not null references users(id) on delete cascade,
  kind      text,                                 -- keyword | cnae
  value     text,
  states    text[],
  channel   text,
  frequency text,
  active    boolean not null default true,
  constraint alerts_kind_check check (kind is null or kind in ('keyword','cnae'))
);

create index if not exists alerts_user_active_idx on alerts (user_id) where active;

create table if not exists alert_deliveries (
  alert_id  bigint not null references alerts(id) on delete cascade,
  tender_id text   not null references tenders(id) on delete cascade,
  sent_at   timestamptz,
  opened_at timestamptz,
  primary key (alert_id, tender_id)
);

create table if not exists subscriptions (
  user_id                bigint not null references users(id) on delete cascade,
  asaas_customer_id      text,
  asaas_subscription_id  text primary key,
  plan                   text,
  amount                 numeric(10,2),
  status                 text,
  next_charge_on         date,
  promo_ends_on          date,                    -- promocional: first charge + 6 months
  promo_notice_sent_at   timestamptz,             -- 30-day notice before R$ 26 → R$ 57
  updated_at             timestamptz not null default now()
);

create index if not exists subscriptions_user_idx on subscriptions (user_id);
create index if not exists subscriptions_promo_ends_on_idx on subscriptions (promo_ends_on)
  where promo_ends_on is not null;

create table if not exists webhook_events (
  id           text primary key,
  source       text,
  event        text,
  body         jsonb,
  processed_at timestamptz
);

create table if not exists founders_list (
  id              bigint generated always as identity primary key,
  name            text   not null,
  email           citext not null unique,
  whatsapp        text,
  cnpj            char(14),
  sells           text,
  source          text,                           -- utm_source, influencer, coupon
  seat            int unique,                     -- 1..48; null = waitlist
  contact_consent boolean not null,
  created_at      timestamptz not null default now(),
  constraint founders_list_seat_range check (seat is null or (seat between 1 and 48))
);

create table if not exists jobs (
  id         bigint generated always as identity primary key,
  kind       text not null,
  key        text not null,
  priority   int  not null default 5,
  payload    jsonb,
  status     text not null default 'queued',
  attempts   int  not null default 0,
  run_after  timestamptz not null default now(),
  error      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint jobs_status_check
    check (status in ('queued','running','done','failed'))
);

-- One live job per (kind, key): the de-duplication the cache strategy in §3.1 relies on.
create unique index if not exists jobs_dedupe on jobs (kind, key)
  where status in ('queued','running');
-- Claim order for the FOR UPDATE SKIP LOCKED consumer (§7.3).
create index if not exists jobs_claim_idx on jobs (status, priority, run_after);

create table if not exists events (
  id         bigint generated always as identity primary key,
  user_id    bigint references users(id) on delete set null,
  visitor_id uuid   references visitors(id) on delete set null,
  name       text not null,
  props      jsonb,
  created_at timestamptz not null default now()
);

create index if not exists events_name_created_idx on events (name, created_at);
