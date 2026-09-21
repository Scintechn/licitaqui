# Status log

One line per task: date · task ID · status · PR link · follow-ups.

| Date | Task | Status | PR | Follow-ups |
|---|---|---|---|---|
| 2026-09-18 | B8 (`sync_awards` + awards backfill) | merged | https://github.com/Scintechn/licitaqui/pull/29 | **4,344 awarded items stored, not the 5,000 the card asks for** — the run stalled at 23:04 BRT when PNCP's `pncp-resultados` breaker opened (880 s) and the consulta host went down again, the same outage recorded against ADR-0001 yesterday; the backfill is committed and re-runnable, so the remaining ~650 rows are ~4 min of collection at the 165–175 rows/min it was sustaining, not a rewrite. Cost of what was collected: **2,988 result requests + 1,100 items requests + ~40 search pages ≈ 4,130 calls** at 4 req/s for 3,635 distinct awarded items (3,186 usable `OK`). **The CPF rule found a real leak and it was not the one expected:** a **MEI's razão social is the proprietor's name followed by their CPF** ("FULANO DE TAL 25510225840") on a record that is `PJ` with a valid CNPJ, so every company rule correctly said *company* and stored a raw CPF — 1 row in 4,344. `mask_embedded_cpf` now scrubs standalone 11-digit runs from every string on both branches, and `--repair-personal-data` fixed the row already written. Verified over the whole table: **zero bare CPFs in any column of any row, `raw` included**. `awarded_on` **is** exposed to the naive-Brasília trap and worse than B2's columns — a `date` loses a whole day, not three hours — handled in `award_date`; it is latent today because `dataResultado` is date-only in all 420 cached records, so it would have started misdating silently the day PNCP adds a time. Full suite **633 passed, 0 skipped** (20:25). Divergences from POC 3 in `worker/README.md`. **Latent, for whoever next touches `worker/tests/conftest.py` deliberately:** its `_delete_*` helpers connect without a `statement_timeout`, so a lock held by a concurrent lane blocks cleanup indefinitely — one full-suite run here hung 79 min on exactly that before a clean re-run; `options="-c statement_timeout=30000"` (what `licitaqui.db.connect` already uses) turns a silent hour into a fast failure. **Open for Sci:** the six "concierge segments" are a placeholder — S3 picks the 20 founders on 10-08, and `AWARDS_SEGMENTS` retargets the collection without a code change |
| 2026-09-20 | B4B (download + extract, the on-demand half of B4) | merged | https://github.com/Scintechn/licitaqui/pull/31 | **The screening path completes end to end again.** `ai_screening.load_document` gained a last source: with no pages/path/URL in the payload it calls `documents.ensure_documents(conn, tender_id)`, which downloads the active Edital and Termo de Referência, extracts them with C1's port, stores PDF and text in S3 and writes `sha256`, `s3_key`, `pages`, `text_version`, `no_text` on `tender_files` (§6.1). Wired **inside** `ai_screening` rather than as a prerequisite job or a chain, so the row the web already enqueues is the one that now works — **no change in `apps/web`**. `extract_text` (§7.1) is registered too, priority 9, for sampling; both go through `ensure_documents`. Downloads: 120 s as a **wall-clock deadline** (an httpx read timeout cannot catch the 929 s stall), 64 MB cap, 2 req/s, `pncp-download` breaker, a 4xx recorded as a breaker success so one dead annexe cannot stop every tender. **All-or-nothing**: a document that cannot be read raises instead of writing a partial analysis under a `files_hash` that claims it read everything. **`MANIFEST_VERSION` was deliberately not bumped** — folding `sha256` into B4's digest would re-analyse every tender at full price and still not detect a silent byte swap, because §3.2 caches the PDF "until the file list changes" and nothing re-fetches; closing that needs a re-validation policy, which is its own decision. **Still open for Sci:** §3.2 says the text lives "in the DB" as well as S3 and `tender_files` has no text column — a `text jsonb`/`text_key` column is a migration PR; `S3_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` need documenting in `.env.example` (a deny rule blocks agents from that file) and setting on the worker, or it runs on a `NullStore` and re-extracts every time; **Reconciled with FH (#27) on merge:** FH's `resolve_files_hash(conn, tender_id, payload)` is the one that survives — I had written a different function of the same name because the brief said it already existed at my base, and it did not. Mine is gone: its precedence was already what FH's `load_document` does with its `files_hash` parameter. `load_document` gains a **fifth** source (the tender's own documents) behind FH's four, and that branch prefers the digest `ensure_documents` computed from the snapshot it chose the documents from — a `sync_files` landing between the two reads would otherwise key an analysis under one list while having read another. FH's `EMPTY_MANIFEST_DIGEST -> None` rule is **narrowed, not dropped**: it guards the four sources where an empty `tender_files` sits beside a document the list never mentioned, while in the fifth the empty list *is* what was read, so it is the honest key and the one the cache probe must look up. the 90-day PDF sweep is designed for (`storage.describe_retention()`) but is its own card |
| 2026-09-18 | B4 (`sync_files`, list only) | merged | https://github.com/Scintechn/licitaqui/pull/23 | Amendment invalidation is by **cache key, not delete**: `files.files_hash_for()` digests the active file list and `ai_analyses` is already unique on `files_hash`, so a superseded analysis simply stops being a hit while staying on the row. **Nothing calls `files_hash_for()` yet** — whoever owns the `ai_screening` enqueue site (C1/R1) must pass it, or the invalidation is inert in production. The digest covers the *list*, not the file bytes: an agency swapping bytes at the same URL without moving `dataPublicacaoPncp` goes undetected until the download card folds `sha256` in under `MANIFEST_VERSION` 2. No migration — the 12 h TTL marker lives in `events` as `sync_files:<tender_id>` (B2's watermark precedent) because `tender_files` has no timestamp column; a `synced_at` column is the honest fix. The 25 integration tests **run for real in CI**: the `TEST_DATABASE_URL_B4` secret already existed and this PR adds the missing line to the `integration (Neon)` job from #21 — `536 passed, 20 skipped in 608s`, B4's file all dots. That job is nevertheless **red, and not for a B4 reason**: all 20 skips are `TEST_DATABASE_URL_E2 is not configured`, which #22 merged without wiring. Adding the env line alone will not fix it — **Sci needs to create E2's test database and secret**, otherwise every PR's integration check stays red |
| 2026-09-18 | C1 (`ai_screening` + POC 4 port) | merged | https://github.com/Scintechn/licitaqui/pull/15 | Extraction, page selection and prompts reproduce the POC **byte for byte** on all three answer-key PDFs, and this harness rescores the POC's own stored answers at exactly 57/58. Live: **58/58 (100%)**, 22/22 cited pages verified, R$ 0,0156 spent across two full runs. Fixed a real bug inherited from the POC's `meses()` ("12 (1 ano)" → 144 months). Model varies ±2 checks run to run (the POC's own runs did too), so the 95% gate has ~3 checks of headroom. **`OPENROUTER_API_KEY` is not a repo secret yet**: until it is, `evaluate-ai.yml` replays recorded answers instead of running live |
| 2026-09-17 | Session 1 (bootstrap) | done | — | see open items below |
| 2026-09-17 | Vercel first deploy | done | — | Fixed pnpm `allowBuilds`; deployment `dpl_F9xnFqY…` READY, build 24s |
| 2026-09-18 | B2 (`sync_open_tenders`) | merged | https://github.com/Scintechn/licitaqui/pull/13 | SP sweep 5,193 tenders in **2.09 min** (budget 30); rerun 0 duplicates; 144 tests. Sweep exercised the **search fallback** — consulta was down — so the primary path is measured only by tests. Found 4 real bugs, one of which was also in the A3 seed (now fixed) |
| 2026-09-18 | B6 (CNAE → segment map, **gap G6**) | merged | https://github.com/Scintechn/licitaqui/pull/16 | 19/20 acceptance. Sci owns the 150-code review of `db/reference/cnae_segments.csv`. Found a real item-side gap: beverages (NCM ch. 22) fall into "Outros" |
| 2026-09-18 | C1 (AI screening port) | merged | https://github.com/Scintechn/licitaqui/pull/15 | **58/58 (100%)** vs the POC's 57/58; R$ 0,0156 spent. CI gate runs in **replay** until `OPENROUTER_API_KEY` is a repo secret |
| 2026-09-18 | B5 (`company_lookup`) | merged | https://github.com/Scintechn/licitaqui/pull/12 | 49/50 resolved, 1 real failure exercised the manual path. Contradicts parts of ADR-0002 (now amended). Rate-limit *ceiling* still unmeasured — lookups stay single-threaded |
| 2026-09-18 | O1 (`/admin` + events) | merged | https://github.com/Scintechn/licitaqui/pull/11 | Needs `ADMIN_EMAILS` + `ADMIN_PASSWORD` set before `/admin` opens at all (fails closed by design). Usage card is half real: this database's size from SQL, project storage and CU-hours need `NEON_API_KEY` |
| 2026-09-17 | B1 (worker skeleton) | merged | https://github.com/Scintechn/licitaqui/pull/9 | 68 tests. **GHCR push + Easypanel deploy NOT done** — still blocked on credentials, `TODO(B1)` in ci-worker.yml stands. Neon compute *suspension* itself unproven (needs 5 idle min + the console); the no-open-session property that causes it is proven |
| 2026-09-17 | Security: migrator credential rotated | done | — | The test DSN (migrator role) was rendered into a subagent transcript by a pytest traceback. Rotated, old password verified rejected, GitHub secret updated. No file or commit was affected |
| 2026-09-17 | F1 (founders signup) | merged | https://github.com/Scintechn/licitaqui/pull/8 | Stacked on #5. Rate limiting is in-memory, not the Postgres store spec §3.3 wants — no `rate_limits` table exists yet; swap touches only `lib/rate-limit.ts`. LGPD consent version/timestamp live in `events.props` for want of a column |
| 2026-09-17 | migrate.yml + db/README | merged | https://github.com/Scintechn/licitaqui/pull/7 | Preview-branch migration job still blocked on Neon preview branching (rest of A2) |
| 2026-09-17 | B0 (spikes G7, G8) | merged | https://github.com/Scintechn/licitaqui/pull/6 | **G7 default overturned, accepted by Sci:** B2 builds on `/contratacoes/atualizacao`. G8: BrasilAPI confirmed. Open: BrasilAPI rate limit unmeasured; re-measure G7 hourly over a day before B2 commits deeply |
| 2026-09-17 | D2 (Offer page) | merged | https://github.com/Scintechn/licitaqui/pull/5 | Follow-ups: reconcile near-duplicate i18n keys with E0 before 09-24; `Field` inputs are 15px and iOS Safari zooms below 16px on a public page (D1 call); footer `[CNPJ]` omitted; privacy/terms links still anchor to `#topo` |
| 2026-09-17 | A3 (migrations + seed) | merged | https://github.com/Scintechn/licitaqui/pull/4 | Migrations applied to `neondb` (22 tables); seed is dev-only. Drizzle `schema.ts` left to R1 |
| 2026-09-17 | G3 (legal texts) | drafted | — | Privacy policy + terms copied to `docs/legal/`. **Not publishable yet**: 19 placeholders unfilled and a lawyer must review §11 liability cap, §6 price clause, §15 forum |
| 2026-09-17 | A2 (Neon roles + extensions) | partial | — | Extensions and least-privilege roles done and verified. Remaining: `dev` branch, preview-branch automation, `pg_dump` stub — all need Neon console/API access |
| 2026-09-17 | D1 (design tokens) | merged | https://github.com/Scintechn/licitaqui/pull/3 | 34 tests; Tailwind v4 `@theme` tokens, 12 components, `/dev/components` |
| 2026-09-17 | A1 (CI workflows) | merged | https://github.com/Scintechn/licitaqui/pull/1 | Make `gitleaks` a required status check on `main`; add GHCR push + Easypanel webhook with B1; Sentry DSNs still pending |
| 2026-09-17 | E0 (message texts) | merged | https://github.com/Scintechn/licitaqui/pull/2 | 10 `TODO(Sci):` open, mostly blocked on gap G3 (privacy policy + terms); price-change notice needs legal review |
| 2026-09-17 | Commit attribution fix | done | — | All 5 commits re-authored to Scintechn <development@scintechn.com> (were mis-attributed to `scintylla`). Local safety tag `backup-before-author-fix`, not pushed |
| 2026-09-18 | B3 (`sync_items` + segments) | merged | https://github.com/Scintechn/licitaqui/pull/17 | Classification matches POC 1 on 489 real cached items (labels generated by the POC, re-derived from it locally), with **one deliberate divergence**: beverages (NCM chapter 22) are rescued from "Outros" — B6's finding, 8 of 8,861 items move, all beverages. Segment values stored are POC 1's pt-BR labels, matching B6's `cnae_segments.segment` so R1 can join them (the classifier works in ASCII keys internally). Neither PNCP bug applies to items: item `orcamentoSigiloso` is a real boolean, and no `tender_items` timestamptz is fed by PNCP. Naive-time and value-zeroing details in `worker/README.md` |
| 2026-09-18 | E2 (WhatsApp founders welcome, **gap G9**) | merged | https://github.com/Scintechn/licitaqui/pull/22 | **Nothing was sent and no live Evolution call was made** — not even to Sci's number. Delivery is off behind `WHATSAPP_DELIVERY`, which only the exact word `send` turns on; a test asserts that with it off the whole job runs while `socket.connect` raises and nothing attempts a connection. The only Evolution instance on the server is `flowdeski-scn-real-estate` (another product), so **end-to-end delivery is unverified** until a LicitaQui instance exists: the `POST /message/sendText` body shape, the Chrome `User-Agent` against the live Cloudflare edge, and whether a message actually arrives. Consent (`founders_list.contact_consent`) is enforced before anything is built; `SAIR` stops further messages. `optout-confirmation` cannot be sent yet — it still carries a `TODO(Sci):` and an undecided `{{email_contato}}` (E0 §7); the opt-out is recorded regardless. Delivery log is `events` rows (`whatsapp.*`), **no migration** |
| 2026-09-18 | R1 (Radar read APIs + `readOrEnqueue`) | merged | https://github.com/Scintechn/licitaqui/pull/24 | 206 web tests. `readOrEnqueue()` is §3.1 in code: fresh serve, stale serve **and** enqueue at priority 5, absent enqueue at priority 1 → 202. Contract tests drive the handlers against the 20 real PNCP seed payloads, re-inserted under a per-**run** agency and company CNPJ. **Follow-up for D3:** `pnpm db:seed` leaves `tenders.segments` null (classification is `sync_items`'s), so the Compatível group is empty on a freshly seeded database — `db/seed.py` should call `licitaqui.items.classify_all` / `roll_up`. Also open: `/api/jobs/:id` has no owner check (no owner column; the projection carries nothing private instead), the visitor cookie is an unsigned v4 UUID verified against `visitors` until U1 brings `AUTH_SECRET`, and the worker's `POST /wake` on a priority-1 enqueue is not wired |
| 2026-09-18 | FH (wire `files_hash` into `ai_screening`) | merged | https://github.com/Scintechn/licitaqui/pull/27 | Closes the B4 → C1 gap: B4 owned the digest, C1 keyed its cache on it, **nothing passed it**, so an amended tender kept serving the analysis of the superseded edital. The hash is resolved **at the execution site** (`ai_screening.resolve_files_hash`), not at enqueue: the queue sits between the two and can outlive the file list — a payload hash would key an analysis of the *new* edital under the *old* digest (permanently, since a cached `ok` is never overwritten), `jobs_dedupe` drops the payload of the request that arrives after the amendment, and a web enqueue site would have to re-implement `MANIFEST_VERSION` in TypeScript and agree byte for byte for ever. **Widened once, deliberately**: `readScreening` in the web served the newest usable row whatever list it was keyed on, so the worker fix alone was invisible to a user — it now filters on the digest the `sync_files:` marker publishes, and falls back to today's behaviour when a tender was never synced. `565 passed, 0 skipped` (worker, every task DB resolved), 212 web tests, lint and typecheck clean. **`sync_files` still does not re-screen** and should not — B4's argument holds. **Still broken for a different reason**: `requestScreening` enqueues `{tender_id}` only and `load_document` raises without a document source, so the queued job fails four times — that is the download card's seam, and it should pick up `tender_files.url` where `resolve_files_hash` now reads the list |
| 2026-09-18 | D3 (Landing, Radar, Opportunity — canvas 01–03) | merged | https://github.com/Scintechn/licitaqui/pull/28 | 300 web tests (was 294 before this lane's own 6 suites; +2 need a database and skip without one). Ported `Main.dc.html` → `/`, `Editais.dc.html` → `/radar`, `Oportunidade.dc.html` → `/radar/edital/[...id]`; verified against the source at 390 px and 1280 px in a real Chrome, and cache headers verified on `next start` (`/` = `s-maxage=600, stale-while-revalidate`, `/radar*` = `private, no-store`). **R1's follow-up is already closed** — `pnpm db:seed` now classifies, so Compatível has content. Additions outside my own files, all append-only: `Select` and a `menu` icon in the design system (canvas 01 needs both), `TenderCard.itemCount` on the wire (the board's "7 itens" was not in the contract), a branded `app/not-found.tsx`. **Open for the next lanes:** the Opportunity CTA links to `/radar/edital/<id>/triagem` (D4) and the app bar to `/conta/criar` and `/conta/alertas` (U1, E1) — all three 404 until those land, which is why the branded 404 exists; the visitor banner is drawn here because canvas 02 draws it, though plan §5 gives it to D4 (one function, `VisitorBanner` in `app/radar/radar-view.tsx`, for D4 to lift); the "não exige atestado / capital mínimo / amostra" ticks on canvas 03 are deliberately **not** rendered — they are screening findings with page references and belong to D4, and printing them from the tender header would state a legal fact about a document nobody has read |
| 2026-09-20 | D3b (Landing: the rest of `landing_radar.html`) | PR open | https://github.com/Scintechn/licitaqui/pull/37 | **333 web tests** (306 at the branch point; +27 here). `/` was the canvas-01 hero alone — about a third of the approved page. Added, in the source's order: the founders strip, the nav and its three section anchors, the **example Radar panel**, `Como funciona`, the opportunity example with the locked price band, the Telegram alert, the three plans, the guarantees, the questions and a footer pointing at `/privacidade` and `/termos`; the `PRÉVIA` banner is deliberately **not** ported and a test pins its absence. **The example panel renders D3's own `TenderCardView`** over three real PNCP tenders from the POCs' answer keys, and is kept visibly an example: headed `EXEMPLO`, captioned with the date it is stated as of, countdowns frozen against that date, and **no card linking anywhere** — `TenderCardView` gained `href={null}` rather than a second tender card being built. **Seat count is F1's**: `lib/founders/seat-count.ts` counts `founders_list` on the server at revalidation (the same count `/fundadores` fetches); when it cannot be read the strip states 48 seats and claims nothing about how many are left — both branches tested. Verified at 390 px and 1280 px in Chrome (`scrollWidth === innerWidth` at both) and on `next start` (`/` prerendered, `s-maxage=600, stale-while-revalidate`, `x-nextjs-cache: HIT`; `/radar` still `private, no-store`). **Two class-conflict bugs the browser caught and `lib/cn.ts` predicts:** `hidden min-[900px]:inline-flex` lost to an `inline-flex` already in the shared class string and shipped the nav visible at 390 px (document 97 px wider than the screen), and a caller's `text-blue` lost to `SectionLabel`'s `text-ink` — fixed at the source (display utility per link; `SectionLabel` gained `tone="accent"`). **Open for Sci:** the desktop source's headline ("Quais licitações abertas combinam com a sua empresa?") was **not** adopted — the page keeps D3's approved canvas-01 title, because rewording a shipped `messages.radar.landing` key other lanes read is a copy call, not a port; `Entrar` points at `/conta/criar` (U1) and 404s until U1 lands; the Pro card carries `Em breve` and **no CTA**, since the source's button leads nowhere; `app/(public)/page-parts.tsx` duplicates the layout primitives `fundadores/page.tsx` declares inline — merging them would touch that file's footer, which the legal lane is editing |

## Open items from Session 1

| # | Item | Blocks | Owner |
|---|---|---|---|
| ~~1~~ | **G1 RESOLVED** — Neon created via Vercel: `neon-bistre-cloud` (id `rapid-mouse-53141905`), **AWS South America East 1 (São Paulo)**, Free plan, default branch `main`. Per spec §5.1 this pairs with Vercel functions in `gru1`, now pinned in `apps/web/vercel.json`. | — | — |
| ~~2~~ | **RESOLVED** — Vercel project linked; Root Directory verified as `apps/web` with `sourceFilesOutsideRootDirectory: true` (correct for the pnpm workspace). No change was needed. | — | — |
| ~~2b~~ | **RESOLVED — and the earlier diagnosis was wrong.** The project was never paused (`paused: false` on every read; `live: false` is normal — every project in this team reports it). The real cause was a **commit-author seat block**: `readyStateReason` = "the commit author doesn't have permission to create deployments", `seatBlock.blockCode: TEAM_ACCESS_REQUIRED` for GitHub user `scintylla`, with `alwaysRefuseToBuild: true` — which is why there were zero build logs. Fixed by re-authoring commits to `Scintechn` (the team owner). | — | — |
| ~~2c~~ | **RESOLVED** — commit author is now `Scintechn`. The Vercel deployment *creator* remains `scintechn-4604` (development@scintechn.com), the account owning the GitHub integration; that is a separate field from commit authorship. | — | — |
| ~~2d~~ | **RESOLVED** — the pending `scintylla` team access request was removed by Sci; no Pro seat consumed. | — | — |
| 2e | **Monorepo affected-projects skipping is ON** (`enableAffectedProjectsDeployments: true`). A commit touching only root-level files can be CANCELED with "the commit didn't affect this project" — this is what happened to the empty retrigger commit, and it looks like a silent failure. | all | agent |
| 3 | **GitHub secret scanning unavailable** on this private repo (API returns 422 — needs GitHub Secret Protection, or a public repo). Spec §12 assumes it is on; pick a substitute (e.g. gitleaks in CI) or accept the gap. | A1 | Sci |
| 4 | **Docker not installed locally.** Needed to build the worker image and run `docker compose up`. | B1 | Sci |
| 5 | **Python 3.14.7 locally, worker targets 3.12.** Docker image pins 3.12, so CI and production are correct; only the local venv differs. | B1 | Sci |
| 6 | `apps/web/styles/tokens.css` is a documented stub. | D1 | agent |
| 7 | `.github/workflows/` is empty — `ci-web.yml`, `ci-worker.yml`, `migrate.yml`, `evaluate-ai.yml` are task A1/A3/C1 scope (spec §13). | A1 | agent |

## Lesson: one shared test database, two agents

B1 and F1 ran concurrently against the same `licitaqui_test` database. B1's unfiltered
`claim()` picked up ~100 job rows created by F1's signup tests and flipped them to
`running`. B1 caught it (its race test claimed rows it had not created) and fixed it
properly: every database test now uses a job kind of its own (`b1t_<uuid>`) and claims
with that filter. The table was left empty.

That was an orchestration mistake, not an agent mistake — handing two parallel agents the
same database invites it. Either give each task its own database, or require a
task-scoped `kind` prefix in the brief. It also produced a genuinely useful production
API: `claim(conn, kinds=[...])` and `WORKER_JOB_KINDS`, so a container can be dedicated
to part of the queue.

## Integration checks (2026-09-17, live)

| Service | Result |
|---|---|
| OpenRouter | ✅ valid, usage 0, **spend limit 50** (gap G4 satisfied) |
| Telegram | ✅ `@LicitaQuiBot`, **no webhook set** — gap G9's worry is clear, E1 can claim it |
| Neon | ✅ both pooled and direct URLs connect |
| Evolution API | ✅ reachable, instance `flowdeski-scn-real-estate` state `open` — **but see the two warnings below** |
| Resend, Asaas, Sentry, Google, S3 | not configured yet — blocks E-mail, F2, observability, U1, B4 respectively |

**Evolution warning 1 — Cloudflare blocks default HTTP clients.** `evolutiondev.scintechn.com`
sits behind Cloudflare, which answers `403 error code: 1010` (browser-signature block) to
`Python-urllib`, *including on `GET /`*. It is not an auth failure and no API key will fix
it. **E2's client must send a browser-like `User-Agent`**, or every WhatsApp send fails 403.
Verified: identical request with a Chrome UA returns 200.

**Evolution warning 2 — the instance belongs to another product.** The only instance on
that server is `flowdeski-scn-real-estate`, i.e. FlowDeski's. Sending LicitaQui's founders
welcome through it would deliver from another product's WhatsApp number. This is the same
trap gap G9 flags for the Telegram bot. **Recommend a dedicated `licitaqui` instance before
E2 sends anything**, even to test contacts.

## Brand channels

- Instagram **@licitaqui** exists (2026-09-17). Marketing channel for the non-dev track
  (plan §5, task S2 influencer outreach). Note spec §12 forbids automated scraping of
  Instagram profiles — it is an outbound channel, never a data source.

## G7 re-measurement in progress (overnight 09-17 → 09-18)

The hourly probe ADR-0001 asked for is running. Early result, and it is not reassuring:

| Sample (UTC) | search | publicacao | atualizacao |
|---|---|---|---|
| 21:21 | 2/2 OK (~1.87 s) | **4/4 timeout** | **4/4 timeout** |
| 22:25 | 2/2 OK | **4/4 timeout** | **4/4 timeout** |
| direct one-off, 45 s timeout | inconclusive (different UA) | **2/2 timeout** | **2/2 timeout** |

The `consulta` host has been timing out for **over an hour** while the search host answers
normally. Every failure is a read timeout, the same signature B0 saw in its 13-minute
outage. ADR-0001's inversion rule is >10% failures over a day, or outages beyond ~2 h.

**RESOLVED by B2's verification — the endpoint choice stands, the cadence is what to
revisit.** B2 answered the open question: the search index's `data_atualizacao_pncp` does
**not** move when only items or files change. It is byte-identical to
`data_publicacao_pncp`, sub-second digits included. Evidence: of 95 cached tenders, **79
(83.2%) had a child change**; of those, **74 matched the header timestamp exactly and 0
matched the global one**. A search-only sweep would have missed all 74 **silently**.

That inverts the inversion rule. The outage is a *freshness* problem, which the queue and
breaker already absorb; falling back to search as the primary would be a *correctness*
problem, and a silent one. **Ignore my earlier hybrid recommendation** — it was written
before this evidence, and search-as-reconciliation cannot detect child changes either, so
it would only catch tenders missed entirely. Revisit cadence and retry policy, not the
endpoint.

**Outage record, for the ADR:** `atualizacao` timed out again
at 00:35 (40 s), while the search host answered in 0.7 s. That is **~3 h 14 min of
continuous timeouts** on the consulta host, against ADR-0001's ">2 h outage" trigger.

The maintenance-window explanation is now the weaker one: 21:21–00:35 UTC is
**18:21–21:35 in Brazil** — peak evening, not a maintenance slot. B0 also recorded the
same host failing at 20:21–20:34 UTC, so the disruption has run since roughly 20:21 UTC
with at most brief recovery.

Six sync cycles were missed. What this costs is delay, not data, because the watermark
only advances when a cycle completes every modality — a partial cycle is retried whole.

**What still needs deciding** is narrower than it looked: how long a consulta outage may
last before it is an incident rather than a delay, and whether a same-day outage should
raise anything in `/admin`. That is O2/observability work, not an architecture fork.

## Two defects found by B5, both worth fixing

1. **CI does not check Python formatting.** `ci-worker.yml` runs `ruff check .` but not
   `ruff format --check .`, so drift lands on `main` unnoticed — it already had, in B0's
   two probe scripts. B5's PR reformats them. **Add the format check to `ci-worker.yml`
   once #12 merges** (doing it before would put `main` red).
2. **B1's integration tests are not isolated between concurrent runs.** Confirmed
   independently by B5 and B2; B2 reproduced it against `main`'s own code with no B2 work
   in the session (2 failures in run 1, 0 in runs 2–3). **It will keep producing spurious
   red CI runs until someone owns it**, and a test suite that cries wolf is worse than one
   that is merely slow.

   Root cause, in `worker/tests/conftest.py`: the cleanup comment says deletes are "scoped
   by prefix", but the prefixes are module **constants** —

   ```python
   KEY_PREFIX = "b1-test-"
   KIND_PREFIX = "b1t_"
   ...
   delete from jobs where starts_with(key, %s) or starts_with(kind, %s)
   ```

   so they scope by *task*, not by *run*. Two concurrent runs of the same suite delete
   each other's fixtures mid-test. My per-agent databases (`TEST_DATABASE_URL_B2/_O1/_B5`)
   isolated the *new* tests but not these inherited ones.

   Fix — make the prefix per-run, ~3 lines:
   ```python
   RUN_ID = uuid.uuid4().hex[:8]
   KEY_PREFIX = f"b1-test-{RUN_ID}-"
   KIND_PREFIX = f"b1t_{RUN_ID}_"
   ```
   **Order matters:** both PR #12 and PR #13 already modify `conftest.py`, so do this
   *after* they merge or it conflicts with two green PRs. That is why it is written down
   here instead of already done.

   Third time a shared test database has caused a problem. Worth a standing rule: every
   test that writes to a shared database scopes its rows by a per-run id, not a per-task
   constant.

## Gap G6 closed (2026-09-18) — pending Sci's review

B6 (PR #16) builds the CNAE → segment map, so "Compatível / Verificar" is computable for
the first time. **572 mappings over 555 of the 1,332 IBGE subclasses; 777 deliberately
unmapped.** Unmapped is not `check`: it means the activity is outside the fourteen
segments, and the Radar falls back to keyword search.

It reversed its own design rule on measurement, which is the part worth trusting:

| Rule | `compatible` per company | 20-CNPJ result |
|---|---|---|
| strongest claim wins (incl. secondaries) | mean 5.75 of 14 | 16/20 |
| **main CNAE decides** (shipped) | mean 0.8 | **19/20** |

A small company's secondary CNAEs are whatever its accountant registered, so letting them
grant `compatible` made almost everything compatible. Secondaries still contribute the
segment at `check`.

The single miss was the agent's own expectation being wrong, not the map — and it said so
rather than adjusting the expectation to fit.

**Sci owns the 150-code review** (plan §5). Start with `db/reference/cnae_segments.csv`,
and focus where B6 says its judgement has no data behind it: the goods-versus-services
line (`8121400` *limpeza em prédios* and health divisions 86–87 are `check` — if concierge
tenders are mostly cleaning *services*, that should flip), retail 47 / wholesale 46 where
MEI/ME actually live, and the six catch-all codes left unmapped on purpose.

## Still to do after B3 and B6 land

- **Finish the per-run scoping.** PR #14 made `conftest.py`'s `jobs` prefixes `RUN_ID`-based
  but missed the other half: B2's sync tests scope `tenders` rows by a **constant CNPJ**
  (`99000000000102`), so two concurrent runs of `test_integration_sync_tenders.py` still
  delete each other's rows. C1 hit it live while B3 was running the same file. Same defect,
  different table — my fix was incomplete. The rule needs to cover **natural keys**, not
  just job keys.
- **Set `OPENROUTER_API_KEY` as a repo secret.** Without it `evaluate-ai.yml` runs in
  replay against committed recordings — it passes, and the report says `REPLAYED`, but the
  gate is not actually exercising the model. A live run costs about R$ 0,004.
- **Document `OPENROUTER_API_KEY` and `TEST_DATABASE_URL_C1` in `.env.example`** — a deny
  rule blocks agents from that file.

## The screening path is still broken end to end (found 2026-09-18 by FH)

`requestScreening` enqueues `{tender_id}` and nothing else. `load_document` requires one
of `pages` / `text_path` / `pdf_path` / `url` and raises `ValueError` otherwise, so the
queued job fails four times and lands `failed`. **A user clicking "analisar" today gets
nothing.**

This is not a defect in C1, B4, R1 or FH — each is correct within its card. It is the
seam none of them owned: B4's card says "list only; **download on demand**", and the
on-demand half was never carded. `tender_files.url` is populated and waiting.

What the missing card has to do: fetch the PDF for a tender's active documents, extract
the text (`pdfplumber`, already a worker dependency), store it per §3.2 — S3 for the PDF,
text in the database, delete the PDF 90 days after closing — and hand `load_document`
what it expects. The seam is `ai_screening.resolve_files_hash`, which already reads the
active list at exactly the right moment.

Two related gaps worth folding in:
- `readScreening` ignores `prompt_version`, so a prompt rollback can still serve a row the
  worker would not consider current.
- B4's digest covers the file **list**, not the bytes. An agency replacing a file at the
  same URL without moving `dataPublicacaoPncp` stays invisible until `tender_files.sha256`
  is folded in under `MANIFEST_VERSION` 2. The seam is ready.

## Open for Sci

- **Event name mismatch.** Spec §14 names the event `founder_signed_up`; F1 writes
  `founder_signup`. O1 kept F1's stored name (changing it was out of its scope) and
  catalogued both. Decide: rename the event and backfill, or amend §14 to match the code.
  Cheap now — a handful of rows — and it only gets more expensive once the gate queries
  and the digest depend on it. Not urgent: the founders gate counts `founders_list` rows
  directly, so the number is right either way.
- **Concierge-paying gate has no source.** §14 lists it among the six Phase 0 gate
  numbers, but no table marks the concierge cohort. `/admin` renders "sem fonte" rather
  than a fabricated 0/20. Needs either a column or a documented manual count before the
  11-06 gate review.

## Decisions (2026-09-17)

- **Auth:** Auth.js / NextAuth v5 stands (spec §5). The `neon_auth` schema the Vercel
  integration provisioned is unused; consider dropping it before launch.
- **Founders form:** **CNPJ is required**, because it determines which licitações a
  business can enter. "O que você vende" (`sells`) stays on the form but is **optional**.
  This makes the rendered form differ from the approved HTML, deliberately.
- **Input font size:** form inputs render at **16px**, not the board's 15px. iOS Safari
  zooms the viewport on focus for anything smaller, which is a real defect on a public
  page opened from a phone. Documented in `components/field.tsx`.
- **i18n duplicates:** where E0's catalogue and D2's page disagree, the approved page's
  rendered wording wins and E0's key naming wins. Reconciled in F1.
- **PNCP sync endpoint (G7):** `/v1/contratacoes/atualizacao`, not the POC search API. The
  search API caps `pagina × tam_pagina` at 10,000 against ~38,856 open tenders and silently
  ignores date filters, so a sweep cannot enumerate everything and misses changes silently;
  an outage on the period endpoint merely delays a cycle. **Inversion rule:** flip back if a
  full-day re-measurement shows >10% failures or outages beyond ~2 h. **Open question for
  B2's first hour:** does the search index's `data_atualizacao_pncp` move when only a
  tender's items or files change? If yes, the correctness argument weakens and search-only
  may win.
- **Branch protection:** not available on a private repo without GitHub Pro. Gap accepted
  — `gitleaks` still runs on every PR, advisory only. Revisit before anyone else commits.

## A2 — what was applied to Neon (2026-09-17)

Neon project `neon-bistre-cloud` (`rapid-mouse-53141905`), São Paulo, database `neondb`,
**PostgreSQL 18.6** (spec §5 says 16 — newer, all required extensions available).

Applied to the **main** branch, with Sci's explicit go-ahead:
- Extensions: `unaccent`, `pg_trgm`, `citext`.
- Role `migrator` — DDL: `USAGE, CREATE ON SCHEMA public`.
- Role `app` — DML only: `USAGE ON SCHEMA public`, `SELECT/INSERT/UPDATE/DELETE` on all
  tables, `USAGE, SELECT` on sequences, plus `ALTER DEFAULT PRIVILEGES FOR ROLE migrator`
  so tables created by migrations are automatically reachable.

Verified, not assumed: `migrator` created a table, `app` did DML on it, `app` was **denied**
`CREATE TABLE`, `unaccent('licitação') = 'licitacao'`, `pg_trgm` similarity and `citext`
case-insensitive compare all behave. Test table dropped afterwards.

Credentials are in `.env.neon-roles.local` (gitignored, mode 600) — never committed.

**Decision (2026-09-17):** the Vercel integration provisioned **Neon Auth** (9 tables in a
`neon_auth` schema). Sci confirmed spec §5 stands: **Auth.js / NextAuth v5**. The
`neon_auth` schema is unused and left untouched; consider dropping it before launch.

## Notes

- The repository lives at `/Users/sci/Claude/Projects/LicitaQui`, **not** inside the
  knowledge-base folder as the original `CLAUDE.md` §5 assumed. The pointer in `CLAUDE.md`
  is therefore an absolute path to `/Users/sci/Documents/POC Licitacao`.
- `pnpm-workspace.yaml` declares `allowBuilds: {unrs-resolver: true}` so that
  `pnpm install` never stops for approval in CI or on Vercel. pnpm 11 does **not** read
  `onlyBuiltDependencies`, and `pnpm rebuild` writes an unresolved placeholder into that
  file — verify a clean `rm -rf node_modules && pnpm install --frozen-lockfile` before
  pushing changes to it.
- Commit identity is pinned in `CLAUDE.md`. Getting it wrong does more than mis-attribute:
  a commit author who is not an approved team member makes Vercel **refuse to build at
  all**, with no build logs to explain it.
- **Regions.** Neon is in São Paulo (`aws-sa-east-1`, permanent). Vercel functions are
  therefore pinned to `gru1` in `apps/web/vercel.json` (spec §5.1). Note the *build*
  region is chosen by Vercel and may still show `iad1` — that is the build machine, not
  where functions execute, and it does not affect query latency.
- `vercel.json` lives in `apps/web/`, not the repo root, because the project's Root
  Directory is `apps/web`.
- **Frozen clocks in date-sensitive tests.** `test_integration_sync_tenders` fixed its
  PNCP records at 2026-09-17 while `sync_open_tenders` built its window from
  `datetime.now()`. The two drifted apart and on **2026-09-19** the search fallback's
  stop value overtook the fixtures, so the outage test wrote zero tenders and `main`
  went red — with no production change involved (`sync_tenders.py` was byte-identical
  to B2's original commit). A test whose result depends on the day it runs is a
  failure with a delayed fuse: pin the clock next to the data it has to agree with.
| 2026-09-20 | G3 (legal pages published: /termos, /privacidade) | in review | https://github.com/Scintechn/licitaqui/pull/PENDING | Closes the gap that mattered most before the founders week: `/fundadores` was **already live and collecting** name, e-mail, CNPJ and WhatsApp behind a consent checkbox that named two documents in **plain text with no links**, and the two pages 404'd. LGPD art. 8 / CDC art. 46 — an acceptance nobody could read is not informed consent. The four files from the knowledge base `legal/` are vendored into `docs/legal/` (v1.1, Sci's 09-20 rewrite) including the new `faq-cobranca.md`; every `TODO(Sci)` is gone because the brief **decided** rather than filled — no published address, no elected forum, `contato@`/`privacidade@` live. `[DATA]` = **20/09/2026**, the day the pages go live: the README ties it to "before the Offer form collects its first e-mail", and that form was already collecting. Pages render **from the Markdown at build time** (`lib/legal/document.ts`, `marked`), never transcribed, so the site and the repo cannot drift. **The drafting note is stripped at render** — each file opens with "Minuta … a ser revisado por um advogado antes de publicar", addressed to Sci and the lawyer; a contract whose first sentence calls itself an unreviewed draft argues against its own enforceability. Removed in the loader, not in Sci's Markdown. Footer now carries the §1 wording verbatim (Scint Tecnologia Serviços Ltda · CNPJ · contato@ · WhatsApp). Both routes prerender static. 324 web tests. **Not done:** lawyer review of §11/§6/§15 (brief §6, due before the first real charge), and `faq-cobranca.md` is vendored but has no `/ajuda` page yet |
| 2026-09-20 | CI: publish the worker image to GHCR | in review | https://github.com/Scintechn/licitaqui/pull/PENDING | Found while checking why production is empty: the database on `main` has **0 tenders, 0 companies, 0 analyses** and one `company_lookup` job **queued since 17:02 with attempts=0** — a real visitor searched a CNPJ on the live /radar and nothing has ever processed it. There is no worker running in production, and the image was never published: `ci-worker.yml` built it and stopped, with a TODO saying to add the push "once GHCR and Easypanel credentials exist". That premise was wrong for GHCR — `GITHUB_TOKEN` plus `packages: write` is enough, no configured secret. So the push now happens on every `main` build, tagged `:sha` and `:latest`. The Easypanel redeploy stays optional and skips with a message when `EASYPANEL_WORKER_WEBHOOK` is unset, so it can never redden `main`. **Still needs Sci:** point an Easypanel service at `ghcr.io/scintechn/licitaqui-worker:latest`, give it the worker env (DATABASE_URL, OPENROUTER_API_KEY, S3_*, AWS_*), and set the webhook secret. Until then M2's "worker in production syncing every 30 min" is unmet and /radar shows an empty database to every visitor |
| 2026-09-21 | D4 (screening screen, canvas 04 + locked price block, canvas 05) | in review | https://github.com/Scintechn/licitaqui/pull/41 | Closes the gap PR #31 left: "analisar" has produced a real analysis since it merged, and there was no screen to show it. `/radar/edital/<id>/triagem` renders a real tender's triagem **with the page of every finding** (exit criterion), `/radar/edital/<id>/preco` renders canvas 05 locked. Verified live against production data on two real PNCP editais screened for this card — `00394544000185-1-002027/2026` (Obra SAA, Jacareacanga/PA, 50 pp, nota 2/10, 8 citações, 8 conferidas, capital mínimo **R$ 169.334,68** from `rules.minimum_capital_brl`, p.35/p.18/p.17/p.4) and `10882594000165-1-000542/2026` (IFSP, nota 10/10, Exclusivo ME/EPP p.12). **Next.js will not nest a segment inside a catch-all** ("Catch-all must be the last part of the URL"), so the three tender screens share `[...id]/page.tsx` and dispatch on the trailing segment (`tender-route.ts`); the board's three addresses are unchanged. Added `GET /api/tenders/:id/screening` — the poll the `POST`'s own docstring already referred to — gated on `hasSpentOn`, so it never spends, never enqueues and never hands a shared analysis to someone who did not pay for it. `VisitorBanner` is **imported** from `radar-view.tsx`, not lifted out of it, because `task/r2-radar-polish` is editing those exact lines. 419 web tests (351 + 68). **Follow-ups:** `compute_rules` writes `minimum_capital_calculation` with Python `:,.2f`, i.e. English separators ("R$ 1,693,346.78") — rendered only as a fallback here, worth fixing in the worker; `lib/founders/signup.db.test.ts` asserts on **all** of `events`, so any earlier run of `radar.db.test.ts` (which leaves `cnpj_searched` rows) makes it fail — pre-existing, clears with a `delete from events where name='cnpj_searched'`; `VisitorBanner` to be lifted into its own file once R2 lands |
