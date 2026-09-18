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

## Tests

```bash
pytest                       # unit tests always; database tests when configured
ruff check . && ruff format --check .
```

The database tests need an isolated, already-migrated Neon database and skip
without one. Each task has its own so two test runs cannot collide:

| Variable | Used by | Rows it touches |
|---|---|---|
| `TEST_DATABASE_URL` | B1's queue and consumer tests | `jobs` rows whose key or kind starts with `b1-test-` / `b1t_` |
| `TEST_DATABASE_URL_B2` | B2's sweep tests | `tenders` rows for the fictitious agency `99000000000102`, the `sync_open_tenders.*` events scoped to UF `ZZ`, and the follow-up jobs keyed on that CNPJ |

Both are resolved the way `db/migrate.py` resolves its own connection string,
and both are wrapped in a redacting `Dsn` type before they can reach a fixture
repr: pytest renders fixture values into tracebacks, and a connection string
that reaches a CI transcript is a leaked credential. Deletes are always scoped by
prefix — no test ever truncates a table.

Known flake, not B2's: `test_integration_queue.py` and
`test_integration_consumer.py` fail intermittently against the shared Neon
compute (measured on `main`'s code: 2 failures in run 1, 0 in runs 2 and 3 of an
otherwise identical sequence). Re-run before believing a failure there.
