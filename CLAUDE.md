# LicitaQui — agent guide

- Read `docs/TECHNICAL_SPEC.md` and `docs/DEVELOPMENT_PLAN.md` before any task.
- **`docs/CLAIMS.md` is the register of promises the product has made and not
  yet kept** — the claim, where it renders, what would make it true, and the
  date it comes due. **Read it before writing or approving any user-facing
  sentence, and before any launch date.** It exists because the same defect was
  found four times in two days from four directions: a sentence describing
  something the product does not do. `DEVELOPMENT_PLAN.md` knows what is
  unbuilt; it does not know what has already been promised in public, and the
  join between those two is where every one of them hid. A new claim that is
  not yet true gets a row **in the same PR** — the mirror of the "a later in a
  comment is not a task" rule below.
- `docs/TO_VALIDATE.md` lists contradictions waiting on Sci. Check it before
  changing billing copy, legal text or the `subscriptions` schema — the answer may
  already be known to be undecided. The task card is the scope; do not widen it.
- Code, identifiers, tables, commits: English. User-facing copy: Brazilian Portuguese in `apps/web/messages/pt-BR.json`.
- Never read PNCP/BrasilAPI/OpenRouter inside a web request; enqueue a job (spec §3).
- **PNCP refuses some origins outright, so a measurement that needs it runs on the
  worker, not here.** On 2026-09-29/30 every `GET /api/search/` from Sci's laptop
  answered `ReadError: [Errno 54] Connection reset by peer` — including the
  client's own known-good parameter shape, so not a malformed query — while the
  same endpoint served the worker 47 times in 24 h. Run locally, B17's comparison
  would have reported that we hold **0%** of the open editais: a measurement of
  our own blocked connection. `coverage_check` exists for this reason and **raises
  on an empty walk instead of recording a zero**. Write any new PNCP measurement
  the same way, and see `memory: empty-result-is-not-absence`.

  **Before blaming PNCP, run the check that tells the two apart.** *"PNCP is down"*
  and *"PNCP is refusing us"* look identical from one machine, and the answer is a
  single query — the worker and the laptop hit the same endpoint, so ask what the
  worker just did:

  ```sql
  select kind, status, count(*), max(updated_at) from jobs
   where updated_at > now() - interval '3 hours' group by 1,2 order by 1,2;
  ```

  `sync_open_tenders` **is** `/api/search/`. On 2026-09-30 at 10:50 UTC — with the
  site apparently down and every local request reset — it read **7 done at 10:35**,
  so the endpoint was serving and only this origin was refused. Two things that
  query also settles: the breaker is **per endpoint** (`pncp-resultados` was open
  that morning while search was healthy), and the **public website and the API are
  different surfaces** that fail independently. "PNCP is down" is rarely true of
  all of it.
- Never commit secrets. Use `.env.example`. Never log CPF, emails or tokens.
- Every change: tests for new logic, `pnpm lint && pnpm typecheck && pnpm test` (web) or `ruff check && pytest` (worker) green.
- **The worker suite takes ~43 minutes locally and prints nothing until the end.**
  1 175 tests, 2 567 s, measured 2026-09-30; the `test_integration_*` files carry
  almost all of it because each one talks to the shared Neon test databases. It
  looks exactly like a hang, and on 2026-09-30 it was killed three times and
  reported as one — after which the same run, left alone, passed. Start it in the
  background and let it finish; `pytest tests/ --ignore-glob="tests/test_integration_*.py"`
  is the 42-second answer while you iterate, and it was 852 green with the slow
  half still to come. Do not run two at once: they share those databases, which
  is B24.
- Schema changes only via `db/migrations`, in their own PR. **They apply
  themselves**: `.github/workflows/migrate.yml` runs `db/migrate.py` on every
  push to `main` that touches `db/migrations/**`, so a merged migration is
  live within seconds and `pnpm db:migrate` by hand is for recovery, not for
  shipping. On 2026-10-01 a whole manual procedure was written out for Sci —
  credentials, roles, pooling, the lot — for a workflow that had already run
  the migration eighteen seconds after the PR merged. **Before writing any
  operational runbook, grep `.github/workflows/`**: the question is almost
  never "what are the steps", it is "what already does this".
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
- **The branch under you can change while you work, and the stash stack is shared.**
  On 2026-09-30 a session committed to `perf/worker-wake-and-coverage`, ran tests,
  and found itself on `fix/objeto-trim` holding another lane's uncommitted files —
  another agent had checked out the main tree in between. It then ran bare
  `git stash` / `git stash pop` there to test a baseline. The files came back
  intact, but by luck: the stash stack is shared across every worktree, so a bare
  `pop` can restore somebody else's work or let theirs swallow yours. In the main
  checkout: print `git branch --show-current` immediately before any git command
  that writes; never bare-stash (use a WIP commit, or `git stash push -u -m
  "<tag>"` and `apply` by SHA); push finished work by refspec — `git push origin
  <branch>:<branch>` — which touches no working tree; and when you need a tree of
  your own, `git worktree add` one, which disturbs nothing.
- **A merge can silently drop your card.** B26 and B27 were written, committed and
  merged in #175 — and were **not in `main`** afterwards, because the
  `DEVELOPMENT_PLAN.md` conflict was resolved in favour of another lane's copy.
  Both had to be recovered from the branch. After a PR merges, `grep` `main` for
  the card ids it added: the code landing says nothing about whether the row did.
- **`docs/PRICE_BAND.md` is the whole price band in one file** — the pipeline, every
  gate and why it holds that value, the measured coverage and cost, the supply side,
  and what a replacement data source would have to beat. Read it before touching
  `comparables.ts`, `price-band.ts`, `product-key.ts`, the `awards` table or any
  price copy. It exists because those facts were spread across six cards, three
  docs and a measurement nobody could find twice.
- AI prompt or extraction changes must run `worker/evaluation` and report the score diff.
- **A "later" in a comment is not a task.** If your change leaves something for
  somebody else — a column nothing reads yet, a string nothing renders, an event
  nothing fires, a prop nothing passes — it gets a card in
  `docs/DEVELOPMENT_PLAN.md` §5 **in the same PR**, or you do not write it.
  Five instances of this shape have been found in this repo:
  `tenders.short_title` (8 712 rows, read by no screen for days — its handoff
  was a sentence inside `0005_tender_short_title.sql`), `locked_block_clicked`
  (in the closed catalogue, fired nowhere), `radar.list.changeCompany` (approved
  copy, rendered nowhere), `radar.opportunity.screeningCost` (written, tested,
  never passed) and `alert_deliveries.opened_at` (read by a Gate 0 card, written
  by nothing). Every one of them was a truthful task report about work that did
  nothing, and the tests passed throughout.

## Clocks

Three of them, and mixing two has already produced a wrong answer here:

| | |
|---|---|
| **The product** | `America/Sao_Paulo` (BRT, UTC−3). Every deadline a user reads, the Monday 07:00 digest, "último dia" |
| **The database and the logs** | **UTC.** `now()`, `created_at`, every `ts` in the worker's JSON logs |
| **Sci's laptop** | Portugal (WEST, UTC+1 in summer) |

So a shell `date` is **four hours ahead of the product** and one hour ahead of
the database. On 2026-09-23 a worker was declared stalled for an hour on exactly
that mistake — a database `now()` read against a local clock. It was six minutes.

Always state which clock a time is in, and compare like with like: take both
sides from `now()`, or convert explicitly (`at time zone 'America/Sao_Paulo'`).
A scheduled job's hour is BRT (`scheduler.py`'s `daily_at`), and the row it
writes is UTC.

- Design: use tokens from `apps/web/styles/tokens.css` (Ivory/Graphite/Blue, Archivo/IBM Plex). Brand name is always "LicitaQui".
- **The landing (`/`) has no founders strip above the header.** Sci removed it on
  2026-10-01 (#206). `landing_radar.html` still draws it, so a port from that file
  will bring it back. See `docs/design/README.md`.
- **Inside the app shell, a breakpoint above ~720px is a container query, never a
  viewport one.** `components/app-shell.tsx` puts a rail in the layout flow from
  `lg` (1024px), **264px** wide — or 56px, because the reader can collapse it and
  that state is `localStorage`, which no media query can observe at all. `main` then
  takes another 40px of gutter, so at the moment the rail appears the content box is
  **720px**. A viewport breakpoint at or below 720 is safe (the rail does not exist
  yet, and by 1024 the content has already cleared it); **anything above 720 is
  asking about the window while the block lives in the column**, and is wrong by up
  to 264px. Use `@container` on a wrapper and `@min-[Npx]:` on the child, as
  `app/(public)/fundadores/page.tsx` and the tender screen do, and write the
  arithmetic in the comment. D29 is what this costs when it is missing: two columns
  drawn in 760px between 1024px and ~1164px, from two numbers chosen in different
  cards that never met. D30 was the same defect in `radar-view.tsx` and is fixed. **What that sweep
  missed is the other spelling**: `min-[Npx]:` was searched and every one of
  them was safe, but `md:`, `lg:` and `xl:` were not, and `tender-items.tsx`
  swaps a five-column table for a stacked list at `md:` — 768px of *window* —
  inside the same shell. That is D32. Search both spellings.

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
4b. **Review before merging, not after.** On 2026-09-24 two independent reviews
   found ten defects in work already reported as done, three of them live on
   production — including a 500 on the founders signup shipped hours earlier by
   the change meant to fix that exact path. Every one had a green suite.

   The pattern was identical each time: **the test exercised the unit, not the
   path.** A menu's own test rendered the component and never asked whether
   anything could reach it — the trigger was never rendered. Every fixture in
   the signup suite passed a CNPJ, so the optional case was untested, and
   `/fundadores` had no browser test at all. One test *required* its own bug to
   pass.

   So: a green suite is not evidence a path works. Before merging anything
   beyond a one-line fix, have something read the diff that did not write it,
   and tell it that tests passing is not evidence. Ask specifically for defects
   where the tests pass and the behaviour is wrong.

   And when you mutation-check, **assert the mutation applied** — and **assert
   the restore too**. A `replace` that matched nothing prints success and proves
   nothing; that happened here in the same afternoon. Two more ways it lies, both
   on 2026-09-30 in D29: a `grep -c` check counts **lines, not occurrences**, so
   four changed classes on one line read as "1" and the check reported a mutation
   that had in fact applied; and a `cd` inside a compound command left the restore
   running in the wrong directory, so it silently never ran and the file stayed
   mutated. A third, same day: `perl -pi -e '...  if !$done++'` evaluates that
   guard **per line**, so it fired on line 1, matched nothing and reported
   success — and the `grep` that followed found the word inside a *comment* and
   read as confirmation. Assert the mutation **as code**, not as a string that
   appears somewhere in the file. Compare the restored file to the pre-mutation
   `md5`: a byte-identical restore is the only proof you put it back.

   A fourth, 2026-10-01, and the quietest yet: **a check in the middle of an
   `&&` chain aborts the chain when it finds nothing.** `grep -c` exits 1 on
   zero matches, so

   ```bash
   cp old.py file.py; grep -c chave file.py && python -m evaluation ...
   ```

   printed `0` and **never ran the evaluation** — while the restore after the
   `;` ran as normal, leaving a tree that looked correct and a measurement that
   had not happened. It was reported as a completed baseline run with no
   output. Put the verification *inside* the thing that must fail (an `assert`
   in the script), never as a shell predicate guarding it, and make a run that
   produced no result say so loudly.

4c. **What `environment: 'node'` cannot see, it cannot fail on.** `vitest.config.mts`
   has no jsdom; component tests are `renderToStaticMarkup` string assertions. Two
   whole classes of defect are therefore invisible **by construction**, and both
   shipped green in the same week:

   - **An effect undoing what the first render decided.** `useEffect` never runs
     in that suite, so a test reads the initial state and passes while the browser
     shows something else. D24: `?tab=files` *was* read, by the `useState`
     initialiser, and a `setTab('items')` on mount discarded it one render later —
     the parameter was correct for exactly one frame.
   - **Layout.** There are no boxes to measure, so a block can pass every assertion
     and still be drawn wrong. D29: two columns rendered inside 760px because a
     `min-[900px]` viewport query could not know the desktop rail had taken 264px.

   Neither is a reason to write a weaker test — it is the signal to reach for
   `apps/web/e2e/`. Pin the *mechanism* in the unit test and the *result* in
   Playwright, and say in the PR which one is doing which.
4d. **When a limit turns out not to exist, change the shape, not the constant.**
   `/admin`'s Neon card measured a **Launch** project against **Free**'s 0.5 GB
   and would have rendered *338% and a red alert* on a database in no danger —
   a false alarm on the one screen whose purpose is warning before Neon stops
   the database. The first fix proposed Launch's "10 GB": a number that does not
   exist, inferred from remembered quotas and reported to Sci as though
   measured. Launch removes the limits and prices storage per GB-month, so the
   answer was a nullable limit — no ratio, no bar, no alert — and a **cost**
   where the ceiling used to be. Before pinning a threshold, check it is one;
   and always say which figures you measured and which you inferred.

5. Append one line to `docs/STATUS.md`: date · task ID · status · PR link · follow-ups.
   Two open PRs both appending to the end of that file **will** conflict on whichever
   merges second — GitHub says so before git does, and a local `git rebase origin/main`
   applies both appends cleanly. Rebase and force-push with `--force-with-lease`; do not
   resolve it in the web editor.

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
