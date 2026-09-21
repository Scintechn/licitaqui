# LicitaQui — agent guide

- Read `docs/TECHNICAL_SPEC.md` and `docs/DEVELOPMENT_PLAN.md` before any task.
- `docs/TO_VALIDATE.md` lists contradictions waiting on Sci. Check it before
  changing billing copy, legal text or the `subscriptions` schema — the answer may
  already be known to be undecided. The task card is the scope; do not widen it.
- Code, identifiers, tables, commits: English. User-facing copy: Brazilian Portuguese in `apps/web/messages/pt-BR.json`.
- Never read PNCP/BrasilAPI/OpenRouter inside a web request; enqueue a job (spec §3).
- Never commit secrets. Use `.env.example`. Never log CPF, emails or tokens.
- Every change: tests for new logic, `pnpm lint && pnpm typecheck && pnpm test` (web) or `ruff check && pytest` (worker) green.
- Schema changes only via `db/migrations`, in their own PR.
- Tests that write to a shared database scope every row by a **per-run** id (see
  `RUN_ID` in `worker/tests/conftest.py`), never by a per-task constant. A task-scoped
  prefix looks isolated and is not: two concurrent runs of the same suite delete each
  other's fixtures.
- When several tasks run in parallel, do not edit shared files others also touch —
  `worker/tests/conftest.py` constants, the shared sections of `worker/README.md`,
  `docs/STATUS.md`. Append your own row or section instead. Three PRs have collided
  there.
- **Never run git in a worktree whose task is still working.** Check first —
  `pgrep -f pytest`, or whether the agent has reported. Resolving a conflict with
  `git reset --hard` in a live worktree destroys uncommitted work: it happened to B4,
  which lost two fixes and had to re-apply them. Wait for the lane to finish, then
  resolve.
- AI prompt or extraction changes must run `worker/evaluation` and report the score diff.
- Design: use tokens from `apps/web/styles/tokens.css` (Ivory/Graphite/Blue, Archivo/IBM Plex). Brand name is always "LicitaQui".

## Knowledge base and POCs

`/Users/sci/Documents/POC Licitacao` — **read-only**. Studies, POC code, cached PNCP
responses, brand source and the original spec snapshot live there; see its `CLAUDE.md` §2
for the folder map and the files that must never be read (`parceria_licita_mei.html`,
`.chaves_poc`, any `.env*`).

Never edit anything in that folder. `docs/TECHNICAL_SPEC.md`, `docs/DEVELOPMENT_PLAN.md`
and `docs/design/` in this repo are copies taken on 2026-09-17 and are now the source of
truth — change them here, not there.

## Git identity (do not get this wrong)

Commits must be authored by the **Scintechn** GitHub account, because Vercel shows the
commit author and deployments must be attributed to it:

```
git config user.name  "Scintechn"
git config user.email "development@scintechn.com"
```

`scintilla.lima@gmail.com` belongs to a different GitHub account (`scintylla`) and will
mis-attribute both the commit and the Vercel deployment. Verify with
`git log --format='%an <%ae>'` before pushing.

## Workflow

1. Sci gives a task ID (e.g. "faça a A1"). Read the card in `docs/DEVELOPMENT_PLAN.md` §5
   and the spec sections it needs.
2. Reply with a short plan: files to create/change, tests, anything missing. Wait for Sci's OK.
3. Work on branch `task/<id>-<slug>`; use a git worktree when several tasks run in parallel.
4. Run the checks. Open a PR listing the card's acceptance criteria as a checklist.
5. Append one line to `docs/STATUS.md`: date · task ID · status · PR link · follow-ups.

Decisions marked open in plan §1.2 are Sci's: stop and ask. External side effects need
Sci's OK — Asaas **sandbox** only, no real messages except to Sci's test contacts, no
migrations on the Neon `main` branch without Sci.

## Legal copy — which copy wins

`docs/legal/` in this repository is the **source of truth**, like every other file
under `docs/`. Sci authors amendments in the knowledge base (`~/Documents/POC
Licitacao/legal/`) and copies them here; from that moment the repository copy is the
one that ships, because `/termos` and `/privacidade` are generated from these files at
build time (`apps/web/lib/legal/document.ts`).

Note that the knowledge base's own `CLAUDE.md` calls its `legal/` folder the source of
truth for legal copy. For this repository that is out of date — resolved by Sci on
2026-09-20. Do not "fix" the repository copy by re-syncing from there without being
asked.

**Never write or edit the legal wording yourself** (legal brief §5). If the product
needs something the documents do not cover, stop and ask Sci. Rendering changes are
fine; sentences are not.
