# Status log

One line per task: date · task ID · status · PR link · follow-ups.

| Date | Task | Status | PR | Follow-ups |
|---|---|---|---|---|
| 2026-09-17 | Session 1 (bootstrap) | done | — | see open items below |
| 2026-09-17 | Vercel first deploy | done | — | Fixed pnpm `allowBuilds`; deployment `dpl_F9xnFqY…` READY, build 24s |
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
