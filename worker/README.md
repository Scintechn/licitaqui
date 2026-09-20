# LicitaQui worker

Python 3.12 collector and job runner (spec §7). Runs as a Docker container on
Easypanel; the web app never calls PNCP itself, it enqueues a job (§2).

## Running

```bash
python -m licitaqui          # scheduler + N consumers + /health and /wake
```

One process: an HTTP thread, `WORKER_CONCURRENCY` consumer threads and, unless
disabled, one scheduler thread. Scaling out means more containers — the claim
statement (`FOR UPDATE SKIP LOCKED`) is what makes that safe, not any
coordination between them.

## Configuration

Names only; values live in Easypanel, GitHub Actions secrets and the gitignored
env files, never in the repository.

| Variable | Required | Default | What it is |
|---|---|---|---|
| `WORKER_DATABASE_URL`, falling back to `DATABASE_URL_UNPOOLED` | yes | — | Direct (non-pooled) Neon connection, as the DML-only `app` role |
| `WORKER_WAKE_TOKEN` | for `/wake` | — | Shared secret the Vercel route presents as `Authorization: Bearer …`. Unset means `/wake` refuses every call |
| `SENTRY_DSN_WORKER` | no | — | Unset disables Sentry entirely |
| `WORKER_PORT` | no | `8080` | Port for `/health` and `/wake` |
| `WORKER_CONCURRENCY` | no | `1` | Consumer threads in this container |
| `WORKER_POLL_INTERVAL_SECONDS` | no | `120` | Idle poll. Do not shorten: see below |
| `WORKER_SCHEDULER` | no | `1` | `0` runs this container as consumers only |
| `WORKER_JOB_KINDS` | no | all | Comma-separated kinds this container claims, for dedicating a container to part of the queue |

Resolution order matches `db/migrate.py`: the environment first, then
`.env.neon-roles.local` and `.env.local` in the repository root.

## Endpoints

- `GET /health` — process state only (never queries the database, so an uptime
  monitor cannot keep the Neon compute awake). `503` when a consumer thread died.
- `POST /wake` — `Authorization: Bearer $WORKER_WAKE_TOKEN`; `202` and the idle
  poll is cut short. It carries no payload: it cannot be used to make the worker
  run arbitrary work. `401` unauthenticated, `503` when no token is configured.

## Why the poll is two minutes

Neon Free gives 100 CU-hours and suspends the compute after five idle minutes.
The consumer therefore opens a connection, drains the queue, closes it and
waits — holding nothing open while idle. A hot poll loop, or a connection kept
alive between polls, would keep the compute running and spend the budget on an
empty queue (§5.1). When a user is waiting, Vercel calls `/wake` instead of the
worker polling faster.

## `sync_open_tenders` (§7.1, ADR-0001)

The 30-minute incremental sweep. Each cycle asks
`/api/consulta/v1/contratacoes/atualizacao` which contratações changed since the
last completed cycle, for modalities 6, 8 and 4, and upserts them into `tenders`
on `numeroControlePNCP`.

It windows on `dataAtualizacaoGlobal` — the timestamp that moves when the record
**or any of its children** changes. ADR-0001's Verification section measured the
alternative: the search index's `data_atualizacao_pncp` matched the header-only
timestamp on 74 of 74 conclusive cases and the child-aware one on none, so a
search-only sweep would silently miss item and file changes.

**The watermark lives in `events`**, under the name `sync_open_tenders.cycle`,
one append-only row per cycle. B2 was not allowed a migration, `events` already
exists and the `app` role can write it, and the log is more useful than a single
mutable cell:

```sql
select created_at, props from events
 where name = 'sync_open_tenders.cycle'
 order by id desc limit 10;
```

Only a **complete** cycle advances it, and it stores the *window*, not a
row-level timestamp — so a cycle that dies halfway leaves the previous window
standing and the next cycle sweeps the whole thing again. That is what makes a
three-hour PNCP outage cost delay rather than data.

**When `/api/consulta` is down** (measured at 17.4 % of requests, and for a
continuous 3 h 06 m while B2 was being written) the `pncp-consulta` breaker opens
and the cycle falls back to the search sweep. The fallback keeps the cache fresh,
records the cycle as `degraded`, and deliberately does **not** advance the
watermark.

Rerunning a cycle is free: the upsert only writes a row whose `pncp_updated_at`
actually moved, so an unchanged tender keeps its `updated_at` and the §3.1
freshness clock keeps meaning what it says.

Payload (all optional; the scheduled job carries none of them):

| Key | Default | What it does |
|---|---|---|
| `uf` | none — the whole country | Restrict to one state. A national sweep is cheaper than 27 per-state ones: the period endpoints have no 10,000-record window to partition around |
| `modalities` | `[6, 8, 4]` | Pregão Eletrônico, Dispensa, Concorrência Eletrônica |
| `window_start`, `window_end` | from the watermark | `YYYY-MM-DD`. Re-run a window by hand; does not move the watermark |
| `lookback_days` | `1` | How far a first run reaches when there is no watermark |

## Adding a job kind

```python
from licitaqui.registry import REGISTRY, JobContext


@REGISTRY.job("sync_items")
def sync_items(ctx: JobContext) -> None:
    tender_id = ctx.payload["tender_id"]
    # upsert the items for tender_id, using ctx.conn
```

Handlers must be idempotent: a job can run twice (§7.2). Raising means the
attempt failed — the consumer retries after 2, 8 and 30 minutes and marks the
job `failed` on the fourth attempt, storing the error. Wrap external calls in
`licitaqui.breaker.get_breaker("pncp-detail").guard()`.

**Wire it into `licitaqui/handlers.py`.** A handler registers itself when its
module is imported, so a kind nothing imports is simply absent from the
registry — and B2's sweep, which enqueues follow-ups only for kinds that have a
handler, then skips it in silence. `handlers.py` is the one module that imports
them all; `service.py` and the tests import it rather than listing handlers
themselves, and `tests/test_handlers.py` fails if a new `@REGISTRY.job` is not
reachable from it.

## `company_lookup` (CNPJ → CNAEs, size, MEI)

`licitaqui.company`. Enqueue with `company.enqueue(conn, cnpj)`: priority 1,
because a user is on screen, and one live job per CNPJ. The job key is a digest,
not the CNPJ — the consumer logs `key` on every line and §12 says the CNPJ never
reaches a log. The CNPJ travels in the payload, which is not logged.

Results land in `companies` (§6.2) and are good for **30 days** (§3.2); a fresh
row is served without touching BrasilAPI. Pass `force=True` to bypass the cache
(a user pressing "try again").

**When the lookup fails, the row still gets written, with `main_cnae` null.**
That is the manual-CNAE flag — `company.MANUAL_CNAE_PREDICATE` — and
`registration_status` says why: `lookup:not_found` (the CNPJ does not exist, so
the user should fix the number) or `lookup:failed` (BrasilAPI was unreachable,
slow, throttled, or its circuit was open). Neither value can collide with a
Receita status. A failure never overwrites CNAEs we already have, and a fallback
row expires in 6 hours rather than 30 days.

`is_mei` is three-state on a resolved row: `true`, `false`, and **`null` for "no
Simples/MEI registry entry"** — which is not "not a MEI" and must not be
rendered as one (ADR-0002).

BrasilAPI calls are **single-threaded process-wide with a 1 s minimum gap**,
whatever `WORKER_CONCURRENCY` is, because the uncached rate limit is unmeasured;
see the note at the top of `licitaqui/brasilapi.py`. Nothing in `pytest` calls
BrasilAPI. The live check is deliberate and separate:

```bash
python scripts/check_company_lookup_live.py --sample cnpjs.json --limit 50
```

## Tests

```bash
pytest                       # unit tests always; database tests when configured
ruff check . && ruff format --check .
```

The database tests need an isolated, already-migrated Neon database and skip
without one. Each task has its own, so two suites running at once cannot
collide:

| Variable | Used by | Rows it touches |
|---|---|---|
| `TEST_DATABASE_URL` | B1's queue and consumer tests | `jobs` rows whose key or kind starts with `b1-test-` / `b1t_` |
| `TEST_DATABASE_URL_B2` | B2's sweep tests | `tenders` rows for the fictitious agency `99000000000102`, `sync_open_tenders.*` events scoped to UF `ZZ`, and the follow-up jobs keyed on that CNPJ |
| `TEST_DATABASE_URL_B5` | B5's company-lookup tests (`test_integration_company.py`) | `companies` rows for synthetic `999…` CNPJs and their job rows |
| `TEST_DATABASE_URL_B3` | B3's items tests (`test_integration_sync_items.py`) | `tenders` (and their items, by cascade) for the fictitious agency `99` + this **run's** id — see "B3" below |

All are resolved the way `db/migrate.py` resolves its own connection string, and
all are wrapped in a redacting `Dsn` type before they can reach a fixture repr:
pytest renders fixture values into tracebacks, and a connection string that
reaches a CI transcript is a leaked credential. Deletes are always scoped by
prefix — no test ever truncates a table.

**Known flake, and it is not B2's.** `test_integration_queue.py` and
`test_integration_consumer.py` fail intermittently (measured on `main`'s own
code: 2 failures in run 1, 0 in runs 2 and 3 of an otherwise identical
sequence). The cause is in `tests/conftest.py`: `KEY_PREFIX` and `KIND_PREFIX`
are module constants, so cleanup scopes deletes **by task rather than by run**,
and two concurrent runs of this same suite delete each other's fixtures. The fix
is to derive both prefixes from a per-run `uuid4`. Until then, re-run before
believing a failure there.

## B3 — items, segments and the tender roll-up

`sync_items` (`licitaqui/sync_items.py`) reads one tender's items from
`/api/pncp/v1/.../itens` through the same `PncpClient` B2 uses, behind a breaker
of its own (`pncp-itens`), classifies each item and writes back what the items
say about the tender.

- `licitaqui/segments.py` is POC 1's classification, ported term for term: the
  14 keyword lists **in their original priority order**, the NCM prefix table
  (materials only, longest prefix first) and the false-positive expressions.
  The classifier works in stable ASCII keys (`health`, `it`, …), but what is
  **stored** in `tender_items.segment` and `tenders.segments` is POC 1's
  Portuguese label — the same vocabulary B6 seeded `cnae_segments.segment` with,
  so R1 can join them directly. `SEGMENTS` is the vocabulary, `label()` and
  `key_for_label()` convert, and `TenderItem.segment_key` gives the slug.
- **One deliberate divergence from POC 1: beverages.** POC 1's food rule covers
  NCM chapters 02–21 and food keywords, so chapter 22 — water, juice, soft
  drinks — lands in "Outros" and never reaches a company, which is why B6 had to
  mark every beverage CNAE `check`. Water (2201) and soft drinks (2202) are
  added back, plus the keywords `agua mineral`, `agua potavel` and
  `refrigerante`. Eight of the 8,861 cached items move, every one a beverage.
  Not the whole of chapter 22 (2207 is the ethyl alcohol agencies buy as
  cleaning álcool 70%, and the NCM branch outranks keywords), not bare `agua`
  (bleach, water tanks) and not bare `bebida` (trays and cups). `refrigerante`
  carries lookbehinds because five air conditioners specify "GÁS REFRIGERANTE
  R-410A".
- `tender_items.relevance` records how the segment was reached: `high` from the
  NCM code, `medium` from a keyword, `low` when nothing matched or the only
  match sat inside a false-positive expression.
- `me_epp_summary` is `exclusive | quota | mixed | none` from each item's
  `tipoBeneficio`; `favored_treatment` is the tender's value against the EPP
  revenue cap (R$ 4.8M), `null` when the value is unknown — a confidential
  budget reports every item as zero.
- `tenders.segments` is the item segments ranked by value (POC 1 picks the
  single biggest; this keeps the whole ranking), falling back to classifying the
  object. `tenders.search` is rebuilt with the exact expression `db/seed.py`
  uses, so seeded and synced rows produce the same vector.

**Its test rows are scoped per run, not per task.** `conftest.B3_CNPJ` is `99`
followed by this pytest run's `RUN_ID` as digits, so two concurrent runs of the
suite write under different fictitious agencies and neither cleanup can touch
the other's fixtures. Anything new that writes to a shared database should copy
that, including the natural-key values — a constant that looks task-specific is
not run-specific.

The parity fixtures in `tests/fixtures/poc1/` are real cached PNCP payloads from
the read-only knowledge base, labelled by running POC 1 itself.
`test_segments.py::test_the_fixture_labels_are_poc1s_own` re-derives every label
from `poc1_licitacoes.py` when that folder is present, and skips in CI.

## `ai_screening` (edital → triage, POC 4)

`licitaqui.ai_tender` is the port of POC 4's *lite* mode; `licitaqui.ai_screening`
is the job around it. Enqueue with `ai_screening.enqueue(conn, tender_id,
payload={...})`: priority 1, one live screening per tender.

The payload says where the document is — `pages` (already extracted, which is
what B4's `extract_text` will hand over), `text_path`, `pdf_path` or `url` — and
ideally `files_hash`, the digest of the file bytes. Without one the job hashes
the PDF it downloaded, or as a last resort the extracted text.

**Results are cached for ever and shared across users** (§3.2). The cache key is
the `ai_analyses` unique key: tender + mode + prompt version + extraction version
+ file hash. A hit costs nothing and makes no API call; a cached `ok` or
`no_text` row is never overwritten, while a `failed` one can be replaced by a
later attempt. Bumping `PROMPT_VERSION_LITE` (in `licitaqui/prompts.py`) or
`EXTRACTION_VERSION` therefore does not invalidate anything: it opens a second,
parallel cache and every tender is analysed again at full price.

**A scanned PDF never reaches the model.** With no text layer the job writes
`status = 'no_text'` with no model, no tokens and no cost, before the API key is
even resolved. OCR is v2 (§16).

**Arithmetic is done in code, never by the model** (§7.2): the minimum capital
and the contract term in months. The prompt explicitly tells the model not to
calculate, because the POC's battery measured 5 of 12 models getting Brazilian
percentages and `R$ 4.330.766,67`-style numbers wrong. The results land in the
`rules` column.

**Citations are verified, not trusted.** Every page a lite claim points at must
exist, must be a page we actually sent, and must be about the subject claimed;
the per-claim verdicts are stored in `citation_check`.

### Evaluating a prompt or extraction change

```bash
python -m evaluation                  # live if OPENROUTER_API_KEY resolves, replay otherwise
python -m evaluation --mode recorded  # replay: free, offline, deterministic
python -m evaluation --mode record    # live, and save the answers for replaying
```

Scores the screening against the three hand-checked answer keys in
`evaluation/gabaritos/` and exits non-zero below 95% (spec §13). A live run costs
about R$ 0,01 for the three editais. `evaluate-ai.yml` runs it when `ai_tender.py`,
`prompts.py`, `ai_screening.py` or `evaluation/` change; `pytest` replays the
recorded answers on every run, so a regression in our own code fails the ordinary
suite for free. Any prompt or extraction change must be evaluated **live** and the
score diff reported (CLAUDE.md).

Nothing under `pytest` ever calls OpenRouter: the transport is stubbed and the
key is forced to a dummy value by an autouse fixture.

### C1's test database

`test_integration_ai_screening.py` needs `TEST_DATABASE_URL_C1` — C1's own
isolated, already-migrated database — and skips without it. It writes tenders for
the fictitious agency `99000000000103` and the analyses that cascade from them;
cleanup is scoped by that CNPJ and by the per-run `RUN_ID`, and never truncates.

## WhatsApp — the founders welcome (E2, spec §9, plan G9)

`send_whatsapp` delivers E0's founders welcome through Evolution API. F1 already
enqueues it: `apps/web/lib/founders/signup.ts` writes `kind = 'send_whatsapp'`,
`key = 'founders:<founders_list id>'` and a payload of
`{template, founders_list_id, numero_vaga, posicao_espera}` inside the same
statement that hands out the seat. The worker consumes exactly that; the payload
carries no phone number, so the queue never holds a second copy of one.

### The kill switch: `WHATSAPP_DELIVERY`

**Nothing reaches WhatsApp unless `WHATSAPP_DELIVERY=send`.** Unset — the
default in CI, on a laptop and in a fresh container — is `dry_run`: every
consent check runs, the message is rendered, the delivery is logged, and no
socket is opened. It is a word rather than a boolean on purpose: `=1` is the
value that arrives by accident in a copy-pasted env block, and it is not enough.
Anything but the word `send` (surrounding whitespace aside) is dry run, so a
typo fails safe.

The check lives in the transport (`licitaqui/evolution.py`), not in the job, so
a new caller cannot route around it; `post_text` raises `SendingDisabled` if it
is ever reached with the switch off, and the whole test suite forces the switch
off via an autouse fixture. `tests/test_integration_whatsapp.py` asserts the
guarantee at the socket layer: with the switch off, the job runs end to end
while `socket.connect` raises, and nothing attempts a connection.

**As of 2026-09-18 the switch must stay off.** The only Evolution instance on
the server is `flowdeski-scn-real-estate` — a different product. Sending from it
would deliver LicitaQui's founders welcome from another product's WhatsApp
number. Turn the switch on only once a dedicated LicitaQui instance exists.

| Variable | Required | Default | What it is |
|---|---|---|---|
| `WHATSAPP_DELIVERY` | to send anything | unset (`dry_run`) | The kill switch. Only the exact word `send` lets a request leave the process |
| `EVOLUTION_API_URL` | to send | — | Instance base URL. Resolved lazily: a dry run needs none of these three |
| `EVOLUTION_API_KEY` | to send | — | Sent as the `apikey` header |
| `EVOLUTION_INSTANCE` | to send | — | Instance name in the `POST /message/sendText/{instance}` path |
| `FOUNDERS_OPENING_DATE` | no | `2026-10-08` | Fills `{{data_abertura}}`, so a slipped opening is an env change |

### Cloudflare blocks default HTTP clients

`evolutiondev.scintechn.com` sits behind Cloudflare, which answers
`403 error code: 1010` to `python-httpx` and `urllib` — **including on `GET /`**.
It is a client-fingerprint block, not an auth failure: no API key fixes it, and
the identical request with a Chrome `User-Agent` returns 200 (verified). The
client always sends `evolution.USER_AGENT`; do not remove it and do not let a
new caller build its own request. A 403 whose body mentions `1010` is reported
as `cloudflare_1010_client_fingerprint` rather than as a generic auth error,
because a bare 403 sends the next person hunting for a key problem that is not
there.

### Consent, pacing and SAIR

- **Opt-in only (§12).** `founders_list.contact_consent` must be true. A refusal
  is final, not a retry: the job finishes `done` and the log says `no_consent`
  without naming anybody.
- **≈ 1 message every 20–30 s (§9),** jittered, measured from the delivery log
  rather than from a counter in memory — so the pacing survives a restart and
  holds across containers.
- **`SAIR` stops everything.** `whatsapp_inbound` records the opt-out, and every
  later send is refused with `opted_out`. The match is on the whole normalised
  message (`sair`, `parar`, `stop`, `cancelar`, `quero sair`, …), never a
  substring: "vou sair de viagem" must not unsubscribe anybody.
- The reply's **number is resolved to a `founders_list` id before the job is
  enqueued**, so a phone number never lands in the `jobs` table.

`whatsapp/optout-confirmation.md` still carries a `TODO(Sci):` and an
`{{email_contato}}` nobody has decided (templates README §7), so today the
opt-out is recorded and the confirmation is skipped with a warning. The opt-out
itself stands regardless: being told the messages stopped is the courtesy, and
it must not be able to undo the thing it confirms.

### The delivery log

Rows in `events`, namespaced `whatsapp.*` (`sent`, `dry_run`, `skipped`,
`failed`, `optout`) — no migration, because schema changes belong in their own
PR. Each row carries the `founders_list` id, the template, the job id and
attempt, the outcome and, when there is one, Evolution's message id and the
round-trip time. **No number, no name, no e-mail and no rendered body** (§12);
the id is what makes a support question answerable without the log holding the
data. A test asserts that none of those strings can be found in the log.

### Templates

`licitaqui/templates.py` loads E0's files. Per templates README §3 a missing
placeholder **raises** — and so does a blank one, an undeclared one, a malformed
`{{ nome }}`, and a body still containing `TODO(Sci):`. All 22 of E0's templates
are checked by `tests/test_templates.py`.

### E2's test database

`tests/test_integration_whatsapp.py` needs `TEST_DATABASE_URL_E2` — E2's own
isolated, already-migrated database — and skips without it. It writes
`founders_list` rows whose e-mail carries the per-run `RUN_ID`, and the delivery
log and jobs that hang off them; cleanup is scoped to exactly those ids and
never truncates. **No test takes a seat:** there are only 48 and `seat` is
globally unique, so test founders are waitlisted (`seat is null`) and the seat
number a welcome renders comes from the job payload, which is where F1 puts it.

## B4 — the file list, and what an amendment invalidates

`sync_files` (`licitaqui/sync_files.py`) reads one tender's "Arquivos" tab from
`/api/pncp/v1/.../arquivos` through the same `PncpClient` B2 and B3 use, behind
a breaker of its own (`pncp-arquivos`), and writes one `tender_files` row per
document: `sequence`, `title`, `doc_type`, `url`, `active`, `published_at`.

**List only.** No PDF is downloaded here — S3, extraction and OCR are later
cards. The call is a single unpaged GET: the endpoint answers with the whole
list in a bare JSON array, and over the 99 tenders with a cached file list in
the knowledge base (371 documents) the median tender has 1 document, the 95th
percentile 14 and the largest 39.

### `files_hash`: how an amendment invalidates text and screening

§3.2: *"an amendment adds a new file: invalidates text and screening"*. A
company bidding against a superseded edital is the failure this exists to
prevent, so it is worth knowing exactly how it works.

**Screening is invalidated by the key, not by a delete.**
`licitaqui.files.files_hash()` digests the tender's **active** file list, and
`ai_analyses` is unique on `(tender_id, mode, prompt_version,
extraction_version, files_hash)`. When the list moves, the hash moves, and
`ai_screening.cached()` — which looks up by exactly that key — misses. The
analysis of the old set stays on the row: still true of the documents it read,
still the record of what was paid, and no longer this tender's current answer.
Nothing has to be deleted for a superseded analysis to stop being served, so
there is no window in which the delete has not run yet.

Ask for the hash rather than building it — `files.files_hash_for(conn,
tender_id)` — and put it in the `ai_screening` payload. It is derived from the
rows on every call rather than cached in a column, because a stored digest can
disagree with the rows it summarises and then the product serves an analysis of
documents nobody is reading.

The digest is one line per active document, ordered by document number:

    <sequence>\t<doc_type>\t<title>\t<url>\t<published_at as UTC ISO-8601>

`published_at` and `title` are in there for the dangerous case: PNCP's download
address is `…/arquivos/{sequencialDocumento}`, so an agency re-publishing the
edital under the same document number serves **different bytes from the same
URL**. `dataPublicacaoPncp` is what moves. `MANIFEST_VERSION` prefixes the
digest input so the card that downloads the files can fold `tender_files.sha256`
into the same recipe and retire every hash computed without it.

**Text is invalidated per document, in the write itself.** `sha256`, `s3_key`,
`pages`, `text_version` and `no_text` describe bytes. When a document's
identity (`title`, `doc_type`, `url`, `published_at`) changes under its number,
`files.upsert_files()` clears those columns in the same statement that writes
the new URL, so nothing can read the new address beside the old page count. A
withdrawn document's row is deleted; a document merely going *inactive* keeps
its text (the bytes did not change) but leaves the manifest, so the screening
key still moves.

**This job does not re-screen.** Screening is enqueued on demand at priority 1
because a user is waiting (§7.3); re-analysing every amended tender in the
country would spend the AI budget on tenders nobody asked about. The next
request gets a miss and pays for a fresh reading.

### The 12 h TTL marker lives in `events`

`tender_files` (§6.1) has no timestamp column, and a migration is its own PR, so
freshness follows the precedent B2 set for its watermark: a row in `events`
named `sync_files:<tender_id>`, rewritten (not appended) on each fetch. The
tender id is in `name` rather than in `props` so the lookup is an exact hit on
`events_name_created_idx (name, created_at)` — with the id in `props` the only
indexed predicate would be the shared name, and reading one tender's marker
would scan every tender's. Its props carry the counts and both digests, so
`select props from events where name = 'sync_files:<id>'` answers "when did we
last look, and did anything change?".

`read_state()` reports `never | ttl | tender_changed | fresh`. `tender_changed`
is a moved `dataAtualizacaoGlobal` — which is what an amendment moves — and it
beats the TTL, so an amendment is never left waiting twelve hours.

A failed call raises before anything is written, so an outage can never be
mistaken for "this tender has no documents any more": no prune, no hash change,
no invalidation.

### B4's test database

`test_integration_sync_files.py` needs `TEST_DATABASE_URL_B4` — B4's own
isolated, already-migrated database — and skips without it, which CI counts as a
failure. Its rows are scoped **per run**: `conftest.B4_CNPJ` carries `RUN_ID`,
tender ids are built from it, and the `events` markers are deleted by the same
run-scoped name prefix. `tender_files` and `ai_analyses` cascade from `tenders`.
Nothing under `pytest` ever calls OpenRouter or PNCP.

## B4B — downloading the documents, and the screening that now completes

`sync_files` stores *what documents a tender has*; §7.1 says the files are
"download[ed] … only when someone requests screening", and nothing did the
second half. `licitaqui/documents.py` is it, and with it a user clicking
"analisar" gets an analysis instead of a job that fails four times.

### Where it is wired, and why there

`requestScreening` enqueues one row — `ai_screening`, key
`screening:<tender_id>`, priority 1 — with a payload of `{tender_id}` and
nothing else. So the fix had to be *that job succeeding*, not a different job
existing: `ai_screening.load_document` gained a last source, and when the
payload carries no pages, path or URL it calls
`documents.ensure_documents(conn, tender_id)`. Nothing in `apps/web` changed.

A prerequisite job and an enqueue chain were both rejected: two queue rows for
one user action means two dedupe keys, two backoff budgets and a window where
the first succeeded and the second was never enqueued. §3's rule — no *web
request* waits on a slow call — is satisfied either way, because the download
happens in the worker; §3.1 step 4 already says `202` and a 3-second poll.

The `extract_text` kind (§7.1) exists as well, at priority 9, for sampling and
pre-warming. Both paths call `ensure_documents`, so they cannot disagree.

### What one screening reads

The **active** documents typed or named *Edital* or *Termo de Referência*
(POC 1's own default set), in document-number order, capped at 8. A tender
whose list names neither falls back to every active document: refusing to read
a tender whose only file is "Anexo I" is a worse failure than reading one
document too many. The selection is deterministic for a given list, which is
what lets `ai_analyses.files_hash` keep digesting the **list** rather than the
selection.

**All or nothing.** If a selected document cannot be fetched or parsed, the job
raises and nothing is written. Anything else would store an analysis of half
the documents under a key claiming it read all of them, and §3.2 keeps that row
for ever.

### The download budget

| | |
|---|---|
| Whole transfer | 120 s (§7.2), as a **wall-clock deadline**, not a read timeout |
| Connect | 15 s (§7.2) |
| Size | 64 MB per document, checked while streaming |
| Pace | 2 requests/second |
| Breaker | `pncp-download`, 2 consecutive failures → 15 min |
| Retries | none here; the queue owns them (2, 8, 30 min, 4 attempts) |

The deadline is the point. `httpx`'s read timeout applies to each read, so a
server dribbling a kilobyte every ten seconds never trips it — which is how the
POCs measured one download still running at **929 s**. A 4xx is recorded as a
breaker *success* before it raises: a server answering "404" quickly is healthy,
and one permanently missing annexe must not stop every other tender's download
for fifteen minutes.

### Storage and the 90-day deletion (§3.2)

`licitaqui/storage.py` writes two objects per document, both keyed as pure
functions of `(tender_id, sequence, sha256)`:

    tenders/<tender id>/files/<0001>/<sha256>.pdf            deleted after 90 days
    tenders/<tender id>/files/<0001>/<sha256>.text.json.gz   kept for ever

That separation is what makes the `cleanup` sweep possible. It will select rows
with an `s3_key` whose tender closed more than 90 days ago, delete the object,
then null `s3_key` — in that order, so a crash between the two leaves a key for
an object already gone and the next run deletes it again harmlessly. It touches
nothing else: `sha256` survives, so `storage.text_key()` keeps finding the text
after `s3_key` is null. `storage.describe_retention()` states this beside the
code that creates the objects.

With no bucket configured the store degrades to a `NullStore`: nothing is
written, every read misses, and the documents are extracted again on each run.
Slower, never wrong, and the reason no test here needs an AWS credential.

### `no_text`, and the two different questions it answers

`Document.has_text` (C1's) asks *is there enough here to screen a tender?* and
keeps §7.1's absolute floor of 1,500 characters. `documents.is_scan()` asks
*does this document have a text layer at all?* and only applies the per-page
floor. A four-page Termo de Referência of 1,200 characters fails the first and
passes the second, and recording it as a scan would hand a future OCR card a
queue of readable documents.

The screening decision is unchanged and still C1's: this path hands
`screen_tender` a `Document`, and `has_text` is checked there before the key is
resolved and before the breaker is consulted. A scanned edital reaches `no_text`
through that guard, not around it.

### The trap in "this tender has no documents"

An empty `tender_files` can mean *the agency published none* or *we have never
looked*, and reading the second as the first would store a permanent `no_text`
— §3.2 keeps an AI result for ever and C1 never overwrites one — for a tender
whose edital is sitting on PNCP unread. So `ensure_documents` consults B4's sync
marker: no marker means it enqueues `sync_files` at priority 1 and raises
`DocumentsNotReady`, and the queue brings the screening back two minutes later
against a list that now exists.

### B4B's test database

`test_integration_download_screening.py` needs `TEST_DATABASE_URL_DL` and skips
without it, which CI counts as a failure. Rows are scoped **per run**:
`conftest.DL_CNPJ` carries `RUN_ID`, tender ids are built from it, and the
`events` markers and `jobs` rows are deleted by the same run-scoped prefixes.
`tender_files` and `ai_analyses` cascade from `tenders`.

Nothing under `pytest` reaches PNCP, S3 or OpenRouter: the PDFs are built in
memory by `tests/pdfs.py`, downloads run against an `httpx.MockTransport`, the
model call is stubbed, and the suite-wide `_object_storage_off` fixture forces
a `NullStore` even on a machine where `S3_BUCKET` resolves.
