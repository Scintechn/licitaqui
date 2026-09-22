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

---

## Verification — 2026-09-18 (task B2)

Two things were tested before B2 built anything: the open question, and the availability
claim. **The open question is settled and the decision holds. The availability claim is
now in doubt**, and by this ADR's own inversion rule it is close to being triggered.

### 1. The open question: does the search index see item and file changes? **No.**

**The answer is no, and it is not marginal.** `/atualizacao`'s `dataAtualizacaoGlobal`
moves for child changes; the search index's `data_atualizacao_pncp` does not. The main
correctness argument for this ADR stands, and the simpler search-only design would lose
changes.

*Method.* Each Consulta record carries two timestamps: `dataAtualizacao`, the header row,
and `dataAtualizacaoGlobal`, "the record **or any of its children** changed". A record
where global > header is therefore one whose *header did not change* — the change was in
an item or a file. For each such tender, the live search index was asked what it thought
the update time was. `/api/consulta` was down throughout (see §2), so the two Consulta
timestamps were read from the 95 cached detail responses in the knowledge base
(`cache_pncp/`, collected 2026-09-14 to 09-16) and only `/api/search/` — which was
healthy — was called live, once per tender. Reproduce with:

```
python3 worker/scripts/probe_search_change_detection.py \
    --from-cache "<knowledge base>/cache_pncp"
```

*Result.* **79 of the 95 cached tenders (83.2 %) had `dataAtualizacaoGlobal` >
`dataAtualizacao`** — a child change is the common case, not an edge case. All 79 were
still present in the search index. Of them:

| Search index `data_atualizacao_pncp` equals… | Tenders |
|---|---|
| `dataAtualizacao` — the **header only** | **74** |
| `dataAtualizacaoGlobal` — child-aware | **0** |
| neither (changed again after the cache was taken) | 5 |

74 for 74 conclusive cases, to the second. Not one tender in the sample had a search
timestamp that reflected the child change. Examples:

```
00394429000100-1-002346/2026  hdr=2026-09-16T04:00:17 glb=2026-09-16T04:20:36 srch=2026-09-16T04:00:17
00394429000100-1-002351/2026  hdr=2026-09-16T04:00:54 glb=2026-09-16T04:28:15 srch=2026-09-16T04:00:54
01263896000164-1-000626/2026  hdr=2026-09-16T04:01:20 glb=2026-09-16T04:36:06 srch=2026-09-16T04:01:20
```

The five "neither" cases all show a search timestamp *later* than both cached values,
consistent with a further header edit after the cache was taken; none of them moved to the
cached global value.

A further detail sharpens the point: in every record checked, the index's
`data_atualizacao_pncp` was **byte-identical to its `data_publicacao_pncp`**, sub-second
digits included. On this evidence the field is not an update timestamp that happens to
miss children — for these tenders it had not moved off the publication instant at all.

*Consequence.* A search-only sweep watermarking on `data_atualizacao_pncp` would have
missed a child change on 74 of 79 tenders, silently, because its watermark would already
have passed them. That is precisely the "loses it silently" failure mode this ADR chose
against. **Proceed as decided.**

### 2. The availability claim is worse than measured, and near the inversion rule

This ADR says to invert if the period endpoints "show outages longer than about **2 hours**
(four missed 30-minute cycles)". On 2026-09-17/18 they did.

| Time (UTC) | Probe | Result |
|---|---|---|
| 21:21 | hourly probe | `publicacao` 4/4 timeout, `atualizacao` 4/4 timeout; `search` 2/2 OK (~1.87 s) |
| 22:25 | hourly probe | identical: both period endpoints 4/4 timeout, search fine |
| 23:38 | one-off, `uf=SP` | **HTTP 500** in 32.4 s — `HikariPool-1 - Connection is not available, request timed out after 30000ms` |
| 23:40 → 00:09 | 15 attempts, 90 s apart | **0 successes**: 11 read timeouts, 4 × HTTP 500 `Erro na comunicação com o banco de dados.` |
| 00:27 | one-off | HTTP 500 in 39.7 s, same body |

**A continuous outage from at least 21:21 to 00:27 UTC — 3 h 06 m, six missed 30-minute
cycles.** `/api/search/` answered normally throughout (0.79–0.82 s, 3/3 during the worst
of it), as it did during B0's 13-minute outage. The failure signature is the same one B0
recorded, and the HTTP 500 body names the cause: the service's JDBC connection pool, not
the network and not our requests.

This does not change what B2 built — the decision is Sci's and the correctness argument in
§1 is now *stronger*, not weaker — but it means the inversion trigger has fired once on
duration. Two observations that matter for the decision to revisit it:

- The asymmetry argument still holds, and is what saves us here. A three-hour period-endpoint
  outage delays six cycles; because the query is a date window and the watermark only advances
  on a completed cycle, the seventh cycle returns *exactly* the set the six missed. Nothing
  was lost tonight — the design absorbed a 3-hour outage by construction.
- The fallback is therefore load-bearing, not decorative, and B2 implements and tests it:
  during a consulta outage the cycle sweeps the search index so the product keeps fresh data,
  marks itself `degraded`, and **does not** advance the watermark, so the window is re-swept
  properly once the service returns.

*Recommendation for Sci, not acted on here:* keep `/atualizacao` primary — §1 makes that
unambiguous — but treat a >2 h outage as routine rather than exceptional, and let the
hourly probe run for a full day before M2 to get the daily failure rate this ADR asks for.
If it confirms outages of this length are common, the thing to change is not the endpoint
(the search index cannot do the job) but the *cadence*: a nightly `/atualizacao`
reconciliation pass over a wide window, with the 30-minute cycle tolerating degradation.

---

## Consequence realised — 2026-09-22 (the "Valor não informado" bug)

This ADR's "Bad: we now carry two code paths for the same job" came true in a way
neither the decision nor B2's verification anticipated, and it cost the Radar its
headline number on **85 % of the corpus**.

### What the fallback silently costs

The decision says the search sweep "keeps the product's data fresh". It does not,
for three fields. The search index publishes no `valorTotalEstimado`, no `srp` and
no `orcamentoSigilosoCodigo` — §1 lists the first two among the "fields that
currently require the flaky detail endpoint" — so **every row the fallback writes
is born with those three columns empty**, and B2 enqueues `sync_items` and
`sync_files` for a changed tender but never a header re-read. Nothing ever went
back for them.

The correlation measured on 2026-09-22 is exact, with no exceptions:

| stored payload | rows | with `estimated_value` |
|---|---|---|
| search index (snake_case) | 5,080 | **0** |
| Consulta detail (camelCase) | 885 | 885 |

885 of 5,965 — **14.8 %**. The consulta-sourced 885 are frozen (they date from
the last healthy stretch) while the search-sourced set grows every cycle, so the
ratio decays on its own. Sci measured 20 % on 4,430 rows a few days earlier; the
decay is the bug's signature.

This is not a mapping fault — `raw ? 'valorTotalEstimado'` is false on all 5,080
— and not confidential budgets: `confidential_budget` was `false` on all 5,965
*because the search payload has no code to read*, which made the flag meaningless
rather than merely false. Worse, `tenders.UPSERT_SQL` did not COALESCE that one
column, so a fallback sweep passing over a consulta-sourced tender **overwrote a
real `true` with `false`**.

### Why the asymmetry argument does not cover this

§"Decision" justifies the fallback on the grounds that a period-endpoint outage
only *delays* a cycle, because the window is re-swept once Consulta returns. That
is true of **change detection** and false of **field coverage**. The re-sweep only
rewrites a row whose `pncp_updated_at` has moved; a tender that entered via search
and has not been touched since is never re-read, so its three empty columns are
permanent. The window heals; the row does not.

### What was changed

`licitaqui.tender_value` re-fetches the Consulta detail per tender and writes
those columns — the authoritative path, under Sci's rule that we show what the
portal shows. It is reached three ways, because each has a hole the next covers:
the fallback now enqueues it for every row it writes (the root cause); a
scheduled sweep comes back for whatever is still unvalued (the fallback's own
follow-up is queued precisely when Consulta is known to be down, so it often
fails); and `tenders.next_refresh_at` — a column §6.1 already defines and nothing
else read — backs a tender off so the sweep cannot spin on it.

Where Consulta still yields nothing, the sum of `tender_items.total_value` is
persisted instead. Measured across the 777 production tenders holding both, it
reproduces PNCP's own figure **to the cent on 736 (94.7 %)**; where it differs it
over-counts, never under-counts, because grouped lots and ME/EPP cotas are listed
beside the items they are carved from. Consulta therefore always wins when it
answers.

### For the re-measurement this ADR asks for

The hourly probe it requests has still not been run for a full day, and the
evidence from this work says it should be. During roughly three hours on
2026-09-22 the detail endpoint was **flapping, not down**: over **50**
consecutive minute-spaced probes, **31 × HTTP 200 (~0.8 s), 3 × HTTP 502,
1 × HTTP 503 and 15 × read timeout** — a **62 % success rate** — while
`/api/search/` and `/api/pncp/v1/.../itens` answered every request in under 2 s
throughout. The failures were not evenly spread: they arrived in runs of two to
four minutes separated by longer healthy stretches, which is what makes a
consecutive-failure breaker fire so readily against it.

That is a third failure mode this ADR has not characterised: neither the clean
outage of §2 nor the healthy stretch of §1. It matters for two reasons.

- **It makes a per-tender backfill slow rather than impossible.** Half the calls
  land, and the ones that do not cost 30 s of timeout each. The design absorbs
  it — the queue's backoff covers a miss and the sweep returns for the row — but
  a full pass is paced by PNCP, not by us.
- **It is invisible to a breaker tuned for outages.** Two consecutive failures
  open the circuit for 15 minutes, and this service fails in *runs*, so a
  62 % overall success rate still produces two-in-a-row often. A job that needs many consulta
  calls will spend most of its time circuit-broken even though half the service's
  answers are fine. Nothing here changes the breaker — it is doing what §7.2
  specifies — but whoever re-measures should decide whether a flapping service
  wants a different rule from a dead one.
