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
| `TEST_DATABASE_URL_FH` | FH's `files_hash` wiring tests (`test_integration_files_hash.py`) | `tenders` (and their files and analyses, by cascade) for the fictitious agency `99` + this **run's** id, and their `sync_files:` markers — see "FH's test database" below |

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

## B8 — awards, price bands, and the CPF that must not be stored

`sync_awards` builds the base v1's discount bands read from. POC 3 is the
source: *valor estimado* against *valor homologado* per item, the discount the
winner offered, and the four-way judgement about whether that discount is
usable. Two modules and two job kinds:

| Kind | When | What |
|---|---|---|
| `sync_awards` | daily 03:00 BRT (§7.1 "overnight") | No HTTP. Picks tenders with pending awarded items in the segments of interest and enqueues one follow-up each — the shape B2's sweep established. |
| `sync_tender_awards` | per tender, priority 9 | One request per pending awarded item, upserted as each arrives. |

### CPF is masked on write, and `raw` is the column people forget

Spec §12: *PNCP awards may include the CPF of individual winners: mask on
write, show only CNPJ.* A raw CPF in `awards` is an LGPD incident whether or
not a query hides it — the breach is the storage, and the weekly `pg_dump` to
S3 (§12) inherits it. So the masking happens in `awards.from_pncp`, before a
row object exists, and `awards.upsert_awards` accepts `Award` values and
nothing else: there is no call that writes an unmasked document by forgetting
a step.

Three columns carry the risk, not one:

- **`supplier_doc`** — 14 digits is a CNPJ and is kept; 11 digits is a CPF and
  is stored as `***.456.789-**`, the shape §6.1 prescribes.
- **`supplier_name`** — a razão social is kept; a person's name becomes
  initials (`"Joao da Silva Souza"` → `"J. S. S."`, particles dropped).
- **`raw`** — the whole payload, which contains both of the above verbatim.
  Masking the two columns and storing the untouched JSON beside them stores the
  CPF anyway, one key deeper. `awards.redact_record` rewrites the payload by
  key *and* by value, so the original document and name are gone from every
  string in it — the MEI convention of putting the proprietor's name in the
  razão social means the two are not always in separate fields.

**The MEI is the case that nearly got through.** The Receita Federal composes
a MEI's razão social as *the proprietor's full name followed by their CPF* —
"AUGUSTO SOSTA MARTINS 25510225840" — on a record that is `tipoPessoa: "PJ"`
with a perfectly valid 14-digit CNPJ. Every company rule says *company*,
correctly, and keeps the razão social; the CPF rides in on the one branch that
was not looking for one. `mask_embedded_cpf` is the answer: every string this
module stores, on **both** branches, has a standalone 11-digit run replaced by
the same mask. The lookarounds are load-bearing — without them the first 11
digits of every CNPJ would match.

It was found in the data, not reasoned about: one row in the 4,344 the backfill
collected, and `nomeRazaoSocialFornecedor` was the only payload key in any of
them carrying a bare 11-digit run. One in 4,344 is about one a night, forever,
and MEIs are exactly who this product is for. `backfill_awards.py
--repair-personal-data` re-applies the masking to rows already written, because
fixing the mapper only protects the *next* write and the row already in the
table is the breach.

**It fails closed.** A document is kept in the clear only when it is provably a
company: exactly 14 digits **and** PNCP did not say `tipoPessoa: "PF"`.
Everything else — 11 digits, an unrecognised length, a `PF` flag that
contradicts the digits, a missing document — is treated as personal. Masking a
company by mistake costs a row of supplier analytics; not masking a person is
not recoverable by a later migration, because the value is already in the
backups. All 420 cached award records in the knowledge base are `PJ` with a
14-digit document, so the sample would never have exercised any of this: it is
written against the rule, not against the data.

The proof is `test_a_natural_person_leaves_no_cpf_and_no_full_name_in_the_table`
in `tests/test_integration_sync_awards.py`. It runs a natural-person award
through the handler the scheduler runs, against the real table, then reads
**every column of every row back as text** (`select a::text`, so `raw` is
included and a column added later is covered) and insists neither the CPF in
any spelling nor any part of the name is in it. The test next to it stores a
*company* award and asserts the CNPJ and razão social **are** visible through
the identical query — otherwise a broken reader would make the first test pass
on an empty string.

### What it costs, and why it is not an unbounded sweep

§3.2: *award per item (winner) — 1 call per item: only for segments of
interest, permanent once awarded*. There is no bulk endpoint. Three filters,
all of them in the SQL that picks the work rather than after the call:

1. `tender_items.has_award` (PNCP's `temResultado`, written by B3);
2. the item's segment is in `sync_awards.DEFAULT_SEGMENTS`;
3. **no `awards` row exists for it** — §3.2's *permanent once awarded*, which
   is not a long TTL but the absence of any expiry.

An item PNCP flags as awarded before publishing the result would otherwise be
re-asked forever, so the tender carries a probe marker in `events`
(`sync_awards:<tender_id>`, B4's precedent — `awards` has no timestamp column
and a migration is its own PR) and is left alone for `PROBE_COOLDOWN_HOURS`
(168). Settled items are excluded by their award row regardless, so the
cooldown can only delay asking about something that was not there last time.

`AWARDS_SEGMENTS` (comma-separated labels) overrides the default set; a job
payload may carry `segments`, and an explicit `[]` means every segment — the
unbounded sweep, reachable on purpose for an operator and never the default.

### Divergences from POC 3

| POC 3 | Here | Why |
|---|---|---|
| Writes CNPJ/CPF and the winner's full name to a spreadsheet | Masks both on write | Spec §12. The POC ran on one laptop; this is a database with backups. |
| Quality labels in Portuguese (`OK`, `Cancelado`, `Sem estimado (sigiloso?)`, `Suspeito`) | §6.1's vocabulary (`OK`, `cancelled`, `confidential`, `out_of_range`) | Same four classes, same precedence, same −5%…90% thresholds; §6.1 names the column's values. |
| Discount as a fraction in a spreadsheet formula | `discount_pct` in percentage points | The column is `numeric(6,2)`. A discount outside ±9999.99 points is stored as NULL rather than clamped — a clamped −9999.99% would look like a measurement; `quality` still says `out_of_range`. |
| Items filtered by description keywords (`--filtro-item`) | Items filtered by B3's segment | Segments are the product's vocabulary and the thing a founder's CNAEs map onto (B6). Keywords were the POC's stand-in for a classifier that did not exist yet. |
| Uses `dataCancelamento` alone for "cancelled" | Same | Checked rather than assumed: across the 420 cached records `situacaoCompraItemResultadoNome = "Cancelado"` appears on 2, both of which also carry a `dataCancelamento` that 18 further records carry on their own. The date is strictly broader. |
| Ignores the payload's own `percentualDesconto` | Same | It is 0.0 on 390 of the 420 cached records. POC 3's computed `1 − homologado/estimado` is the honest number. |

### Two traps this had to step around

**`awarded_on` is a `date`.** PNCP sends naive Brasília wall clock, so
`tenders.parse_timestamp` attaches the offset — but handing Postgres an aware
*timestamp* for a `date` column casts through the session TimeZone, which for
the worker is UTC. A result at 23:30 BRT would be stored as the following day:
not three hours early, a whole day late. `awards.award_date` converts back to
Brasília and hands the driver a real `date`. `dataResultado` is date-only in
all 420 cached records, which is exactly why a test defends it rather than the
sample.

**A zero estimate is a confidential budget, not a cheap item.** B3 measured all
374 sigiloso items reporting `valorUnitarioEstimado` as 0. Dividing by it — or
reading it as a real estimate — would manufacture a 100% discount and put it in
a price band, so `discount_fraction` returns None and the row is
`confidential`. This is POC 3's `if estimado and …` reproduced deliberately
rather than inherited by accident.

### The backfill

`scripts/backfill_awards.py` sweeps closed tenders, classifies their items
(B3's step) and then runs the **real** `sync_tender_awards` handler over each —
so the masking, the segment filter and *permanent once awarded* are whatever
production does, because they are production. It defaults to
`TEST_DATABASE_URL_B8`, never the production database.

Tenders come from the search index with `status=encerradas` (POC 3's own
source) by default, or from `/contratacoes/publicacao` with
`--source publicacao`. Both are supported because the Consulta host timed out
on every attempt while this was written — the ADR's measured failure mode, and
the reason the fallback exists.

`--workers` threads hide Neon round trips; they buy nothing against PNCP, whose
throttle is shared by the one client and holds the whole run to `--rate`
(default 4 req/s, §7.2) however many threads there are. Measured
single-threaded: 5.7 s per tender, of which about 0.4 s was HTTP. With ten
threads: about 200 award rows a minute.

Two things the first full run taught it, both now in the script:

- **An open circuit has to stop the workers, not be swallowed by them.** Two
  consecutive `/itens` timeouts opened `pncp-itens` for the spec's 900 s, and
  the threads then drained the sweep at full speed, failing every tender
  instantly and discarding it — forty tenders gone in seconds. In production
  the queue is what prevents this (a failed job is retried at 2, 8 and 30
  minutes); a script has to pause itself. `wait_out()` does, and `--attempts`
  gives each tender the queue's retry budget.
- **A re-run must not re-read what an earlier one finished.** A tender with a
  probe marker is skipped before any HTTP, so resuming an interrupted
  collection costs one indexed `events` lookup instead of one items request per
  tender already done. `--reprobe` turns that off.

### B8's test database

`test_integration_sync_awards.py` needs `TEST_DATABASE_URL_B8` — B8's own
isolated, already-migrated database — and skips without it, which CI counts as
a failure. Rows are scoped **per run** by `conftest.B8_CNPJ`, which carries
`RUN_ID`. One difference from the other blocks: `awards` has **no foreign key**
to `tenders` and **no timestamp column**, so neither a cascade nor an age
predicate can clean it. Cleanup deletes award rows explicitly by the run-scoped
tender prefix and then sweeps any award under the fictitious `99…` agency whose
tender no longer exists.

## Wiring `files_hash` into the screening (task FH)

B4 computes the digest of a tender's active document list and `ai_analyses` is
unique on it; C1 looks its cache up by exactly that key. Until this task nothing
joined the two, so the invalidation above was inert: an amended tender kept
serving the analysis of the superseded edital.

**The screening resolves the digest itself, when the job runs.**
`ai_screening.resolve_files_hash(conn, tender_id, payload)` asks
`files.files_hash_for()` for the current value; an explicit `files_hash` in the
payload still wins, and a tender with no documents on record falls back to
C1's content digest. So an enqueue site needs nothing but the tender id:

```python
ai_screening.enqueue(conn, tender_id)  # no hash; the handler resolves it
```

### Why not at the enqueue site

The queue sits between the two, and this is the one job whose key can change
while it waits:

* **A payload is a snapshot that goes stale.** `sync_files` can land an errata
  between the enqueue and the execution. The handler then reads the *new*
  documents, so a payload hash would key an analysis of the new edital under the
  old list's digest — a row that misdescribes what it read, permanently, because
  a cached `ok` is never overwritten.
* **The queue de-duplicates.** `jobs_dedupe` is unique on `(kind, key)` while
  queued or running and there is one screening key per tender, so the request
  that arrives *after* the amendment enqueues nothing. Its payload — and its
  fresher hash — is dropped.
* **Only the worker can spell the digest.** The recipe is `MANIFEST_VERSION`,
  tab-separated fields and UTC ISO-8601 in `licitaqui/files.py`. A web enqueue
  site would have to re-implement it in TypeScript and agree byte for byte for
  ever; the day the two disagree, every screening misses its cache and is paid
  for again (~R$ 0,0014 per edital, per tender, for ever).

This is the same argument B4 makes for deriving the digest rather than storing
it: a hash in a job payload is a stored digest with a queue delay attached.

### The web read path

`apps/web/lib/radar/screening.ts` had the same gap on the read side — it served
the newest usable `ai_analyses` row whatever list it was keyed on, which right
after an amendment is precisely the superseded one. It now filters on the digest
the worker published in the `sync_files:<tender_id>` marker, and falls back to
the old behaviour when a tender has never been synced, so the filter can hide a
superseded row but can never make a tender un-analysable. The honest fix is for
the worker to expose the current digest properly (a column, or the read API)
instead of through a marker row.

### FH's test database

`test_integration_files_hash.py` needs `TEST_DATABASE_URL_FH` — this task's own
isolated, already-migrated database — and skips without it, which CI counts as a
failure. It drives B4's and C1's jobs against each other: sync, screen, amend,
re-screen. Rows are scoped **per run** (`conftest.FH_CNPJ` carries `RUN_ID`),
`tender_files` and `ai_analyses` cascade from `tenders`, and the `events`
markers go by the same run-scoped name prefix. Nothing calls OpenRouter or PNCP.

## B4B — downloading the documents, and the screening that now completes

> Reads on from the FH section above: that one resolves *which key* a screening
> is stored under; this one finds *the document the key names*. The two meet in
> `load_document`, whose fifth source is described below.

`sync_files` stores *what documents a tender has*; §7.1 says the files are
"download[ed] … only when someone requests screening", and nothing did the
second half. `licitaqui/documents.py` is it, and with it a user clicking
"analisar" gets an analysis instead of a job that fails four times.

### How it meets FH's `resolve_files_hash`

FH resolves the key at the top of `screen_tender`; `load_document` then picks
the document, and its **fifth** source — the tender's own file list, via
`documents.ensure_documents` — is the ordinary path for the web's
`{tender_id}`-only payload. Two details are deliberate where that source meets
FH's rules:

* **The snapshot's digest wins over the resolver's.** `ensure_documents` reads
  the file list once and returns both the documents it chose and the digest of
  that same read. A `sync_files` landing between `resolve_files_hash` and
  `ensure_documents` would otherwise key an analysis under one list while having
  read another — FH's own argument for resolving at execution rather than at
  enqueue, one level further down. An explicit payload pin still beats both.
* **`EMPTY_MANIFEST_DIGEST` is narrowed, not dropped.** `resolve_files_hash`
  returns `None` for it, because beside a payload URL an empty `tender_files`
  would claim a file list we do not have. In the fifth source the empty list
  *is* what was read: the tender genuinely has no active documents, the answer
  is `no_text`, and the key moves the moment `sync_files` finds one. So that
  branch keys on the empty digest, and the cheap cache probe substitutes the
  same constant for a `None` resolution — otherwise the row would be written
  under one key and looked up under another, and a permanent answer would be
  re-derived on every request.

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
a `NullStore` even on a machine where `S3_BUCKET` resolves. That last one is
autouse and suite-wide for the same reason `_whatsapp_delivery_off` is: the
bucket named by `S3_BUCKET` is the production one, `licitaqui.storage` resolves
it out of the gitignored env files as well as the environment, and a test that
reached it would leave objects in it under fictitious tender ids.

Measured in CI (`integration (Neon)`, the job that fails on any database skip):
**600 passed, 1 skipped in 739.51 s**. The one skip is `test_segments.py`'s
knowledge-base comparison, which is not a database test and is expected off
Sci's machine.

## E1 — Telegram linking and the weekly digest (spec §7.1, §9, §10)

Two job kinds and one scheduler entry.

| Kind | Enqueued by | Does |
|---|---|---|
| `weekly_digest` | the scheduler, **Monday 07:00 BRT** | The sweep. Selects the accounts due a digest and enqueues one `send_telegram` each. Sends nothing itself |
| `send_telegram` | the sweep, and `POST /api/telegram/webhook` | One outbound message: gates, render, send, log |

### Why the digest fans out

A single job that looped over every user would be retried as a whole (§7.2,
four attempts), so one failure on user 40 re-sends users 1–39 three more times.
It would also have nowhere to hang a per-person dedupe: `jobs_dedupe (kind,
key)` is the only cross-process guarantee that somebody is messaged once, and it
can only protect a per-person row. So the key is

    digest:<user_id>:<ISO week>

with the week **in** it, which makes two sweeps on the same Monday produce one
message, and lets all four consumers work at once instead of one.

The tenders are chosen **when the message is sent**, not when the sweep runs:
the payload is `{template, user_id}` and never a list of tender ids. A retry
forty minutes later then sends what is open now, and the queue never holds a
stale shortlist.

### The kill switch: `TELEGRAM_DELIVERY`

Nothing reaches the Bot API unless `TELEGRAM_DELIVERY=send`. Unset — CI, a
laptop, a fresh container — is `dry_run`: the message is rendered, the delivery
is logged, and no socket is opened. Same word and same shape as
`WHATSAPP_DELIVERY`, and deliberately a **second** switch: `@LicitaQuiBot` is
live and someone is already talking to it, so a worker pointed at the production
database would message founders for real, and turning WhatsApp on must not turn
Telegram on with it. The gate is checked in the transport, immediately before
the request, so no caller can route around it.

### Quotas (§10), and the row that is missing

Básico is **one alert per week, one keyword, one state**, and all three come out
of `plan_limits` — `alert_limit()` and `state_limit()` in
`licitaqui/telegram_alerts.py`, never a literal. The week is a **Brasília**
week: a UTC boundary falls at 21:00 on Sunday in São Paulo, and two digests
either side of it are one calendar week to the person reading them.

`plan_limits` has an `alert` row for `basico` and for no other plan, because §10
gives the paid plans *daily* alerts, which are the `daily_alerts` job and not
this one. A missing cap is therefore read as **uncapped**, not as zero: reading
it as zero (which `apps/web/lib/radar/quota.ts` rightly does for a feature that
costs money) would silence every founder on `promocional` during opening week.
The sweep logs `plan has no alert limit` with the plan name so the gap stays
visible. It wants a `plan_limits` row, which is a migration, which is its own PR.

### The quota and the delivery record are one fact

Two things are written after a digest: the **quota** (this account has had its
message this week, counted from `events`) and the **deliveries** (these tenders
have been offered, `alert_deliveries`, so next week differs). They are the same
fact seen from two sides and must agree.

They did not, and the integration suite caught it on 2026-09-21: the quota
counted a dry run and the delivery record only fired on a real send. With
`TELEGRAM_DELIVERY` off — the default everywhere, and the state of production
until it is set — every week consumed the quota and marked nothing, so the same
three tenders came back forever. Both now key off
`COMPLETED_EVENTS` / `Delivery.completed`, which is one named pairing rather
than two lists that can drift. A *failure* still records neither: it raises for
the backoff or returns `outcome="failed"`, both before the recording line.

### The blank-value trap, and why the ME/EPP line is a block

`templates.py` raises `MissingPlaceholder` on a **blank** value, on purpose. The
ME/EPP row in `telegram/partial-digest-item.md` is therefore a `[[se: tem_meepp]]`
block, not a placeholder set to `""`: with the flag false the line is removed
before substitution and `render_item` passes nothing at all for it.
`ME_EPP_MARKERS` covers the three values that produce a line and deliberately
omits `none` and `null`, which produce none. `test_telegram.py` renders an item
for every value `tenders_me_epp_summary_check` allows.

### Markdown, and the tender whose title contains an underscore

E0's bodies use `*negrito*`, which is Telegram's *legacy* `Markdown` parse mode,
and that mode cannot escape a stray `*`, `_`, `[` or backtick. The values we
substitute are PNCP objects and agency names written by whoever published the
tender, so one object reading `MATERIAL_ESCOLAR` is enough for `400 can't parse
entities` to drop a whole digest. Two defences: `telegram.escape_markdown` is
applied to every **value** before it reaches the template (never to the body, so
E0's own `*…*` still works), and a rejected parse is retried once without
`parse_mode`. Visible asterisks beat a digest that silently did not arrive.

### LGPD (§12)

A chat id is personal data. It is read from `telegram_links` at send time and is
never logged, never in an exception, never in `jobs.error` and never in an
`events` row. Log lines carry `telegram.chat_ref()` instead — a truncated
SHA-256, the same shape as `company.cnpj_ref`. `httpx` is pinned below INFO
because its request log line contains the bot token.

### Previewing one without sending it

```bash
python worker/scripts/preview_digest.py --cnae 4761003 --uf SP     # a sample company
python worker/scripts/preview_digest.py --user 42                  # a real account
```

Read-only in both modes — it sets `default_transaction_read_only` and never
touches the transport — so it is safe against production and is how E1's exit
criterion was demonstrated.

### E1's test database

| Variable | Used by | Rows it touches |
|---|---|---|
| `TEST_DATABASE_URL_E1` | `test_integration_telegram.py` | `users` whose e-mail starts `e1-test-<run>-`, their `companies` (`e1t<run>…`), `telegram_links`, `alerts` and `alert_deliveries` (all by cascade), `tenders` for the fictitious agency `99…1`, and the `events` and `jobs` those users own |

Scoped per **run**, not per task (CLAUDE.md): `users.email` is `citext unique`,
so a task constant would collide on the index before it could delete anything.
Cleanup deletes `events` **before** `users` — `events.user_id` is `on delete set
null`, not cascade, so a delivery-log row otherwise outlives its user and becomes
unattributable debris. The one cross-run sweep goes through
`CROSS_RUN_SWEEP_HOURS`, like every other block's.

## Short titles — `title_tender` (deterministic first, the model as the exception)

The Radar card and the detail heading render `trimObject(tender.object)`. PNCP
has no short-title field, and `object` is the legal "objeto", so the useful noun
is usually buried:

> CONTRATAÇÃO DE EMPRESAS PARA FORNECIMENTO DE MATERIAIS PERMANENTES, para
> Secretaria de Saúde, conforme descrito no Anexo I – Termo de Referência…

`licitaqui/titles.py` turns that into **"Fornecimento de materiais permanentes"**
and `licitaqui/title_tender.py` stores it in `tenders.short_title`.

### The two branches, and why the order is load-bearing

`deterministic_title()` strips the `[Portal]` prefix, cuts the objeto at its
first legal connector, drops the trailing stop and un-shouts it. It cannot
hallucinate and it costs nothing.

`needs_model()` sends a tender to the model only when that result is still
unfit, for one of three reasons:

| reason | share of 4,760 production rows |
|---|---|
| free title is good | **24.8%** |
| still longer than 80 characters | 66.3% |
| still opens with procurement boilerplate | 8.0% |
| says nothing but category words ("Obras comuns") | 0.9% |

The ordering is a correctness constraint, not a cost optimisation. Objeto
*"Centro Cultural - Etapa 02"* plus its construction line-items came back from
the model as *"Revestimento cerâmico montagem e desmontagem alvenaria laje e
caixilho"* — the items swamped a perfectly good objeto. **A good short objeto
must never reach the model.**

The third reason is the mirror of that: *"Obras comuns"* is short but says
nothing, and the items are what rescue it — that exact tender becomes *"Obras de
manutenção e melhoramentos em aeródromos e aeroportos"*, read off the item rows.
`is_generic()` is what separates "short" from "uninformative".

### The validator is the guarantee; the prompt is only a request

The first prompt measured asked for "o que e **para quem**", and the model
invented a recipient whenever the text had none — "para MEI", "para pequenas
empresas", "para moradores de Rio Claro" — and once replaced what was being
bought with something more specific than the source ("manutenção de imóveis" →
"pintura e reparos"). Under CDC art. 30 advertising binds the supplier (legal
brief §2.2 rule 1), so a title claiming a tender is "para MEI" is a promise the
product cannot keep.

`validate()` rejects a title that uses a content word present in neither the
objeto nor the item lines **as they were sent**, that carries money, a
percentage, a date or a year the source never wrote, or that evaluates the
tender. On rejection the deterministic title ships and the row records
`short_title_source = 'ai_fallback'` — deliberately distinct from
`'deterministic'`, because a rising count there is the signal that the prompt
has drifted.

### Rate limits

The free OpenRouter pool rate-limits (`limit_source:
upstream_provider_shared_pool`). `model_title()` retries with jittered backoff;
a tender still rate-limited after that is **left untitled** and raises
`RateLimited`, so the queue retries it and it is never recorded as titled with
the unfit deterministic string frozen onto it. A 429 does **not** count toward
the OpenRouter breaker — it is the provider answering — while a 5xx does.

### Staleness

`titles.BASIS_SQL` digests the objeto, `pncp_updated_at` and the whole item set
into `tenders.short_title_basis`; a title is current only while the stored
digest still equals the recomputed one. `titles.STALE_SQL` adds the two version
columns. A **rules** bump re-titles everything; a **prompt** bump re-titles only
the rows the model actually saw, which is why they are two columns and not one.

```bash
python -m scripts.backfill_titles --dry-run     # cost and split, writes nothing
python -m scripts.backfill_titles               # the real thing
python -m evaluation.titles --mode recorded     # the gate, offline and free
```

## Tender values — `refresh_tender_value` (why "Valor não informado" was everywhere)

On 2026-09-22 the Radar said **"Valor não informado"** on 5,080 of 5,965 tenders
while `pncp.gov.br` showed the number for the same contratação. The cause is not
a mapping bug and not confidential budgets. It is ADR-0001's search fallback:

| stored payload | rows | with `estimated_value` |
|---|---|---|
| search index (snake_case) | 5,080 | **0** |
| Consulta detail (camelCase) | 885 | 885 |

The search index publishes no `valorTotalEstimado`, no `srp` and no
`orcamentoSigilosoCodigo`, and **nothing ever went back for them**. B2 enqueues
`sync_items` and `sync_files` for a changed tender; there was no header re-read,
so a row that entered degraded stayed degraded for life. The 885 are frozen from
the last healthy stretch while the search-sourced set grows every cycle, so
coverage decays on its own — Sci measured 20 % of 4,430 a few days before this
read 14.8 % of 5,965.

### Two sources, in one order

1. **`valorTotalEstimado` from the Consulta detail.** Authoritative, and the
   field the portal renders as "VALOR TOTAL ESTIMADO DA COMPRA". Sci's rule is
   that the number we show is PNCP's own, so this always wins when it answers.
2. **the sum of `tender_items.total_value`.** POC 1's fallback, already computed
   at ingest by `items.total_estimated_value` and already trusted to assert a
   *legal* ME/EPP preference on the card — it was simply never persisted.

**They agree 94.7 % of the time, not always.** Across the 777 production tenders
holding both a positive header and items summing above zero, 736 match to the
cent and **41 do not**. The item sum is never *lower* — where it differs it
over-counts, because grouped lots and ME/EPP cotas are listed beside the items
they are carved from (one of the 41 has 283 item rows and 71 distinct
descriptions). Hence the order above, expressed once in `items.pick_total` and
shared with `favored_treatment` so the value on a card and the ME/EPP claim
beside it can never come from different arithmetic.

**The 41 have no systematic cause.** All of them are `Pregão - Eletrônico`,
which looks like a signal and is not: Pregão is the only modality with any
consulta-sourced rows at all (`Dispensa` 0 of 1,133, `Concorrência - Eletrônica`
0 of 340), so it is the only one where the two figures *can* be compared. The
ratio is a smooth spread — 18 at 1.00, then 1.01, 1.02, 1.03, 1.06 … 1.17, with
a short tail at 2.0, 2.6, 3.1 and 13.3 — the shape of many small over-counts,
not of one repeated defect.

### Is the item sum computed over a complete item set?

A sum over a half-fetched list is plausible and wrong, and it would be shown
under PNCP's own vocabulary. Two things answer it.

**By construction:** `sync_items` materialises the whole list before it writes
anything (`records = list(client.iter_items(...))`); a page walk that fails
raises out of that `list()`, the job fails, and nothing is written. A partial
set is not reachable — a failed fetch leaves *zero* items, and zero items sum to
nothing and take no fallback.

**Measured**, across all 6,123 production tenders holding items:
`max(updated_at) - min(updated_at)` is under a minute on **6,123 of 6,123**.
Every stored item set was written in a single pass; not one was assembled across
two.

Two checks that look like completeness tests and are **not**, recorded so nobody
re-derives them:

- the `sync_items:` marker the PNCP-404 lane added exists on **0** of the 4,625
  value-less tenders — it is new and these rows predate it, so it cannot serve
  as a floor today (it will, once the corpus has turned over);
- item numbering is **not** dense: 679 of 6,123 tenders have non-contiguous
  `numeroItem`, because agencies use catalogue numbers (one tender's single item
  is numbered 66215, another's twenty run from 2272848) and because an amendment
  legitimately withdraws a lot. A "numbers must be 1..N" guard would reject 11 %
  of the corpus for being normal.

### A published zero is a figure, not an empty cell

108 production rows hold `estimated_value = 0.00` because that is what PNCP
published. The item sum **never** overwrites them: `APPLY_ITEM_SUM_SQL` fills
`is null` only, so our arithmetic cannot replace PNCP's answer. They are
resolved by the detail fetch instead — the `/atualizacao` period record that
wrote them carries no `orcamentoSigilosoCodigo` at all (measured: absent on all
108) while the detail endpoint does, so the refresh sets `confidential_budget`
and the card can say "orçamento sigiloso" rather than invent a total.

`VALUE_SOURCE_ITEMS` is recorded on every row that took the fallback, in an
`events` marker (`tender_value:<id>`), so the minority stays findable and the
agreement rate is queryable after a backfill rather than something to re-derive.

### It writes columns, not `raw`

The obvious implementation maps the detail with `tenders.from_consulta` and
upserts it like anything else — which merges the whole payload into `tenders.raw`.
Measured with `pg_column_size` against production, that adds **2,822 bytes to
each of the 5,373 search-sourced rows: about 14 MB**, against **15.3 MB of
headroom** on a Neon project already at 496.7 of 512 MB. It would fill the disk
rather than fix the Radar. So `tender_value` writes the columns it came for and
leaves `raw` alone; `raw` keeps saying which sweep ingested the row, which is
true and is the diagnostic the whole investigation turned on.

### Three ways in, because each has a hole the next covers

- **the root cause** — the search fallback in `sync_tenders` now enqueues
  `refresh_tender_value` for every row it writes. On its own this is not enough:
  the fallback fires *because* `/api/consulta` is down, so the job it queues is
  aimed at a service we already know is not answering.
- **the sweep** — `sweep_tender_values` runs every 30 minutes at priority 9 and
  enqueues whatever is still unvalued, capped at `SWEEP_BATCH` per cycle. This is
  what actually drains the backlog once Consulta returns, and it is also the
  backfill: the same job, run repeatedly.
- **the backoff** — `tenders.next_refresh_at`, a column §6.1 already defines and
  indexes and which nothing else read, holds when a tender may be looked at
  again. No migration; the column was already there. **Three horizons**, and the
  spread is a §14.1 storage decision as much as a freshness one, because parking
  rewrites the row on every visit and on Neon every rewrite costs storage twice:

  | state | wait | why |
  |---|---|---|
  | no value at all | **6 h** (§3.2 header TTL) | the bug's population; chase it |
  | valued, but from the item sum | **7 days** | already showing a number that is right to the cent ~95 % of the time. At 6 h, 4,600 rows would churn ~30 MB/day |
  | `410 GONE` | **30 days** | the contratação was excluded; there is nothing to fetch |

  A tender is "done" when its marker says `consulta` or `gone` — **not** when it
  merely has a value, because `items.roll_up` fills one from the item sum. A
  "has a value" test would call an unchecked number finished, and on every new
  tender, since the fallback enqueues `sync_items` and the refresh together and
  does not order them.

### 410 and 301

`410 GONE` is PNCP's only unambiguous "never coming back" — the agency excluded
the contratação. It **parks** the row for 30 days rather than retiring it, because
what a withdrawn tender looks like on the Radar is a product decision `absence.py`
already records as Sci's, not the collector's. Neither the 410 nor a 404 counts
against the `pncp-consulta` breaker, so a backfill over withdrawn tenders can
never be what opens the circuit the sweep depends on.

The retired `/api/pncp/v1/orgaos/…` spelling of the detail endpoint answers
**301 — and, measured 2026-09-22, with no `Location` header at all**, so
`follow_redirects` is powerless and httpx hands the 301 straight back. The body is
a JSON error naming the new path. `pncp.CONTRATACAO_PATH` has always used the
`/api/consulta/v1/…` spelling; `_http_error` now says all of this in the message
rather than leaving the next person a bare "HTTP 301" to re-measure, and
`test_tender_value.py` pins the constant so the old spelling cannot creep back.

### Backfilling

```bash
python -m scripts.backfill_tender_values --dry-run      # counts and headroom, writes nothing
python -m scripts.backfill_tender_values --items-only   # no PNCP call at all
python -m scripts.backfill_tender_values --limit 500
```

It is **resumable because of what it selects**, not because of a cursor: the work
queue is a query for tenders with no positive value whose backoff has come round,
so a run that dies at row 3,000 leaves the rest matching that query and the next
run picks them up. Each row is written and marked in its own autocommit statement.

A **failed write is never a success**: `DiskFull` and any other write error are
caught per row, counted under `failed`, and not counted as upgraded — nothing is
marked and `next_refresh_at` is left alone, so the row is still due next time.
`--check-headroom` refuses to start within `MIN_HEADROOM_MB` of the project limit,
and `--pause-every` gives autovacuum room during a long run.

### Storage, and the thing that actually needs attention

Required by §14.1 before any backfill runs at scale. A column-only pass rewrites
one heap tuple per row and adds **no TOAST**, because `raw` — which holds most
of the row's bytes — is not touched and keeps its existing TOAST pointer.

Worth recording while the numbers are fresh, because it is the real constraint and
not this job's to fix: **`tender_items` is 231 MB of the 293 MB database, and
155 MB of that is the per-item `raw` jsonb** — 1,268 bytes per row against 175
characters of actual description (21 MB of descriptions in total). Every field
`items.from_pncp` extracts is stored twice, once in a column and once in the
payload it came from. Trimming `raw` on items is the single largest lever on the
512 MB limit, and it is a schema-and-backfill decision for Sci rather than
something to slip into this lane.
