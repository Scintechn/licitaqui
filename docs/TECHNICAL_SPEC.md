# LicitaQui · Technical Specification

> Version 0.4 · 2026-09-17 · draft for building v1.01 (free Radar + Founders offer) and preparing v1 (Essencial plan)
> Internal document: it names data sources, models and business rules. Do not share with partners.

**The promise the architecture must deliver** (product copy, kept in Portuguese):
*"Para quem quer encontrar um edital que consegue atender, entender o que pedem e saber até quanto pode ofertar com lucro — antes do prazo."*
(For people who want to find a public tender they can actually fulfill, understand what it requires, and know the highest price they can bid and still profit — before the deadline.)

**References in this folder:** `viabilidade_licitacao_mei.html` (viability study v10), "Wireframes LicitaQui" canvas (approved UI), `Marca/assest/` (brand assets; `Marca/Nome e Marca.dc.html` is the brand board), POCs `poc1_licitacoes.py`, `poc3_resultados.py`, `poc3_categorias.py`, `poc_margem_papel.py`, `poc4_ia_edital.py`, `poc4_avaliar.py` and `gabaritos/` (hand-checked answer keys).

---

## 0. Glossary (Brazilian public procurement terms kept as-is)

| Term | Meaning |
|---|---|
| **PNCP** | Portal Nacional de Contratações Públicas — the federal portal where every public purchase under Law 14.133/2021 must be published. Our primary data source |
| **Edital** | Tender notice (the PDF with rules, deadlines and requirements) |
| **TR** (Termo de Referência) | Technical annex describing what is being bought |
| **Pregão Eletrônico / Dispensa / Concorrência** | Procurement modalities (PNCP ids 6, 8, 4) |
| **SRP** (Sistema de Registro de Preços) | Price-registration tender: the agency buys over time, up to the registered quantities |
| **MEI / ME / EPP** | Micro-entrepreneur / micro company / small company. Items may be *exclusive* to ME/EPP or have a *reserved quota* |
| **Tratamento favorecido** | Legal preference for ME/EPP; not applicable when the value exceeds the EPP revenue cap (R$ 4.8M) |
| **CNPJ / CNAE** | Company tax id / economic activity codes registered with the Federal Revenue |
| **SICAF** | Federal supplier registry |
| **Atestado de capacidade técnica** | Proof of prior delivery required by some tenders |
| **Homologado** | Final awarded result (winner and price) |
| **Triagem** | Our "lite" AI screening of a tender |
| **Análise completa** | Our "deep" AI analysis with cited excerpts |

---

## 1. Decisions already made

| Topic | Decision |
|---|---|
| Brand | **LicitaQui** (always one word, capital L and Q; only "Qui" in blue). Assets in `Marca/assest/` |
| App | **PWA** web app (installable on phones), mobile first at 390 px, desktop from 1280 px |
| Framework | **Next.js** (App Router) + TypeScript on **Vercel** (Pro plan — Hobby forbids commercial use) |
| Database | **Neon** (managed PostgreSQL 16) **through the Vercel Marketplace** (Vercel-managed integration, billed on the Vercel invoice). A new Vercel database resource = a **new, dedicated Neon project** `licitaqui`, not a schema or database inside an existing one (§5.1). **No Supabase** |
| Code & deploy | **GitHub** monorepo. Web: Vercel auto-deploys on every push. Worker: Docker image built by GitHub Actions |
| Slow data | **Cache first**: users always read from the database. Every call to PNCP writes to the cache. Stale data is served immediately and refreshed in the background |
| Collector | **Python** worker (reusing the POCs) on AWS, inside the existing Easypanel |
| AI | OpenRouter. Screening: `qwen/qwen3.7-flash`. Deep analysis: `openai/gpt-5.6-luna`, fallback `google/gemini-3.8-flash` |
| Plans & prices | **Básico** R$ 0 · **Promocional** R$ 26/month for the first 6 months, then R$ 57 (founders only, 48 seats) · **Essencial** R$ 57 · **Pro** R$ 98 — all monthly, no lock-in |
| Messaging | Telegram Bot API (alerts on Básico and Essencial). WhatsApp **always via Evolution API** (already running on Easypanel): founders messages in Phase 0, alerts on Pro only. Both connected during development |
| Payments | Asaas (sandbox + production accounts): hosted checkout (subscription link) + webhook. **Customer invoices (NF): to be defined later with the accountant** — no invoice promise in the product for now |
| URL | Vercel default URL (`https://<project>.vercel.app`) until a domain is registered |
| Existing accounts | GitHub and Vercel (org `scintechn`), Sentry, OpenRouter (**create a new API key** for LicitaQui), Asaas sandbox + production, a Telegram bot already created (**temporary**; the official LicitaQui bot comes later) |
| Auth | Email magic link **and** Google (email link depends on a sending domain, §9) |
| Design | Canvas design system: Ivory `#FBF7F3`, Graphite `#171717`, Blue `#2457D6`; Archivo, IBM Plex Sans, IBM Plex Mono |

---

## 2. Architecture overview

```
                ┌──────────────────────────── Vercel ────────────────────────────┐
 Phone/PC ────► │ Next.js (PWA) · https://<project>.vercel.app                   │
                │  • pages: Offer, Landing, Radar, Tender, Screening, Account    │
                │  • /api routes: search, request screening, Asaas & Telegram    │
                │  • ALWAYS reads Postgres ──► if stale: enqueue refresh job     │
                └──────────────┬─────────────────────────────────────────────────┘
                               │ pooled connection (-pooler, TLS)
                ┌──────────────▼──────── Neon (via Vercel) · project "licitaqui" ┐
                │ PostgreSQL 16 · branch main (prod) · preview branches per PR   │
                │  • PNCP cache (tenders, items, files, awards)                  │
                │  • companies (CNPJ→CNAE), users, plans, usage, alerts          │
                │  • job queue (FOR UPDATE SKIP LOCKED)                          │
                └──────────────▲─────────────────────────────────────────────────┘
                               │ direct connection (TLS)
                ┌──────────────┴──────────────────── AWS (Easypanel) ────────────┐
                │ Python worker (jobs + scheduler)                               │
                │ S3: PDFs and extracted text    Evolution API (WhatsApp)        │
                └──────┬──────────────┬──────────────┬──────────────┬────────────┘
                       ▼              ▼              ▼              ▼
                    PNCP API     OpenRouter      BrasilAPI     Telegram · Asaas · SearchApi
```

**Why the collector does not run on Vercel:** PNCP answers in seconds or minutes and returns 500/503s and timeouts (seen in the POCs: detail endpoint at 4 × 30 s, a download stuck for 929 s). Serverless functions have time limits and bill by duration. The AWS worker runs unhurried, with a queue, retries and a circuit breaker, and its cost is already paid (AWS R$ 200–250/month).

**Golden rule:** no screen waits on PNCP, BrasilAPI or the AI inside a request. If data does not exist yet, the UI shows the "analyzing" state (already in the design system) and updates when the job finishes.

---

## 3. Caching strategy

### 3.1 Pattern: read from cache, refresh in the background (stale-while-revalidate)

1. The route reads the entity from Postgres.
2. If it exists and is fresh (`updated_at + ttl > now`): respond.
3. If it exists but is stale: **respond with what we have** (showing "updated X min ago") and enqueue `refresh_<entity>` with de-duplication (one job per key).
4. If it does not exist: enqueue with high priority and respond `202` + "analyzing" state. The client polls every 3 s (max 60 s) or receives Server-Sent Events.
5. **Every** result from PNCP, BrasilAPI or the AI is written (write-through), including results triggered by another user's search. A tender downloaded once serves everyone.

### 3.2 Time-to-live (TTL)

| Data | Source | TTL while open | After closing | Notes |
|---|---|---|---|---|
| Tenders receiving proposals | PNCP search | 30 min (continuous sync) | — | Collector sweeps by publication/update date |
| Tender header | PNCP search/consulta | 6 h, or when `data_atualizacao_pncp` changes | permanent | `/api/consulta` detail is unstable: optional, behind a circuit breaker |
| Items | PNCP items | 12 h | permanent | Per-item `tipoBeneficioNome` defines ME/EPP |
| File list | PNCP files | 12 h | permanent | An amendment adds a new file: invalidates text and screening |
| PDF and extracted text | PNCP download | until the file list changes | delete PDF 90 days after closing; keep text | S3; text also in the DB |
| Award per item (winner) | PNCP results | — | permanent once awarded | 1 call per item: only for segments of interest |
| Company (CNPJ → CNAEs, size, MEI) | BrasilAPI | 30 days | — | On failure the user enters the CNAE |
| AI screening | OpenRouter | permanent per prompt version + extraction version + file hash | permanent | Shared across users |
| Deep analysis | OpenRouter | same | same | Shared, but counts toward the requester's quota |
| Market price (Pro) | SearchApi | 7 days | — | Phase 2 |

### 3.3 Layers above the database

- **Public pages** (Offer, Landing, public tender page for SEO): static rendering with revalidation (ISR) every 10–30 min.
- **User data** (Radar, usage, plan): dynamic, no CDN cache (`Cache-Control: private, no-store`).
- **PWA:** the service worker caches the app shell and the last tender list seen, so the app opens fast and shows something offline. Never caches payment data.
- Redis is not needed for v1.01: Postgres handles queue, rate limiting and cache. Re-evaluate above ~5k active users.

---

## 4. Repository (GitHub monorepo)

```
licitaqui/
├─ apps/web/                 Next.js (PWA) → Vercel (Root Directory = apps/web)
│  ├─ app/(public)/fundadores Offer page (founders list)
│  ├─ app/(public)/page.tsx   Landing = Radar entry (CNPJ)
│  ├─ app/radar/...          tenders, opportunity, screening, price (locked), menu
│  ├─ app/conta/...          sign-up, Telegram, plan
│  ├─ app/api/...            routes (section 8)
│  ├─ lib/db/                Drizzle: schema.ts, queries
│  ├─ lib/cache.ts           readOrEnqueue(), TTL per entity
│  └─ public/                manifest.webmanifest + icons copied from Marca/assest/
├─ worker/                   Python 3.12 → Docker → Easypanel
│  ├─ licitaqui/pncp.py      ← poc1_licitacoes.py (connection, cache, circuit breaker, search, items, files)
│  ├─ licitaqui/awards.py    ← poc3_resultados.py
│  ├─ licitaqui/segments.py  ← poc3_categorias.py (NCM + keyword rules; false positives)
│  ├─ licitaqui/margin.py    ← poc_margem_papel.py
│  ├─ licitaqui/ai_tender.py ← poc4_ia_edital.py (extraction, page selection, prompts, citations, rules)
│  ├─ licitaqui/jobs.py      queue, de-dup, retry, scheduler
│  ├─ licitaqui/alerts.py    message building and sending (Telegram, WhatsApp)
│  ├─ evaluation/            ← poc4_avaliar.py + gabaritos/ (runs in CI when prompts change)
│  └─ Dockerfile
├─ db/migrations/            versioned SQL (generated by drizzle-kit, reviewed by hand)
├─ brand/                    ← Marca/assest/ (SVG, PNG, LEIAME.md)
├─ docs/                     this spec, ADRs, runbooks
├─ docker-compose.yml        local Postgres
└─ .github/workflows/        ci-web.yml, ci-worker.yml, migrate.yml, evaluate-ai.yml
```

**Single source of truth for the schema:** migrations in `db/migrations`, applied by a GitHub Actions job before deploy. The worker uses plain SQL (psycopg 3), no ORM.

**Language convention:** code, identifiers, tables and commits in English; user-facing copy in Brazilian Portuguese (i18n file `apps/web/messages/pt-BR.json`, even with a single locale, so copy is reviewable in one place).

---

## 5. Stack details

| Layer | Choice | Why |
|---|---|---|
| UI | Next.js 15+, React Server Components, Tailwind with design-system tokens | One project serves landing, app and API |
| PWA | `manifest.webmanifest` + Serwist (service worker) | Installable; opens offline with last state |
| ORM | Drizzle ORM + `pg` | Explicit SQL, simple migrations, no vendor lock-in |
| Auth | Auth.js (NextAuth v5) with Postgres adapter | **Decided:** email magic link + Google. Google works on the `vercel.app` URL; magic link needs a verified sending domain (§9) |
| Validation | Zod on every route and webhook | |
| Worker | Python 3.12, psycopg 3, pdfplumber, `curl`/httpx with timeouts | POC code already validated |
| Database | Neon PostgreSQL 16 + `unaccent`, `pg_trgm`, `citext` | Portuguese search without an extra service; managed backups and branching |
| Pooling | Neon built-in PgBouncer: `DATABASE_URL` (pooled) for Vercel; `DATABASE_URL_UNPOOLED` (direct) for the worker and migrations | Serverless functions open many connections |
| Files | S3 (private bucket, signed URLs when needed) | Already on AWS |
| Errors | Sentry (web and worker) | Free tier is enough to start |
| Metrics | `events` table + Vercel Analytics | Phase 0 gates come out of SQL |
| Uptime | UptimeRobot or Better Stack (free) on `/api/health` and the worker | |

### 5.1 Neon: new project, not a new schema

**Decision: create a new Neon project `licitaqui`.** Do not put LicitaQui in a schema, or in a second database, of an existing Neon project. Through Vercel this is simply a **new database resource** in Vercel Storage, since "a Database in Vercel is a Project in Neon".

| Option | Isolation | Restore | Compute and cost | Verdict |
|---|---|---|---|---|
| New schema in an existing database | Shares roles, extensions, connection limits and migrations tooling with the other app | Point-in-time restore rolls back **every** schema on the branch | Shares one compute; the worker's sync load hits the other app | ❌ |
| New database in an existing project | Separate database, but same branch, compute and project credentials | Neon restores **all databases on a branch together** | Same compute; the other app can never scale to zero while LicitaQui runs | ❌ |
| **New project** (new Vercel database resource) | Neon's recommended boundary for an app: separate data, credentials, compute, branches | Restore affects only LicitaQui | Own compute and autoscaling; usage on the same Vercel invoice | ✅ |

**Setup (Vercel → Storage → Create database → Neon)**
- **Region:** chosen at creation and cannot be changed later. It is **not** tied to the EC2: pick the region closest to users and to the Vercel functions — **São Paulo (`aws-sa-east-1`) if the Vercel flow offers it**, with Vercel functions in `gru1`; otherwise `aws-us-east-1` with functions in `iad1`. The worker on EC2 connects over TLS from wherever it is; its extra latency only affects background jobs.
- **Environment variables** injected by the integration: `DATABASE_URL` (pooled, PgBouncer transaction mode → Next.js) and `DATABASE_URL_UNPOOLED` (direct → worker, migrations, `pg_dump`). Copy `DATABASE_URL_UNPOOLED` to Easypanel and GitHub Actions secrets; if the password is rotated in Vercel, update both.
- **Plan and cost:** start on the **Free** plan (0.5 GB storage and 100 CU-hours per project, scale to zero after 5 min). Nothing changes on the EC2/Easypanel side and no new cost is expected while usage stays inside Free. Upgrading, if ever needed, shows up on the Vercel invoice.
- **Staying inside Free:** 100 CU-hours ≈ 400 hours/month awake at 0.25 CU, so the database must be allowed to sleep:
  - the worker polls the job table every **2 minutes** (not every few seconds) and runs scheduled syncs in short batches;
  - when a user enqueues a priority-1 job, the Vercel route also calls the worker's authenticated `POST /wake` endpoint so it picks the job immediately;
  - PDFs and extracted text live in S3, not in Postgres; `raw jsonb` is kept only for open tenders and trimmed 90 days after closing;
  - `/admin` shows storage used and CU-hours this month, with an alert at 80% of each limit.
- **Branches:** `main` = production. Vercel preview branching creates a Neon branch per preview deployment, but cleanup follows Vercel's deployment retention (can take months) and Free allows 10 branches per project → add a GitHub Action that deletes the branch when the PR closes, or disable per-deployment branching and use one shared `preview` branch. `dev` branch for local work.
- **Roles:** `app` (DML only) for the web and worker, `migrator` (DDL) for migrations.
- **Backups:** Neon point-in-time restore (6 hours on Free, up to 7 days on Launch) + a weekly `pg_dump` from the worker to S3.

---

## 6. Data model (v1.01 + v1)

Conventions: English `snake_case`, `id bigint generated always as identity` unless a natural key is better, `created_at`/`updated_at timestamptz`. Raw PNCP payloads kept in `raw jsonb` with original (Portuguese) field names.

### 6.1 PNCP cache

```sql
create table tenders (
  id                    text primary key,          -- numero_controle_pncp: 51885242000140-1-000744/2026
  agency_cnpj           char(14) not null,
  year                  int not null,
  sequence              int not null,
  object                text not null,             -- "objeto"
  agency_name           text, unit_name text,
  city                  text, state char(2),
  sphere                char(1),                   -- M(unicipal), E(stadual), F(ederal)
  modality_id           int, modality_name text,
  status                text,
  price_registration    boolean,                   -- SRP
  proposals_open_at     timestamptz,
  proposals_close_at    timestamptz,               -- deadline shown on cards
  estimated_value       numeric(16,2),
  confidential_budget   boolean default false,     -- "orçamento sigiloso"
  bidding_system_url    text,
  me_epp_summary        text,                      -- exclusive | quota | mixed | none (derived from items)
  favored_treatment     boolean,                   -- rule: value vs EPP cap (R$ 4.8M), computed in code
  segments              text[],
  search                tsvector,                  -- object + item descriptions (unaccent, portuguese)
  pncp_updated_at       timestamptz,
  raw                   jsonb,
  updated_at            timestamptz not null default now(),
  next_refresh_at       timestamptz,
  unique (agency_cnpj, year, sequence)
);
create index on tenders (proposals_close_at);
create index on tenders using gin (search);
create index on tenders (state, proposals_close_at);

create table tender_items (
  tender_id            text references tenders(id) on delete cascade,
  number               int,
  description          text, kind char(1),         -- M(aterial) | S(ervice)
  quantity             numeric, unit text,
  unit_estimated_value numeric(16,4), total_value numeric(16,2),
  ncm                  text, judgment_criterion text,
  benefit_id           int, benefit_name text,     -- "Participação exclusiva para ME/EPP"
  segment              text,
  relevance            text,                       -- high | medium | low (false-positive rules)
  has_award            boolean,
  raw                  jsonb, updated_at timestamptz default now(),
  primary key (tender_id, number)
);

create table tender_files (
  tender_id     text references tenders(id) on delete cascade,
  sequence      int,
  title         text, doc_type text,               -- Edital, Termo de Referência, ETP...
  url           text, active boolean, published_at timestamptz,
  sha256        text, s3_key text, pages int,
  text_version  int,                               -- EXTRACTION_VERSION (currently 3)
  no_text       boolean,                           -- scanned PDF: never call the AI (needs OCR)
  primary key (tender_id, sequence)
);

create table awards (
  tender_id        text, item_number int, sequence int default 1,
  supplier_doc     text,                           -- CNPJ; CPF MASKED (***.456.789-**)
  supplier_name    text,                           -- natural person: initials only
  person_type      char(2), company_size text,
  unit_awarded_value numeric(16,4), awarded_quantity numeric,
  discount_pct     numeric(6,2), awarded_on date, quality text, -- OK | confidential | out_of_range | cancelled
  raw jsonb, primary key (tender_id, item_number, sequence)
);
```

### 6.2 Companies, users and access

```sql
create table companies (                          -- BrasilAPI cache
  cnpj char(14) primary key, legal_name text, trade_name text,
  main_cnae text, secondary_cnaes text[], size text, is_mei boolean,
  state char(2), city text, registration_status text, segments text[],
  updated_at timestamptz default now()
);

create table visitors (                           -- no-account mode (3 days, 2 screenings)
  id uuid primary key, created_at timestamptz default now(),
  cnpj char(14), ip_hash text, user_agent_hash text,
  screenings_used int default 0, converted_user_id bigint
);

create table users (
  id bigint generated always as identity primary key,
  email citext unique not null, name text, whatsapp text,
  cnpj char(14) references companies(cnpj), delivery_state char(2),
  plan text not null default 'basico',            -- basico | promocional | essencial | pro
  founder_seat int,                               -- 1..48 when coming from the founders list
  privacy_consent_at timestamptz, created_at timestamptz default now()
);
-- plus Auth.js tables: accounts, sessions, verification_tokens

create table plan_limits (                        -- configurable without a deploy
  plan text, feature text, period text, quantity int, primary key (plan, feature)
);
-- visitor: screening 2 (total), days 3 · basico: screening 5/month, alert 1/week, keywords 1, states 1
-- essencial and promocional: screening unlimited, deep_analysis 10/month, keywords 10 · pro: deep_analysis 60/month, market_price 100/month

create table usage (
  user_id bigint, visitor_id uuid, feature text, reference text, -- e.g. tender_id
  created_at timestamptz default now()
);
create index on usage (user_id, feature, created_at);
```

### 6.3 AI, alerts, payments, founders list, queue and events

```sql
create table ai_analyses (
  id bigint generated always as identity primary key,
  tender_id text references tenders(id), mode text,            -- lite | deep
  model text, prompt_version text, extraction_version int, files_hash text,
  status text,                                                 -- queued | running | ok | failed | no_text
  result jsonb, citation_check jsonb, rules jsonb,             -- minimum capital, term in months: computed in code
  input_tokens int, output_tokens int, cost_brl numeric(10,4), seconds int,
  created_at timestamptz default now(),
  unique (tender_id, mode, prompt_version, extraction_version, files_hash)
);

create table telegram_links (user_id bigint primary key, chat_id bigint unique, start_token text unique, linked_at timestamptz);
create table alerts (id bigint generated always as identity primary key, user_id bigint, kind text, -- keyword | cnae
                     value text, states text[], channel text, frequency text, active boolean default true);
create table alert_deliveries (alert_id bigint, tender_id text, sent_at timestamptz, opened_at timestamptz,
                               primary key (alert_id, tender_id));

create table subscriptions (user_id bigint, asaas_customer_id text, asaas_subscription_id text unique,
                            plan text, amount numeric(10,2), status text, next_charge_on date,
                            promo_ends_on date,              -- promocional: first charge + 6 months; then amount → 57.00
                            promo_notice_sent_at timestamptz, -- email 30 days before the price change
                            ends_on date,                    -- cancelled: paid access runs to this date (terms §8)
                            refunded_at timestamptz,         -- a refund was issued; null = never
                            refund_reason text,              -- 'withdrawal_7d' (CDC art. 49) | 'guarantee_30d' (once per CNPJ)
                            updated_at timestamptz);
create table webhook_events (id text primary key, source text, event text, body jsonb, processed_at timestamptz);

create table founders_list (
  id bigint generated always as identity primary key,
  name text not null, email citext unique not null, whatsapp text,
  cnpj char(14), sells text, source text,                      -- utm_source, influencer, coupon
  seat int unique,                                             -- 1..48 gets founder price; null = waitlist
  contact_consent boolean not null, created_at timestamptz default now()
);

create table jobs (
  id bigint generated always as identity primary key,
  kind text not null, key text not null, priority int default 5,
  payload jsonb, status text default 'queued', attempts int default 0,
  run_after timestamptz default now(), error text,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create unique index jobs_dedupe on jobs (kind, key) where status in ('queued','running');

create table events (user_id bigint, visitor_id uuid, name text, props jsonb, created_at timestamptz default now());
```

**Founder seats:** assign the seat inside a transaction (lock a control row, or use a dedicated sequence capped at 48) so two people can never both get seat 48. The Offer page shows `48 − seats taken`.

---

## 7. Collector and queue (worker)

### 7.1 Jobs

| Job | When | What it does | Based on |
|---|---|---|---|
| `sync_open_tenders` | every 30 min | Searches tenders `recebendo_proposta` by state and modality (6 Pregão, 8 Dispensa, 4 Concorrência), upserts headers, enqueues items/files for new or changed tenders | POC 1 |
| `sync_items` | new/changed tender | Items + segment + relevance (false positives such as "sistema de registro de preços", "SRP", "comodato") + ME/EPP summary | POC 1, POC 3 categories |
| `sync_files` | new/changed tender | File list; downloads Edital and TR only when someone requests screening, or for sampling | POC 1 |
| `extract_text` | before AI | pdfplumber text + tables ≤ 20 rows; `no_text` when < 1,500 characters | POC 4 |
| `ai_screening` | user request or sampling | Lite model, 60k characters, 90 s, citation check and rules | POC 4 |
| `ai_deep_analysis` | user request (counts toward quota) | Deep model, 320k characters, 240 s, fallback model on failure | POC 4 |
| `sync_awards` | daily, overnight | Awards for closed items in active segments | POC 3 |
| `company_lookup` | CNPJ entered | BrasilAPI → CNAEs → segments | new |
| `weekly_alerts` | Monday 07:00 BRT | Free: one message with up to 3 compatible tenders | new |
| `daily_alerts` | every day 07:00 BRT | Essencial: keywords + compatible CNAE | new |
| `cleanup` | daily | PDFs of tenders closed > 90 days, old jobs, visitors > 30 days | new |

### 7.2 Robustness rules (learned in the POCs)

- Timeouts: connect 15 s; query 30 s; download 120 s; AI lite 90 s, deep 240 s.
- Exponential backoff retries (2, 8, 30 min), max 4 attempts; then `failed` with the error stored.
- **Circuit breaker per endpoint:** 2 consecutive failures on the `/api/consulta` detail → skip detail for 15 min and continue with search + items.
- Throttle PNCP calls (e.g. 4 req/s per worker) and run heavy jobs off-peak.
- AI call plans: no reasoning + JSON → low reasoning + JSON → low reasoning without JSON; stop on 401/402/404; stop after 2 hangs.
- Never send a scanned PDF to the AI (cost without result). OCR comes later.
- Arithmetic (minimum capital, term in months) always in code, never by the AI.
- Idempotency: every job can run twice without duplicating (upsert on natural keys).

### 7.3 Consuming the queue

```sql
update jobs set status='running', attempts=attempts+1, updated_at=now()
where id = (select id from jobs where status='queued' and run_after <= now()
            order by priority, id for update skip locked limit 1)
returning *;
```

Priority 1 = a user waiting on screen (the web also calls the worker's `POST /wake`); 5 = sync; 9 = sampling and cleanup. Consumers poll every 2 minutes when idle so Neon can scale to zero (§5.1). One scheduler process (APScheduler or container cron) only creates jobs; N consumer processes execute them.

---

## 8. API routes (Next.js)

| Method & route | Caller | Does |
|---|---|---|
| `POST /api/founders` | public | Validates (Zod), inserts into the list, assigns seat (≤ 48), sends welcome; rate limit per IP |
| `GET /api/founders/seats` | public | Seats remaining (cache 60 s) |
| `POST /api/radar/cnpj` | visitor/user | Creates or reads visitor (cookie), reads `companies`; if missing, `company_lookup` job → 202 |
| `GET /api/radar/tenders?group=compatible&state=SP&q=` | visitor/user | Reads from DB; groups Compatible / Check / Keyword |
| `GET /api/tenders/:id` | visitor/user | Header + items; files only with an account |
| `POST /api/tenders/:id/screening` | visitor (2) / Básico (5/month) | Checks quota → if an analysis for the current version exists, returns it and records usage; otherwise priority-1 job → 202 |
| `POST /api/tenders/:id/deep-analysis` | Essencial/Pro | Same, deep mode, plan quota |
| `GET /api/jobs/:id` or SSE `/api/jobs/:id/stream` | owner | Job state |
| `POST /api/telegram/webhook` | Telegram | Checks `X-Telegram-Bot-Api-Secret-Token`; `/start <token>` links the chat to the user |
| `POST /api/asaas/webhook` | Asaas | Checks header token; idempotent by event id; updates `subscriptions` and `users.plan` |
| `POST /api/subscribe` | user | Creates Asaas customer and subscription (Promocional R$ 26 for founders with a seat, otherwise Essencial R$ 57 or Pro R$ 98) and returns the checkout link. **Creates the customer with `notificationDisabled: true`** — see the Asaas row in §9.2 |
| `GET /api/health` | monitor | DB, age of last `sync_open_tenders`, stuck queue |

**Quota checks:** always server-side, in a transaction (`usage` in the period + `plan_limits`). Visitors are identified by a signed cookie (`httpOnly`, 30 days); the 3-day rule counts from `visitors.created_at` **and** from the first search of that CNPJ (decided: per device and per CNPJ), so resetting via incognito does not reset the CNPJ.

---

## 9. External integrations

| Service | Use | Auth | Limits and cautions |
|---|---|---|---|
| PNCP `/api/search/` | tender list (same as the portal UI) | public | `ufs=SP\|RJ`, `modalidades=6\|8`, `tam_pagina=50`; broad results: filter by item |
| PNCP `/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/itens`, `/arquivos`, `/itens/{n}/resultados` | items, files, winners | public | 1 call per awarded item; no batch endpoint |
| PNCP `/api/consulta/v1/orgaos/{cnpj}/compras/{ano}/{seq}` | detail | public | unstable → circuit breaker |
| PNCP consulta by period (`/v1/contratacoes/publicacao`, `/atualizacao`) | incremental sync | public | **To validate** as a complement to search so no tender is missed |
| BrasilAPI `/api/cnpj/v1/{cnpj}` | CNAEs, size, MEI | public | No SLA: 30-day cache and fallback (user enters CNAE) |
| OpenRouter | screening and analysis | `OPENROUTER_API_KEY` on the worker only | Monthly spend cap on the account; alert at 80% |
| Telegram Bot API | alerts and account linking | bot token | ~30 msg/s; webhook with secret. **Temporary bot:** a bot has only one webhook URL, so confirm the existing bot is not serving another system before pointing it to LicitaQui; later switch to the official bot (avatar `Marca/assest/avatar-bot-512.png`) |
| Email (Resend) | magic link, founders welcome, opening notice, 30-day price notice | API key | **During development:** Resend test sender (delivers only to the account owner's address — enough to test flows). **Before emailing real users:** verify a sending domain |
| Asaas | subscription, Pix/card | API key + webhook token (separate sandbox and production keys) | Sandbox for development and previews; customer invoices (NF) out of scope for now. **Asaas bills us for the billing notifications it sends on our behalf** (e-mail, SMS, WhatsApp, voice), and they are **on by default**: every customer must be created with `notificationDisabled: true`, and any created without it fixed via `PUT /v3/notifications/batch` (`enabled: false`). LicitaQui does its own messaging, so an Asaas notification is both a duplicate to the user and a line on our invoice |
| Evolution API (already on Easypanel) | WhatsApp: founders welcome and opening notice in Phase 0; alerts on Pro | instance API key | Unofficial API: risk of number ban. Dedicated number, opt-in only (consent checkbox), low rate (≈ 1 message every 20–30 s), no bulk blasts, honor "SAIR" replies |
| SearchApi (Pro, phase 2) | retail price | `SEARCHAPI_KEY` | US$ 40 per 10k searches |

---

## 10. Plans, quotas and what each screen unlocks

| Feature | Visitor (3 days) | Básico R$ 0 (with account) | Essencial R$ 57 · Promocional R$ 26 for 6 months (48 founders) | Pro R$ 98 |
|---|---|---|---|---|
| Search by CNPJ or keyword | yes | yes | yes | yes |
| AI screening | 2 total | 5/month | unlimited | unlimited |
| Edital and annexes | locked | yes | yes | yes |
| Telegram alert | locked | 1/week, 1 keyword, 1 state | daily, 10 keywords + CNAE | + WhatsApp and triggers |
| Winning price range and target purchase price | locked → Essencial | locked → Essencial | yes | yes |
| Deep analysis with citations | — | — | 10/month | 60/month |
| Competitors (name and CNPJ) | — | — | range without names | yes |

Numbers live in `plan_limits`, not in code.

**Tender status and watching (see `TENDER_STATUS_AND_WATCH.md`):** `situacaoCompraId` is 1 Divulgada, 2 Revogada, 3 Anulada, 4 Suspensa. It is stored on `tenders` and is a **state of the screen**: anything other than 1 forbids urgency copy (task B9). The `watch_tender` job (task B10) refreshes watched tenders daily — twice a day in the last 3 days before `dataEncerramentoProposta`, because the 6-hour header TTL in §3 is too loose near a deadline — and diffs status, `dataEncerramentoProposta` and the file list to raise change alerts. The PNCP has no impugnação endpoint; suspension, retificação and adiamento are detected through those three signals, and file detection matches the **title**, since `tipoDocumento` is "Outros Documentos" for most documents.

**Billing messages are ours, not Asaas's:** Asaas charges per customer notification, so customer notifications are **disabled** in the account. Every billing message — the reminder before each charge, the payment-failed notice and the suspension notice — is sent by our own `charge_reminder` / billing jobs. Baseline channel is e-mail (Resend, domain verified); WhatsApp and Telegram are extra channels when the user opted in. The reminder goes **3 days before each charge**, states the date and the amount that will be charged, is idempotent per (subscription, due date), and is never sent for a cancelled subscription.

**Promocional price change:** a daily job `promo_price_change` (1) emails founders whose `promo_ends_on` is 30 days away, and (2) on `promo_ends_on` updates the Asaas subscription value from R$ 26.00 to R$ 57.00 and sets `plan = essencial`. Never charge the new price without the notice having been sent.

---

## 11. Brand in the product

Source: `Marca/assest/LEIAME.md`.

- **Name:** always `LicitaQui` — never `licitaqui`, `Licitaqui` or `LICITAQUI` (lowercase only in domains, repo and bot handles). Only "Qui" in Blue `#2457D6`.
- **Wordmark type:** Archivo 800, width 85%, letter-spacing −3% — shipped as **outlines** in `components/logo.tsx`, not as live text. The width axis is therefore **not** loaded in the web app: it had exactly one reader, the wordmark, and carrying it cost 90KB of preloaded Latin on every route. `app/fonts.ts` pins Archivo to the weights the product sets (600/700/800). Anything drawing the wordmark outside this repo still needs `Archivo:wdth,wght@62..125,100..900`, or outlines of its own. *(Changed 2026-09-22, task prelaunch-fixes — the geometry is unchanged, only how it is rendered.)*
- **Symbol:** three bars on a 64 grid (height 11, gaps 4): blue x34 y12 w22 · graphite x8 y27 w48 · graphite x14 y42 w42. Never right-align or sort the bars. Light Blue `#5C86EC` only on dark backgrounds.
- **Clear space:** at least twice a bar height (22 on the 64 grid).
- **PWA manifest:** `icone-192.png`, `icone-512.png` (`purpose: "any"`), `icone-maskable-512.png` (`purpose: "maskable"`), `theme_color #FBF7F3`, `background_color #FBF7F3`. Favicons `favicon-16.png`, `favicon-32.png`; dark variant `icone-512-escuro.png`.
- **Telegram bot:** display name "LicitaQui", avatar `avatar-bot-512.png` (Ivory on blue).
- `licitaqui-assinatura.svg` uses live Archivo text: convert to outlines before sending to third parties.

---

## 12. Security and LGPD (Brazilian data protection law)

- Secrets only in environment variables (Vercel, Easypanel and GitHub Actions). Repo has `.env.example` and **no** keys. Enable GitHub secret scanning and push protection.
- Keys exposed in earlier conversations (Mercado Livre, SearchApi) must be **rotated** before production.
- `OPENROUTER_API_KEY`, the Asaas key and the Telegram token never reach the browser.
- PNCP awards may include the CPF (personal tax id) of individual winners: mask on write, show only CNPJ.
- Founders list and sign-up: explicit consent checkbox for WhatsApp/email contact; privacy policy and terms published before the Offer goes live; deletion requests handled by email.
- No automated scraping of Instagram profiles (platform terms and LGPD).
- Webhooks: validate signature/token, store in `webhook_events`, process idempotently.
- Neon: TLS only (`sslmode=require`); least-privilege `app` role separate from `migrator`; rotate passwords if a connection string leaks; never expose connection strings to the browser.
- Weekly `pg_dump` to an encrypted S3 bucket and a monthly restore test into a Neon branch.

---

## 13. Environments, CI/CD and quality

| Environment | Web | Worker | Database |
|---|---|---|---|
| Local | `pnpm dev` | `docker compose up worker` | Neon `dev` branch (or Docker Postgres), seeded with the 3 answer-key tenders |
| Preview (each PR) | Vercel Preview URL | — (reads seed data) | Neon preview branch (deleted when the PR closes) or shared `preview` branch, Asaas sandbox |
| Production | Vercel Production (`main`) · `https://<project>.vercel.app` | image `ghcr.io/scintechn/licitaqui-worker:sha` on Easypanel | Neon `main` branch, Asaas production |

**GitHub Actions**
- `ci-web.yml`: lint, typecheck, tests (Vitest), build.
- `ci-worker.yml`: ruff, pytest, image build and push; Easypanel webhook to redeploy.
- `migrate.yml`: applies `db/migrations` (direct connection, `migrator` role) to the preview branch on PR and to `main` on merge, before deploy.
- `evaluate-ai.yml`: when `worker/licitaqui/ai_tender.py` or prompts change, runs the battery against `gabaritos/` and fails if scores drop (screening < 95% correct, deep < 95% or citations < 90%).

**Minimum tests:** Brazilian date and number parsing (`_num`, "12 meses, prorrogável", "05 anos"), ME/EPP and favored-treatment rule, quota counting, concurrent founder-seat assignment, repeated Asaas webhook.

---

## 14. Observability and gate metrics

Events stored in `events`: `offer_viewed`, `founder_signed_up`, `cnpj_searched`, `screening_requested`, `screening_viewed`, `tender_opened`, `account_created`, `telegram_linked`, `alert_sent`, `alert_opened`, `locked_block_clicked`, `checkout_opened`, `subscription_active`, `cancelled`.

Ready-made queries (simple protected `/admin` page):
- Phase 0 gate (2026-11-06): founders signed up (≥ 150), CNPJs searched (≥ 300), Telegram linked (≥ 100), concierge users paying (≥ 6 of 20), founder seats paid (≥ 15 of 48), weekly digest open rate (≥ 50%).
- Operations: age of last `sync_open_tenders`, failed jobs by kind, AI cost today and this month, average screening time.

---

## 15. Infrastructure cost

| Item | Monthly |
|---|---|
| AWS (EC2/Easypanel for the worker and Evolution API + S3) | R$ 200–250 (unchanged) |
| Neon via Vercel (Free plan) | R$ 0 while inside Free limits; any upgrade billed on the Vercel invoice |
| Vercel Pro | US$ 20 (~R$ 108) |
| AI screening (sampling + on demand) | ~R$ 30 |
| Domain | R$ 0 for now (Vercel URL); ~R$ 7 when registered |
| Sentry, uptime, GitHub | R$ 0 to start |
| Email sending | Resend free tier or Amazon SES ~US$ 0.10 per 1,000 |

---

## 16. Technical deliverables by phase (dates from the study's Phase 0 schedule)

**v1.01 · Founders offer + free Radar (S0–S3, 2026-09-17 → 10-11)**
1. Repo, Neon project + branches, migrations for sections 6.1–6.3, basic CI, brand assets in `public/`.
2. Offer page with `POST /api/founders` and seat counter — **live 09-24**, before the Radar.
3. Worker: `sync_open_tenders`, `sync_items`, `sync_files`, `company_lookup`, queue and scheduler.
4. Landing with CNPJ → Compatible / Check / Keyword list → Opportunity → Screening.
5. Visitor mode (cookie, 3 days, 2 screenings) and locked blocks leading to the plan.
6. Básico account (email link + Google), Telegram linking, weekly alert. **Founders opening 10-08, 19:00.**
7. Events and gate dashboard. Privacy policy.

**Phase 0 continued (S4–S7, 10-12 → 11-06)**
Public Landing (10-13), Asaas subscriptions in production (Promocional R$ 26 for 6 months → R$ 57; Essencial R$ 57; Pro R$ 98), webhook, 1-click cancellation, deep analysis with quota, awards for concierge segments. Subscription link to the 48 founders on 10-29.

**v1 · Essencial (6–8 weeks after gate 0)**
Daily alerts, ME/EPP and value filters, `sync_awards` + winning price range by state, target price and margin calculator, (The 3-day charge reminder moved to Phase 0 / M5 — see §10, task F4.)

**v2 · Pro**
Competitors with name and CNPJ, market price (SearchApi), opportunity score, WhatsApp and triggers, OCR for scanned PDFs, more answer keys (construction, continuous services).

---

## 17. Technical decisions

| # | Decision | Status | Value |
|---|---|---|---|
| 1 | Where Postgres runs | ✅ decided | Neon, new project `licitaqui` (§5.1) |
| 2 | Neon region | at creation | Closest to users and Vercel functions: São Paulo (`aws-sa-east-1` + `gru1`) if offered, else `aws-us-east-1` + `iad1`. Not tied to the EC2. Cannot be changed later |
| 3 | Login | ✅ decided | Email magic link + Google |
| 4 | Screenings/month on Básico | ✅ decided | 5 |
| 5 | Visitor's 3 days | ✅ decided | Per device and per CNPJ |
| 6 | Sync source | open (spike G7) | Both: search for "receiving proposals", period queries to catch updates |
| 7 | Domain | ✅ for now | Vercel URL; register `licitaqui` domain later |
| 8 | Email | ✅ for now | Resend test sender during development; verified sending domain before emailing real users |
| 9 | Telegram and WhatsApp | ✅ | Existing Telegram bot (temporary, official bot later) and WhatsApp via Evolution API, both connected during development |
| 10 | Customer invoices (NF) | later | To be defined with the accountant; no invoice promise in the product |
