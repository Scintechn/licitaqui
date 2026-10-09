# ADR-0002 — Company lookup uses BrasilAPI's CNPJ endpoint, with the manual CNAE form as fallback

- **Date:** 2026-09-17
- **Status:** Accepted
- **Gap:** G8 (`DEVELOPMENT_PLAN.md` §1.2) · **Blocks:** M2 CNPJ entry
- **Spec touched:** `TECHNICAL_SPEC.md` §3.2 (company TTL 30 days, "on failure the user enters the
  CNAE"), §7.1 `company_lookup`

## Context

When a user enters their CNPJ, `company_lookup` must return the company's **primary CNAE,
secondary CNAEs, size and MEI status**; those feed the CNAE → segment map (gap G6) and the
"Compatível / Verificar" badge on the Radar. `GET https://brasilapi.com.br/api/cnpj/v1/{cnpj}`
is the candidate. The recorded default if the spike were inconclusive is manual CNAE entry.

## What was measured

Probe: `worker/scripts/probe_brasilapi_cnpj.py`, single attempt per lookup (**no retries** — a
failed lookup is exactly what would push a user to the manual form), 15 s timeout, 2 s between
lookups, on 2026-09-17 around 21:40 UTC.

**Sample: 45 distinct CNPJs.** They are not arbitrary well-known companies: they are real
suppliers that won items in recent PNCP tenders, harvested from
`/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{seq}/itens/{n}/resultados` over 78 closed tenders —
that is, the same population LicitaQui will actually look up. All are legal entities; no
personal data was used. Size mix: 22 micro-enterprises, 8 EPP, 15 "DEMAIS"; 44 active, 1 closed.

| Measure | Result |
|---|---|
| Lookups | 45 |
| Failed | **0** (**0 %**) |
| Latency (min / median / p95 / max) | 0.44 s / **0.52 s** / 0.78 s / 0.82 s |
| Burst of 12 back-to-back | 12 × HTTP 200, **no 429**, 1.38 s total |

Field coverage over the 45 successful lookups:

| Field | Present | Note |
|---|---|---|
| `cnae_fiscal`, `cnae_fiscal_descricao` | **45 / 45** | primary CNAE, as an integer code plus label |
| `cnaes_secundarios` | **41 / 45** non-empty | median 6, max 70; the 4 empties are genuine, not errors |
| `porte` + `codigo_porte` | **45 / 45** | `"MICRO EMPRESA"` / `"EMPRESA DE PEQUENO PORTE"` / `"DEMAIS"`, codes 1 / 3 / 5 |
| `descricao_porte` | **0 / 45** | **the field exists but is always `null`** — do not read it |
| `opcao_pelo_mei`, `data_opcao_pelo_mei` | 30 / 45 non-null | `true` for 5 companies |
| `opcao_pelo_simples` | 30 / 45 non-null | `true` for 22 companies |
| `razao_social`, `descricao_situacao_cadastral`, `uf`, `municipio` | 45 / 45 | |
| `nome_fantasia` | 29 / 45 | often blank in the source registry |

The **15 null MEI/Simples values are not failures**: 13 of the 15 are `porte = "DEMAIS"`, i.e.
companies with no Simples Nacional record at all. `null` means "no Simples/MEI registry entry",
which for our purposes is the same as "not MEI" — but it must be normalised in code, because
`null` is not `false`.

Two honest limits on these numbers:

- **The burst did not really test the rate limit.** It replayed CNPJs fetched moments earlier and
  every response came back in 0.10–0.15 s with `x-vercel-cache: HIT`. It shows BrasilAPI's edge
  cache absorbing ~9 req/s; it does **not** establish the uncached limit. The uncached evidence
  is the sequential run: 45 lookups at 0.5 req/s, zero throttling, and no rate-limit headers on
  any response.
- **One session, ~4 minutes.** Zero failures in 45 lookups bounds the true failure rate at about
  **7 %** (95 % confidence, rule of three: 3/45) — good enough to build on, not good enough to
  skip the fallback.

## Decision

**Use BrasilAPI as the CNPJ lookup in `company_lookup`, and keep the manual CNAE form as the
fallback path rather than as a rescue.** The API supplies every field the spec asks for; the
default (manual entry) is demoted from primary plan to fallback, which is what the measurement
supports.

For the implementation (M2):

1. Read `cnae_fiscal` for the primary CNAE and `cnaes_secundarios[].codigo` for the rest; feed
   both into the G6 segment map.
2. Take size from `codigo_porte` (1 / 3 / 5), not from `descricao_porte`, which is always null.
3. Normalise `opcao_pelo_mei`/`opcao_pelo_simples`: treat `null` as false, but store the
   distinction so we never tell a user "you are not MEI" on the strength of a missing record.
4. Honour the §3.2 TTL of 30 days and the §3 rule that the call happens in a job, never in a web
   request. At 0.5 s per lookup the job is cheap; there is no case for pre-fetching.
5. On any failure — non-200, timeout, or a payload missing `cnae_fiscal` — fall straight through
   to the manual CNAE form. Do not retry in front of a waiting user; one attempt, then the form.
6. Check `descricao_situacao_cadastral`: one of the 45 suppliers was `BAIXADA` (closed). A closed
   CNPJ should be surfaced to the user, not silently accepted.

## Consequences

- **Good:** CNAE entry stops being manual for the common case. At 0.52 s median the lookup is
  fast enough to run while the user waits for the next screen.
- **Good:** BrasilAPI needs no key, so nothing new goes into `.env`.
- **Bad:** we depend on a free community service with no SLA and no contract with us. The manual
  form is therefore not optional — it is the thing that keeps signup working when BrasilAPI is
  down, and it must be tested as a real path, not a dead branch.
- **Bad:** the uncached rate limit is unknown. `company_lookup` must stay single-threaded per
  worker with a modest delay until we have evidence, and must treat 429 as "go to the manual
  form", not as "retry hard".
- **Neutral:** no spec change. §3.2 and §7.1 already describe this shape.

## What would change this decision

Re-run `worker/scripts/probe_brasilapi_cnpj.py` and reconsider if any of these appear:

- failure rate above **5 %** over a sample of 100+ CNPJs, or repeated 429s at our real call rate;
- `cnae_fiscal` or `cnaes_secundarios` missing on a material share of lookups, which would make
  the segment map unreliable and push manual entry back to being the primary path;
- BrasilAPI introducing authentication or paid tiers.

If two of those hold, the fallback becomes the default again and the lookup becomes a
best-effort convenience. Worth re-measuring once real signup volume exists, since 45 lookups in
one session cannot see a daily quota.

---

## Appendix — B5 implementation run, 2026-09-18

Measured while implementing `company_lookup` (B5), with the handler itself rather than the
probe: `worker/scripts/check_company_lookup_live.py --limit 50`, 2026-09-18 around 00:02 UTC.
**Sample: 50 distinct supplier CNPJs**, harvested the same way as the 45 above — winners of
awarded items in the 79 closed PNCP tenders cached from POC 1, legal entities only. It overlaps
the original sample only by chance; the list is not committed, for the same reason the first one
was not (§12). Three of the 50 had been fetched ~40 minutes earlier and came back edge-cached
(0.06–0.10 s), so **47 of 50 are uncached evidence**.

| Measure | 45-CNPJ spike (B0) | 50-CNPJ implementation run (B5) |
|---|---|---|
| Lookups | 45 | 50 |
| Failed | 0 (0 %) | **1 (2 %)** |
| HTTP latency (min / median / p95 / max) | 0.44 / 0.52 / 0.78 / 0.82 s | 0.06 / **0.42** / 0.61 / 1.43 s |
| End to end incl. the 1 s spacing and the upsert | — | 0.57 / **1.43** / 1.69 / 2.54 s |
| Call rate | 0.5 req/s | **1 req/s**, 50 lookups in 73.7 s |
| 429s | 0 | **0**, and no rate-limit header on any of the 49 responses |

Three things the implementation run **confirms**:

- `descricao_porte` was null on **49 / 49** successful lookups. `codigo_porte` was present on
  all 49 (22 × 1 → ME, 19 × 3 → EPP, 8 × 5 → DEMAIS). Reading `codigo_porte` is right.
- `cnae_fiscal` was present on **49 / 49**. The segment map has something to join on.
- `razao_social` 49 / 49; `nome_fantasia` 39 / 49, still often blank.

Three things it **contradicts or refines**, which is why it is recorded here:

- **"Null for roughly a third" is sample-dependent.** `opcao_pelo_mei` was null on **7 / 49
  (14 %)**, not ~33 %. The explanation is the one the ADR already gives — nulls cluster in
  `porte = DEMAIS`, and this sample has 8 DEMAIS against the original's 15. The *rule* holds and
  the code must still keep the third state (`is_mei` is `true` for 2, `false` for 40, `null` for
  7); only the headline proportion moves with the sample.
- **`cnaes_secundarios` reaches at least 97, not 70.** Median 14, max **97**, and **none** of
  the 49 were empty (the ADR saw 4 / 45 empty). Empty is still possible and still handled; the
  upper bound is simply higher than measured, so nothing may assume a ceiling.
- **The one failure was not an HTTP status.** It was `httpx.RemoteProtocolError` — the server
  closed the connection without sending a response — on lookup 10 of 50. A fallback that only
  inspects status codes would have missed it. Combined failure rate across both runs: **1 / 95
  (≈ 1 %)**, comfortably under the 5 % threshold above.

Two smaller notes:

- No `BAIXADA` company appeared in this sample (49 × `ATIVA`), so ADR item 6 remains tested only
  by the fixture in `worker/tests/fixtures/brasilapi/epp_baixada.json`.
- `company_lookup` verifies the mod-11 check digits before calling, so a mistyped CNPJ costs the
  free public API nothing and is recorded as `lookup:not_found` rather than blamed on BrasilAPI.

**The rate limit is still not established.** What is now established is a floor: 1 req/s
sustained for 50 uncached lookups draws no 429 and no rate-limit header. The worker keeps
lookups single-threaded process-wide with a 1 s minimum gap
(`licitaqui.brasilapi.MIN_INTERVAL_SECONDS`), which is that measured floor and not a guess.
Finding the ceiling would mean deliberately hammering a free community service, which is not
worth doing for a product that makes one lookup per signup.

## Amendment 2026-10-09 — a second source behind BrasilAPI

**Context.** The decision above made BrasilAPI the only source, with the manual CNAE form as
the fallback. Production then went a week without a successful lookup: the last one that
resolved was 2026-10-02 22:10 UTC, and the two after it (2026-10-08 19:23 and 2026-10-09
12:18 UTC) both wrote `lookup:failed`. On 2026-10-09 BrasilAPI answered `500` for every uncached
CNPJ tried — including Petrobras — with a body naming an upstream `503`, and minhareceita.org
answered `503` directly. Found by Sci searching a CNPJ on `/radar` and getting *"Não conseguimos
ler as atividades deste CNPJ"* with every count at zero.

**Decision.** `company_lookup` asks **CNPJá's open endpoint** (`open.cnpja.com/office/{cnpj}`,
no key) when BrasilAPI cannot answer — a 5xx, a timeout, an open circuit, or a 404. BrasilAPI
stays first. `licitaqui/cnpja.py` returns the same `CompanyRecord`, under its own breaker, with
the same one-request / no-retry / sanitised-error contract. A BrasilAPI 404 is asked again
because its upstream is built from the Receita's periodic dump, so a newly opened company can be
missing there (**inferred** from minhareceita's own description, not measured). The mod-11 check
digits stop every single-digit typo before either source is asked; a two-digit error can still
pass them. Only **both** sources answering 404 records `lookup:not_found`; any other combination
of misses records `lookup:failed`. Either way the row has no CNAE, and only then does the user see
the manual-CNAE state. CNPJá sends `optant: false` with an empty history for a company that was
never in Simples/SIMEI (measured on Petrobras), so that shape is stored as `null` — unknown — as
BrasilAPI's rows are, and never as "not a MEI". A payload whose `taxId` is not the CNPJ asked for
is rejected rather than stored.

**Measured 2026-10-09**, same afternoon, same CNPJ: CNPJá 200 in 0.25–0.4 s with the main CNAE,
all six secondary CNAEs, porte, Simples/SIMEI history, status, UF and city; `publica.cnpj.ws` 200
in 0.6 s with the same fields and `x-ratelimit-limit: 3` per minute. **Not measured:** CNPJá's
rate limit. It sends no rate-limit headers and its docs page answered `429`; the client spaces
calls 12 s apart (five a minute) as the polite figure, not a known one.

**Considered and not chosen:** `publica.cnpj.ws` (3/min and the same data — a reasonable third
source if this one ever fails too); `cnpjapi.com.br` (needs an account and an API key, free tier
300/day — a credential for Sci to create, not a code change); `listacnae.com.br` (a lead-list
builder that searches companies *by* CNAE and municipality, not a per-CNPJ lookup).
