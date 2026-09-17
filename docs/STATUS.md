# Status log

One line per task: date · task ID · status · PR link · follow-ups.

| Date | Task | Status | PR | Follow-ups |
|---|---|---|---|---|
| 2026-09-17 | Session 1 (bootstrap) | done | — | see open items below |
| 2026-09-17 | Vercel first deploy | done | — | Fixed pnpm `allowBuilds`; deployment `dpl_F9xnFqY…` READY, build 24s |
| 2026-09-17 | F1 (founders signup) | in review | https://github.com/Scintechn/licitaqui/pull/8 | Stacked on #5. Rate limiting is in-memory, not the Postgres store spec §3.3 wants — no `rate_limits` table exists yet; swap touches only `lib/rate-limit.ts`. LGPD consent version/timestamp live in `events.props` for want of a column |
| 2026-09-17 | migrate.yml + db/README | in review | https://github.com/Scintechn/licitaqui/pull/7 | Preview-branch migration job still blocked on Neon preview branching (rest of A2) |
| 2026-09-17 | B0 (spikes G7, G8) | in review | https://github.com/Scintechn/licitaqui/pull/6 | **G7 default overturned, accepted by Sci:** B2 builds on `/contratacoes/atualizacao`. G8: BrasilAPI confirmed. Open: BrasilAPI rate limit unmeasured; re-measure G7 hourly over a day before B2 commits deeply |
| 2026-09-17 | D2 (Offer page) | in review | https://github.com/Scintechn/licitaqui/pull/5 | Follow-ups: reconcile near-duplicate i18n keys with E0 before 09-24; `Field` inputs are 15px and iOS Safari zooms below 16px on a public page (D1 call); footer `[CNPJ]` omitted; privacy/terms links still anchor to `#topo` |
| 2026-09-17 | A3 (migrations + seed) | merged | https://github.com/Scintechn/licitaqui/pull/4 | Migrations applied to `neondb` (22 tables); seed is dev-only. Drizzle `schema.ts` left to R1 |
| 2026-09-17 | G3 (legal texts) | drafted | — | Privacy policy + terms copied to `docs/legal/`. **Not publishable yet**: 19 placeholders unfilled and a lawyer must review §11 liability cap, §6 price clause, §15 forum |
| 2026-09-17 | A2 (Neon roles + extensions) | partial | — | Extensions and least-privilege roles done and verified. Remaining: `dev` branch, preview-branch automation, `pg_dump` stub — all need Neon console/API access |
| 2026-09-17 | D1 (design tokens) | merged | https://github.com/Scintechn/licitaqui/pull/3 | 34 tests; Tailwind v4 `@theme` tokens, 12 components, `/dev/components` |
| 2026-09-17 | A1 (CI workflows) | merged | https://github.com/Scintechn/licitaqui/pull/1 | Make `gitleaks` a required status check on `main`; add GHCR push + Easypanel webhook with B1; Sentry DSNs still pending |
| 2026-09-17 | E0 (message texts) | merged | https://github.com/Scintechn/licitaqui/pull/2 | 10 `TODO(Sci):` open, mostly blocked on gap G3 (privacy policy + terms); price-change notice needs legal review |
| 2026-09-17 | Commit attribution fix | done | — | All 5 commits re-authored to Scintechn <development@scintechn.com> (were mis-attributed to `scintylla`). Local safety tag `backup-before-author-fix`, not pushed |

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
