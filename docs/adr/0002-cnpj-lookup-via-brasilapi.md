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
