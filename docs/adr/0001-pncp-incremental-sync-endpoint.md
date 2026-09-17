# ADR-0001 — Build the PNCP incremental sync on `/v1/contratacoes/atualizacao`, with the search API as fallback

- **Date:** 2026-09-17
- **Status:** Accepted
- **Gap:** G7 (`DEVELOPMENT_PLAN.md` §1.2) · **Blocks:** M2 sync design, task B2
- **Spec touched:** `TECHNICAL_SPEC.md` §3.2 (TTLs, `data_atualizacao_pncp`), §7.1
  `sync_open_tenders`, §7.2 (circuit breaker on `/api/consulta`)

## Context

`sync_open_tenders` runs every 30 minutes and must answer one question cheaply and *completely*:
**which tenders are new or have changed since the last run?** Missing a change is the expensive
failure — the product's value is telling a user about a tender before it closes.

Two candidate bases:

- **A — the search API** `GET /api/search/`, which POC 1 uses. It is the undocumented backend of
  the `pncp.gov.br/app/editais` screen.
- **B — the Consulta API period endpoints** `GET /api/consulta/v1/contratacoes/publicacao` and
  `/atualizacao` — documented, versioned, and designed for sweeping a date range.

The recorded default was "keep the POC search API". **This ADR overturns that default**, and the
reasoning below is worth reading before accepting it, because the availability numbers point the
other way from the correctness numbers.

## What was measured

Probe: `worker/scripts/probe_pncp_endpoints.py` plus an availability sweep, single attempt per
request (**no retries**, so a failure is counted, not hidden), 30 s timeout — the §7.2 query
budget. 2026-09-17, three runs between 20:21 and 20:58 UTC.

| Arm | Requests | Failed | Failure rate | Latency of successes (median / p95 / max) |
|---|---|---|---|---|
| A — `/api/search/` | 52 | **0** | **0 %** | 2.07 s / 6.15 s / 7.37 s |
| B — `/contratacoes/publicacao` | 46 | **8** | **17.4 %** | 3.05 s / 6.40 s / 7.17 s |
| C — `/contratacoes/atualizacao` | 46 | **8** | **17.4 %** | 3.01 s / 6.44 s / 8.20 s |

**Every single one of those 16 failures fell inside one outage window**, and all 16 were
timeouts — the request never returned inside 30 s. Between roughly 20:21 and 20:34 UTC the
`pncp-consulta` service returned nothing usable; 5 exploratory calls in the same window failed
too, 3 by timeout and 2 with HTTP 500 `Erro na comunicação com o banco de dados`. From 20:44
onward it recovered completely: **76 of 76 period-endpoint requests succeeded**, including a
rotating sweep of 34 requests per endpoint over 11 minutes with zero failures.

The search API was up throughout, including during the consulta outage. That is the one fact
that argues for the default. (A further 17 ad-hoc search calls made while characterising
pagination also returned 200, apart from two deliberately over-the-cap requests that correctly
returned 400.)

Two controls show the outage was PNCP's and not ours: omitting the required
`codigoModalidadeContratacao` returned **HTTP 400 in 0.78 s** with a precise validation message
*during* the outage — so the service was reachable and parsing our requests, and failing in its
data layer — and `/api/pncp/v1/.../itens` answered **200 in 2.3 s** in the same window, so PNCP
as a whole was healthy. This is the same service behind the detail endpoint the POCs already
found unreliable, and which §3.2 already calls "unstable".

### Why the period endpoints win on correctness

- **They window on the right timestamp, server-side.** In a page of
  `/atualizacao?dataInicial=20260916&dataFinal=20260916`, **all 50 records** had
  `dataAtualizacaoGlobal` on 2026-09-16, while their publication dates ranged from **2024-08-14
  to 2026-09-16** and their `dataAtualizacao` values spanned five months. So the filter is on
  `dataAtualizacaoGlobal` — *the record or any of its children changed* — which is exactly the
  trigger §7.1 needs for re-running `sync_items` and `sync_files`. The search index exposes
  `data_atualizacao_pncp`, but whether that moves when only a tender's **items or files** change
  is unverified; `dataAtualizacaoGlobal` is defined to.
- **No paging cap.** `/atualizacao` for one day × one modality reported 4,472 records over 90
  pages, and page 90 of 90 returned its 22 records normally; page 300 returned a clean `204`.
  The search API hard-caps `pagina × tam_pagina` at **10,000** (`pagina=201, tam_pagina=50` →
  HTTP 400, "Janela de resultados muito grande") against a corpus of **38,856** open tenders. A
  recovery sweep after any worker downtime longer than ~10,000 updates cannot be expressed in the
  search API without partitioning by UF and modality.
- **Fields that currently require the flaky detail endpoint.** Per record:
  `valorTotalEstimado` (50/50 — POC 1 has to sum items because the detail endpoint is down),
  `dataAberturaProposta`/`dataEncerramentoProposta` (50/50), `linkSistemaOrigem` (30/50), and
  **`srp`** (36/50), the structured "sistema de registro de preços" flag that POC 1 currently
  infers from a keyword false-positive list (§7.1).
- **It is a documented, versioned contract**; the search API is a web screen's backend that can
  change shape without notice.

### Where the search API is better

- **Availability**, on this evidence: 0 % vs 17.4 %.
- **Throughput.** `tam_pagina=500` works (500 records in 5.4 s). The period endpoints reject
  anything but **50** per page ("Tamanho de página inválido" for 100 and 500), so they need ~10×
  the requests for the same volume — about 90 requests per day per modality.
- **`ordenacao=-data` really is update-ordered**: over a page of 50, `data_atualizacao_pncp` was
  monotonically descending while `data_publicacao_pncp` was not. A watermark sweep does work.
  There is no server-side date filter, though — `dataInicial`/`dataFinal` and
  `data_publicacao_pncp` are silently ignored (total unchanged at 38,830).

## Decision

**Build `sync_open_tenders` on `/v1/contratacoes/atualizacao`, and keep the POC's search sweep as
a fallback behind the §7.2 circuit breaker.**

The deciding argument is the asymmetry of the two failure modes. A period-endpoint outage
**delays** a sync cycle: the query is a date window, so re-running it later returns exactly the
same set and nothing is lost — the existing backoff (2, 8, 30 min) already covers it. A
search-API sweep that misses a change **loses it silently**, because the watermark has already
moved past it. We are choosing the endpoint whose failures are visible and self-healing over the
one whose failures are invisible.

For task B2:

1. Each cycle, query `/v1/contratacoes/atualizacao` for the window since the last successful run
   (a day granularity, re-querying today's window each time), per modality (6, 8, 4), paging at
   `tamanhoPagina=50` until `paginasRestantes` is 0. Upsert on `numeroControlePNCP` so replays
   are idempotent (§7.2).
2. Store the window, not a row-level watermark, and only advance it when a cycle **completes**.
   A partial cycle must be retried whole.
3. Use `dataAtualizacaoGlobal` as the change trigger for enqueuing `sync_items` and `sync_files`;
   persist it alongside `data_atualizacao_pncp`.
4. Extend the §7.2 circuit breaker from the detail endpoint to all of `/api/consulta`: after 2
   consecutive failures, fall back to the search sweep (`ordenacao=-data`, `tam_pagina=500`,
   stopping at the watermark) for the hot loop, and mark the cycle as degraded so the next
   consulta-backed cycle re-queries the skipped window rather than trusting the fallback.
5. Keep `/publicacao` for the initial backfill by publication date; `/atualizacao` alone would
   re-walk history.

## Consequences

- **Good:** change detection is complete and server-side, including item and file changes, with
  no dependence on undocumented ordering or on a 10,000-record window.
- **Good:** `srp`, `valorTotalEstimado` and the proposal dates arrive with the header, so the
  collector needs the unstable detail endpoint less than POC 1 did.
- **Bad:** we build on the *least* reliable PNCP service we measured, and we now carry two code
  paths for the same job. The fallback is not free, and an untested fallback is worse than none —
  B2 must exercise it in tests, not just write it.
- **Bad:** 50 records per page means ~10× the request count. At the §7.2 throttle of 4 req/s a
  full day's reconciliation across three modalities is a couple of minutes of steady traffic —
  acceptable, but it must run off-peak.
- **Neutral:** no spec change needed. §7.1 and §7.2 already describe this job and its breaker;
  §7.2's breaker scope widens from `/api/consulta` detail to the whole service.

## What would change this decision

- **Re-measure before B2 locks this in.** 92 period-endpoint requests across ~40 minutes on one
  afternoon, containing exactly one outage, is a thin basis for an availability claim. Run
  `worker/scripts/probe_pncp_endpoints.py` hourly for a day. If the period endpoints fail more
  than **10 %** of the time over a full day, or show outages longer than about **2 hours** (four
  missed 30-minute cycles), invert this: make the search sweep primary and use `/atualizacao`
  only for a nightly reconciliation pass.
- **Settle the one open question that would make the search API sufficient:** does a tender's
  `data_atualizacao_pncp` in the search index move when only its *items or files* change? If it
  does, the main correctness argument here collapses, and the simpler single-path search design
  wins. This is worth an hour of B2's time before building either path.
- If PNCP raises the period endpoints' `tamanhoPagina` above 50, the throughput objection goes
  away entirely.
