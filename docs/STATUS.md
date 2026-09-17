# Status log

One line per task: date · task ID · status · PR link · follow-ups.

| Date | Task | Status | PR | Follow-ups |
|---|---|---|---|---|
| 2026-09-17 | Session 1 (bootstrap) | done | — | see open items below |
| 2026-09-17 | Vercel first deploy | blocked | — | pnpm build fix pushed (95a32bc); project keeps returning to paused, deploys BLOCKED/CANCELED before build starts |

## Open items from Session 1

| # | Item | Blocks | Owner |
|---|---|---|---|
| 1 | **G1 — Neon not created.** Vercel → Storage → Create database → Neon, project `licitaqui`, Free plan, region São Paulo (`aws-sa-east-1`) if offered (spec §5.1). Cannot be changed later. | A2 | Sci |
| 2 | **Vercel project not linked.** Root Directory must be `apps/web`. | A1 | Sci |
| 2b | **Vercel project is paused.** Deploys go BLOCKED or CANCELED with no build logs. Unpausing via API worked once (`paused: false`) but the project returned to `live: false` and the next deploy was canceled immediately. Most likely Spend Management on the team, or a manual pause. Check Vercel → Settings → Billing → Spend Management. | all deploys | Sci |
| 2c | **Deploy attribution.** Deployments are created by Vercel user `scintechn-4604` (development@scintechn.com) via the GitHub integration; Sci wants them under his own `scintechn` user. Requires reconnecting the GitHub integration under that account in the dashboard. | — | Sci |
| 2d | **Root Directory not set to `apps/web`** (spec §4); the project currently builds from the repo root. | A1 | Sci |
| 3 | **GitHub secret scanning unavailable** on this private repo (API returns 422 — needs GitHub Secret Protection, or a public repo). Spec §12 assumes it is on; pick a substitute (e.g. gitleaks in CI) or accept the gap. | A1 | Sci |
| 4 | **Docker not installed locally.** Needed to build the worker image and run `docker compose up`. | B1 | Sci |
| 5 | **Python 3.14.7 locally, worker targets 3.12.** Docker image pins 3.12, so CI and production are correct; only the local venv differs. | B1 | Sci |
| 6 | `apps/web/styles/tokens.css` is a documented stub. | D1 | agent |
| 7 | `.github/workflows/` is empty — `ci-web.yml`, `ci-worker.yml`, `migrate.yml`, `evaluate-ai.yml` are task A1/A3/C1 scope (spec §13). | A1 | agent |

## Notes

- The repository lives at `/Users/sci/Claude/Projects/LicitaQui`, **not** inside the
  knowledge-base folder as the original `CLAUDE.md` §5 assumed. The pointer in `CLAUDE.md`
  is therefore an absolute path to `/Users/sci/Documents/POC Licitacao`.
- `pnpm-workspace.yaml` declares `onlyBuiltDependencies: [unrs-resolver]` so that
  `pnpm install` does not stop for approval in CI.
