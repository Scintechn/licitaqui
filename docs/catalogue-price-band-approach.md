# The price band moves to the Compras.gov.br catalogue — the approach

> **Status, 2026-10-03: the source decision is made and half of it has shipped.**
>
> | | |
> |---|---|
> | **B36** — the vocabulary mirror and the exact-match mapper | **shipped**, #211 (schema, applied) + #212 |
> | **B35** — the price base and the read path | **not started.** Everything below §4 is its specification |
> | CATMAT-level identity (§11.5) | **measured and rejected** 2026-10-03 |
>
> Sci's decisions: **move to the catalogue source**; **exact match rule**; **keep
> the price band as a feature**; **drop only what is no longer worth anything**;
> the opening date **moves off 08/10** (17/10 proposed, not yet settled — the
> queued broadcast for the old date was cancelled on 2026-10-03, job 103288).
>
> **Two figures here are a floor, not an estimate.** The exact-match share
> (16.8–17.1%) and the coverage it implies (1.50%) were measured **before** the
> cap fix in #212, when a catalogue name folding to five or more head words could
> never match exactly — which made 41.1% of active CATSER unreachable. They want
> re-measuring with the shipped matcher.
>
> ---
>
> **2026-10-03, later the same day: the write half shipped and ran, and four of
> this document's numbers are now superseded by live measurement.**
>
> | this document said | the live measurement |
> |---|---|
> | exact share was a **floor**, likely to rise after the cap fix | **it did not move**: 17.1% over all 477 746 open items, against the 16.8–17.1% measured before. Materials 18.5–19.5%, services 6.5–7.6% — services came out *lower*. The cap fix was right in principle and bought nothing measurable. **1.50% coverage is the number, not a floor.** |
> | **7 109** distinct codes to cache | **5 596** referenced by open items (5 049 material + 657 CATSER, of which the services are deliberately never asked). A full pass is ~22% cheaper than §5 budgets. |
> | a full pass ≈ **6.5 h** at 0.55 calls/s | **20.8 s per code measured** on the deepest codes → 29.2 h if every code were that deep. The median code is one page, so the honest range is **8–12 h [I]**, and §5's figure was optimistic. |
> | the band would appear on some share of items | **roughly 1 edital in 23**. Measured: **26.6%** of open editais have ≥1 band-*eligible* item; applying the per-code band rate gives **4.3%** at the demand-ordered 4%, or 7.3% at the random-sample 8.8%. |
>
> **And one finding this document did not anticipate.** The refresh is
> demand-ordered, and the first 28 codes ever refreshed produced **1 band and 27
> `spread_too_wide` refusals**, holding **29 to 3 572 purchases** each. The one
> that worked: code 30247, R$ 16,49 / 19,36 / 22,62 from 2 154 compras.
>
> A code is demanded *because* it is generic, and generic is what `MAX_SPREAD`
> refuses — so **demand-ordering spends the API budget at the worst end of the
> curve**: 4% band rate on the top codes against 8.8% on a random sample (wide
> CIs, 1/25 against 16/181, so the mechanism is clearer than the magnitude).
> Ordering by demand maximises items-covered-per-code and minimises
> bands-found-per-code, and those are not the same objective.
>
> **So the binding constraint was never supply, cost, or matching.** It is that a
> PDM mixes products, so prices inside one code disagree. §11.5 already rejected
> finer identity on measured grounds (CATMAT: 33% hit, p<0.001 below the
> benchmark). What is left is the threshold itself, and **C4 is now measuring it**
> — `MAX_SPREAD = 0.5` was chosen before any hit rate existed, which
> `price-band.ts` says in its own docstring, and it is refusing codes with
> thousands of purchases.
>
> ---
>
> Every number is labelled **[M]** measured, with its date, or **[I]** inferred,
> with its assumption. `CLAUDE.md` §4d is why: a previous session reported a
> remembered Neon limit as if measured.

---

## 1. Why, in four numbers

Back-test, 1 350 items from closed tenders where the winning price is known,
every band computed by the **real `priceBand()` imported from `origin/main`
9039d042** — not a reimplementation — with the gate constants read back from
that module and asserted (`MIN_SAMPLE=5`, `MAX_SPREAD=0.5`,
`MAX_AGE_MONTHS=18`). Each source asked only what it could have known **strictly
before** the award date, asserted per row. **[M] 2026-10-02.**

| | ours (`awards` + trigram + product gate) | catalogue (code only) |
|---|---|---|
| hit rate | 14% unbiased / 31% conditioned | **56%** |
| vs the 50% a correct quartile band scores | **below it, p=0.001 and p=0.002** | indistinguishable, p=0.45–1.00 |
| median signed bias | **−10% to −30%** | **+0.2%** |
| band width (median) | 27% | 34% |

A quartile band publishes p25–p75 of its own evidence, so it holds the middle
half **by construction**: if the winning price were another draw from the same
distribution, ~50% is what a correct band scores. That is the benchmark, not a
target. Ours is significantly below it in two independent designs; the catalogue
is statistically indistinguishable from it. Our bands are *narrower* — more
confident and more wrong.

**The control matters too:** the órgão's own `unit_estimated_value` is free and
always present and runs **+20.9%** high [M], so it is not a substitute.

---

## 2. What we drop, and the one thing that must survive

Sci: *"drop or remove what is not worthy anymore."* Precisely:

| drop | why |
|---|---|
| `comparables.ts` **on the band path** | the trigram query, **949 ms median per item re-measured today** [M] (`PRICE_BAND.md` §6's 412 ms did not reproduce — Neon degraded; cite both with their condition) |
| `product-key.ts` **on the band path** | `sameProduct` adds nothing to catalogue rows: `B_raw` matched `B_gated`'s 56% hit with *higher* coverage [M] |
| `awards` as the band's source | measured miscalibrated, above |
| B32 / B33 / B34 as **price** cards | they are feed-and-hygiene cards for a corpus that no longer computes the headline number |

| keep | why |
|---|---|
| **`price-band.ts` entire** — `priceBand`, the three constants, the per-purchase collapse, `priceEvidence`, `LockedEvidence`, `withoutPrices` | **the measured 56% was produced by this exact code.** It is the only validated component we own. Rebuilding it would discard the proof. |
| E22's ladder shape (0 / 1 / 2–4 / ≥5) and the entitlement line | still right; only the rows feeding each rung change |
| the `awards` table and its sync | costs nothing to keep, and it is the only source that can cite a **PNCP edital** (what D37 wants); catalogue rows cite a *compra* |

**Nothing is deleted in the same PR that adds the new path.** The old path is
disconnected first, kept dead for one release, then removed — so a rollback is a
revert, not an archaeology exercise.

---

## 3. The matching rule — exact for the band, prefix for evidence only

The cost agent resolved **all 450 445 open items** [M 2026-10-02], not a sample.
This corrects a figure taken from the back-test's award-stratified sample (71%):

| rule | share of open items [M] | band rate [M, back-test] | projected bands [I] | hit [M] | bias [M] |
|---|---|---|---|---|---|
| **exact** | **17.1%** (77 166) | 11.8% | 9 144 = **2.03%** | **56%** | **−3.6%** |
| prefix | 36.7% (165 150) | 5.2% | 8 550 = 1.90% | 42% | **+18.6%** |
| prefix_rev | 2.2% (9 879) | 5.9% | 581 = 0.13% | 100% (n=2) | −13.2% |
| no code at all | **44.0%** (198 226) | — | — | — | — |

By kind [M]: materials resolve **61.8%** (exact 18.7%); services **22.4%**
(exact 8.1%).

**The rule:**

- **Exact code match → the computed band.** Strong identity, unbiased.
- **Prefix match → thin rungs only, never a band.** The individual purchases and
  their descriptions are real evidence a reader can judge; it is the *statistic*
  drawn over a weak identity that comes out **+18.6%** high. This is the
  principle E22 already embodies — a strong identity earns a number, a weak one
  shows its sources.
- **No code → nothing.** No placeholder, no "em breve"; `priceBand`'s docstring
  already rules that a locked bar implying a withheld number is false.

Reach, honestly stated: **2.03% of open items** get a band, against **0.67%**
today [M, `PRICE_BAND.md` §4]. **3× the reach, and calibrated.** The win is
correctness first, coverage second. Coverage remains the binding constraint and
no part of this plan pretends otherwise.

### 3.1 The trap that must be in code, not in a comment

`tender_items.raw.catalogoCodigoItem` looks like a free join and is not:
populated on **68 of 8 861** cached PNCP items (0.77%), and only **2 (0.02%)**
carry `catalogo.id = 1` ("Catálogo do Compras.gov.br") [M, source plan §2]. The
other 66 are `catalogo.id = 2` ("Outros") — agency-local numbers; one is an air
conditioner numbered `92143` whose real CATMAT `458192` sits in the free text.
**Any read of that field gates on `catalogo.id = 1`**, with a test, or it
produces wrong joins that look right.

---

## 4. Storage — 9.65 GB was never required

Sci asked whether all of it must be stored. It must not. The lever is the
**shape of the row**, not the number of codes — restricting to the popular 20%
of codes removes only 25% of the rows [M], because the popular codes are the
heavy ones.

| option | size | $/month at $0.35/GB-mo | vs the whole current DB (1.894 GB) [M] |
|---|---|---|---|
| raw payload, all 41 fields | **9.65 GB** [M] | $3.38 | 5.1× |
| raw, 22 price-relevant fields | 5.20 GB [M] | $1.82 | 2.8× |
| **minimal tuple (recommended)** | **0.24 GB** [I] | **$0.09** | **0.13×** |
| band summary alone | 4.44 MB [M] | $0.002 | 0.002× |

**The minimal tuple**: `kind`, `code`, `id_compra`, `item_number`,
`preco_unitario`, `data_compra`, `unidade`, `codigo_item_catalogo`. ~68 B/row
[I: ~40 B data + 23 B tuple header + alignment], one btree on
`(kind, code, data_compra)`. Two measured reductions compound:

- **Collapse to one price per `id_compra` at ingest: −47%** [M: median 1.87 rows
  per `idCompra`, mean 2.98, worst 47.8 — a registro de preços with 48 lots].
  `priceBand` requires this collapse anyway (`PRICE_BAND.md` §3, property 1).
- **Drop the 33 fields we never read**, which is where the 29× comes from.

Plus descriptions for only the **newest ~10 rows per code** (18 MB [I]) — enough
for the thin rungs, which print at most four.

**Two reasons not to go all the way down to the band summary**, which is why
0.24 GB rather than 4 MB:

1. **Incremental refresh.** With rows stored, a refresh asks
   `dataCompraInicio = last fetch` instead of re-walking 18 months. This is what
   turns a 19.6-hour pass into minutes.
2. **The gates can be re-tuned offline.** `MIN_SAMPLE`, `MAX_SPREAD` and
   `MAX_AGE_MONTHS` are the part of this system we are least sure of, and C4 was
   always meant to re-tune them. With rows, that is a query; without, it is a
   19.6-hour re-fetch.

### 4.1 A privacy blocker on raw rows, independent of cost

Every price row carries `niFornecedor` **and** `nomeFornecedor`, and
`niFornecedor` is a CNPJ **or a CPF** for an individual supplier [M]. Storing
3.9 M raw rows means storing ~3.9 M supplier identifiers, against `CLAUDE.md`'s
*"never log CPF, emails or tokens"* and spec §12. **The minimal tuple carries no
supplier field at all** — not as an optimisation, as the rule. If a supplier
name is ever wanted on screen, that is a separate decision with its own review.

---

## 5. The refresh — per code, weekly, chunked, demand-ordered

| | [M] 2026-10-02 |
|---|---|
| distinct codes covering the whole open corpus | **7 109** (6 198 PDM + 911 CATSER); 41% of active PDM, 30% of active CATSER |
| saturation | 0.3 new codes per 100 items at the last decade of the curve; ceiling 18 062 — **plan 7 000–9 000** |
| a full refresh | 12 974 calls, 3 904 985 rows, 6.85 GB on the wire, **19.6 h sequential** |
| the binding constraint | **latency, not the throttle** — 82–93% of wall clock is the server thinking (mean 3.89 s/page, p90 7.82, max 32.06) |
| daily full refresh | 588 h/month — **not viable** |
| weekly full refresh | 84 h/month — **viable** |
| API under sustained sequential load | 213 calls, **zero 429** at 0.4 s / 1 concurrent |
| concurrency | **unknown and not to be tried** — 429'd at 6 workers and at 3 today |
| page size | **500**, no deep-page penalty; latency is server-side, so fewer calls is the only lever |

**There is no bulk endpoint.** `1_consultarMaterial` / `3_consultarServico`
require `tipo`+`codigo`; a date-window-only request returns **404** [M]. The cost
is intrinsically per code.

**Cadence by depth, not uniform.** A week adds ~1.3% of new rows to a deep code
[I], and a quartile moves as O(1/n), so daily buys nothing measurable there:

- **thin codes (5–20 purchases)** — weekly. One purchase can flip them across
  `MIN_SAMPLE` or `MAX_SPREAD`, and they cost one page each.
- **deep codes (>200 purchases)** — monthly.
- **codes no open item references** — never.

**First load is demand-ordered, not a 19.6-hour block.** Enqueue codes in
descending order of how many open items point at them: the top 20% of codes
carry **83.6%** of resolved items [M], so most of the value lands in the first
couple of hours. Chunk into many small jobs at `AWARDS_PRIORITY = 9`-style
priority with a `jobs_dedupe` key per `(code, window)` — a single long job on a
**concurrency-1** worker [M, `config.py:98`] would starve `sync_open_tenders`.
`sync_awards.py` already has exactly this shape; copy it.

### 5.1 Operational rules, each one already paid for in this repo

- **Its own breaker name** (`compras-pesquisa-preco`). Breakers are per endpoint;
  `pncp-resultados` was open all morning on 2026-09-30 while search was healthy.
- **Raise on an empty walk; never record a zero.** And note ~6% of uniformly
  sampled needed codes genuinely have no rows in 18 months [M, verified by
  re-asking over 5 years], so "no rows" must be distinguishable from "not asked"
  in the stored row.
- **Assert the page walk completed** (last page shorter than 500) before writing
  a band, and read every page. The rule stands on principle — a band drawn from
  a partial read is not the band of that code. **But the predicted direction was
  wrong and the measurement says so** [M 2026-10-02]: codes read completely
  banded at **11.5%** while truncated ones banded at **3.2%**, because
  truncation correlates with a coarse, heterogeneous PDM rather than with a
  falsely tight IQR. So the risk of capping pages is **lost coverage**, not a
  wrong band.
- **A 400 can be transient here**: PDM 4915 returned 400 once and 200 on three
  retries [M]. Retry it; do not treat it as a rejection.
- **Alarm on "0 codes refreshed in N days", never on "0 queued"** — B32's lesson:
  a feed that never enqueues never fails, which is why it was invisible for two
  days.
- **Clocks.** `dataCompra` is a calendar date; the job's hour is BRT
  (`scheduler.py`'s `daily_at`); the row it writes is UTC. Say which clock each
  window boundary is in.

---

## 6. Data model and migration order — three PRs, each its own

Schema changes go via `db/migrations`, in their own PR (`CLAUDE.md`).

1. **`0013_catalog_vocabulary.sql`** — the mirrored closed vocabularies: active
   PDMs (15 039) and CATSER items (3 023) with code, name, class, status. ~3 MB
   [I]. Lets the mapper run with no network and makes `test_catalog_match.py`
   possible without I/O.
2. **`0014_tender_item_codes.sql`** — one row per item: `tender_id`,
   `number`, `kind`, `code`, `rule` (`exact` | `prefix` | `prefix_rev` |
   `no_match`), `matched_words`, `mapped_at`. 450 445 rows × ~60 B ≈ **27 MB**
   [I]. **`rule` is stored, not derived** — the exact/prefix boundary is what
   decides whether a band may be computed, so it must be inspectable in SQL.
3. **`0015_catalog_prices.sql`** — the minimal tuple (§4) plus
   `catalog_bands`: `(kind, code, window_end)` → `low`, `median`, `high`,
   `n_purchases`, `computed_at`, `refused_reason`. **`refused_reason` is a
   column, not an absence**, so "spread too wide" is a counted number rather than
   something discovered on a screen.

Then, in order, each reviewed before merge:

4. **The mapper** (worker): description → code via the real `productHead`,
   exact-before-prefix, description-disambiguated when a head maps to several
   codes. One offline pass ≈ **4 minutes for all 450 445 items** [M — the cost
   agent did exactly this run]. Incremental on write in `sync_items`.
5. **The refresh job** (worker): §5.
6. **The band read** (web): `comparablesForItem` leaves the band path; the screen
   joins `tender_item_codes` → `catalog_bands` on the primary key. No
   `similarity()`, no per-item round trip.
7. **The rungs** (web): §7.
8. **The copy** (Sci) + `CLAIMS.md` rows, §9.
9. **Delete the dead band path**, one release later.

---

## 7. How each E22 rung is re-fed

The ladder's shape and the entitlement line do not change. What changes is where
the rows come from and what the count counts.

| rung | today | after |
|---|---|---|
| 0 purchases | *"ainda sem dados"* | unchanged |
| 1 | free: the price + the matched description | the same, from a catalogue purchase |
| 2–4 | free: count + every result | the same |
| ≥5, tight | Essencial: band + preço-alvo + margin calculator | **exact matches only** |
| ≥5, tight, unentitled | `LockedEvidence` — count + descriptions, **no prices** | unchanged; the type still has no price field |
| ≥5, scattered | count + results, no explanation | unchanged (the silence `CLAIMS.md` already tracks) |
| **prefix match, any depth** | — | **thin rungs only, never the band** (§3) |

`MIN_SAMPLE` now counts **distinct `id_compra`**, not distinct editais — which is
the same discipline for the same reason, and is a copy change (§9).

**Services render nothing.** 22.4% resolve and 0 bands were measured from any
source [M, 136 service items]. Record the refusal reason on the mapper row so the
silence is counted, and **spend no refresh budget on the 911 CATSER codes** until
a service-specific probe says which gate fires — today nobody knows, and that is
an open question, not a fact about services.

---

## 8. Tests — what each layer pins, and what the suite cannot see

`vitest.config.mts` has **no jsdom**; component tests are `renderToStaticMarkup`
string assertions, so effects and layout are invisible **by construction**
(`CLAUDE.md` §4c). Say in the PR which test pins the mechanism and which pins the
result.

| layer | test | pins |
|---|---|---|
| mapper | `worker/tests/test_catalog_match.py` — **no network, no database** | fold, head, **exact before prefix**, the description disambiguation, the `"Outros"` / `catalogo.id = 1` trap, and that a prefix match is **never** marked band-eligible |
| band maths | the existing `price-band.ts` tests, unchanged | that we did not touch the validated part |
| ingest | worker test on fixtures | the `id_compra` collapse, the **completed-walk assertion**, `refused_reason` written rather than a row missing, no supplier field persisted |
| refresh | worker test | enqueues when a code is stale and **nothing** when it is not; breaker open neither widens it nor loses the backlog |
| read path | web test | exact → band; **prefix → no band but rungs**; no code → nothing rendered; `LockedEvidence` carries no price |
| the path, not the unit | `apps/web/e2e/` Playwright | that a reader can actually reach a band and a thin rung — §4b: *"the test exercised the unit, not the path"* is how ten defects shipped green on 2026-09-24 |

A green suite is not evidence a path works. Before merging anything beyond a
one-line fix, something that did not write the diff reads it, told that tests
passing is not evidence (§4b, and `memory: review-before-opening-the-pr` — Sci
merges within minutes, so the review happens **before** the PR opens).

---

## 9. Copy — six strings and a label, all Sci's

**I do not write these** (legal brief §5). Each currently asserts *editais* /
*vencedores* / *editais encerrados*; catalogue rows are **compras**, including
registros de preço, across all spheres and powers. A new claim that is not yet
true gets its `CLAIMS.md` row **in the same PR**.

| string | the word that breaks |
|---|---|
| `plans.essential.feature3` | "nos editais em que já temos esses dados" |
| `radar.landing.opportunity.body` | "nos editais… dados de vencedores" **and "cada item"** — still false at 2.03% |
| `plans.locked.priceBand` | "quem venceu licitações parecidas" |
| `radar.price.intro` | "o preço que venceu em editais parecidos" |
| `radar.price.evidenceHelp` | "{$minEditais} **editais encerrados** com o mesmo produto" |
| `radar.price.noDataHelp` | "quando editais parecidos… tiverem sido encerrados e publicado o vencedor" — wrong mechanism entirely |
| the count label | `sampleSize` renders *"N editais encerrados"* → *N compras* |

Two notes for whoever authors them:

- **One thing gets easier to say honestly.** "parecidas" was a trigram guess; an
  exact catalogue code is a far stronger claim of identity.
- **Say nothing geographic.** Rows carry `estado`, and the band is nationwide
  unless filtered; filtering would cut depth by an unmeasured amount. *"na sua
  região"* was removed from two live places on 2026-09-28 because it was not a
  missing caveat but a filter that does not exist. Same trap, new source.

`CLAIMS.md` **row 85** is due **08/10**, a date that is now moving — it needs
re-dating when Sci sets the new one, along with the three claims it lists as
still standing.

---

## 10. Cards

**B34 is taken** (the 47 future-dated awards, on `task/e22-price-evidence-ladder`),
so the source plan's proposed B34/B35 become:

- **B35 — the catalogue price base.** The vocabulary mirror, the minimal-tuple
  ingest, `catalog_bands`, the weekly demand-ordered refresh with its own
  breaker. Carries the measured numbers of §1, §4 and §5, spec §3, and the
  no-supplier-field rule.
- **B36 — the item → code mapper.** Exact-before-prefix, stored with its rule,
  `catalogo.id = 1` gated, tests with no I/O. Carries §3.1.

Amendments, not rewrites:

- **C3** — parked, and now largely answered: a closed vocabulary of 15 039 PDMs
  replaces inventing a key. Its measurements stay as the evidence for why free
  text fails. Note the saving: the mapper is **~4 minutes of CPU and $0 of AI**
  [M] against C3's route of ~R$ 42 and 35 days of throughput.
- **C4** — becomes cheaper and more important: with rows stored, re-tuning the
  gates is a query. It remains the gate on any confidence figure reaching a
  screen.
- **D33** — loses two dependencies. "Does this item have a band" becomes the
  existence of a `catalog_bands` row the mapper and refresh already wrote, so it
  no longer waits on C3 or B21.
- **B21** — **keep it, re-scope it, do not close it.** The index is no longer
  needed for the band; it becomes load-bearing for the **batch** path, because
  precomputing the thin rungs from `awards` is 450 445 × 949 ms ≈ **119 hours**
  [I] without one.
- **B32 / B33 / B34** — reclassified from price cards to feed/hygiene cards.
- **D25 (2)** — affordable on cost (a PK read instead of 56.9 s [M]), but its
  real blocker was never latency: the back-test sampled **items**, so *"what
  share of editais have at least one band"* is **unmeasured**. Codes per open
  edital are median 1, p90 14 [M], which bounds the work but not the answer.
  **That measurement is what un-parks it.**

---

## 11. What must be true, in order of how much it would hurt

1. ~~**The 11.8% band rate for exact matches survives on open items.**~~
   **RESOLVED 2026-10-02 — it holds, and the coverage figure is now measured
   rather than projected.** 1 200 random open items, 201 exact matches, 181
   distinct codes fetched, 427 sequential API calls, zero 429:

   | | |
   |---|---|
   | band rate, exact matches, **open** items | **18/201 = 9.0%** [CI 5.7–13.7] |
   | band rate, exact matches, closed awarded (back-test) | 66/557 = 11.8% [CI 9.4–14.8] |
   | difference | **Fisher p = 0.296 — holds** |
   | **coverage of all open items** | **16.8% × 9.0% = 1.50%** [CI 0.96–2.30] |
   | ours today, open items | 0.67% |
   | **so** | **2.2× the reach, and calibrated** |

   The rule mix reproduced independently on this fresh sample: exact **16.8%**
   (cost agent: 17.1%), prefix 35.8% (36.7%), no match 44.9% (44.0%).

   **And read every page.** Items whose code was read completely banded at
   **11.5%**; items whose code hit this probe's 4-page cap banded at **3.2%**.
   The cap was the probe's, not the design's, so a full-depth ingest plausibly
   lands nearer 16.8% × 11.5% ≈ **1.93%** [I]. The extra pages are worth paying
   for.
2. **~7 109 codes is the real cache size.** Measured on today's corpus; the
   curve is saturating, so a doubling reaches ~8 500 [I] and cannot exceed
   18 062. If it grows unexpectedly, first-load hours and storage scale with it.
3. **The API tolerates a chunked weekly walk.** Zero 429 over 213 sequential
   calls at 0.4 s [M]; a 12 974-call walk is 60× longer and **not yet observed**.
   Build the breaker and the throttle first, then measure the first real pass.
4. **`MAX_SPREAD` keeps refusing coarse PDMs.** Correct behaviour — but it must
   be **counted per code via `refused_reason`**, not discovered.

   **This is now the dominant fact about the whole design** [M 2026-10-02, the
   open-item probe]: of 183 exact-matched items that got no band, **182 (99%)
   were refused for spread and exactly 1 for too few purchases.** Every
   exact-matched code had ≥5 purchases — median **379**, max 1 649. So
   `MIN_SAMPLE` is not a binding gate on this source at all. **The data is
   abundant; the identity is too coarse.** The product's ceiling is no longer
   supply, matching rate, or cost — it is one thing: a PDM mixes products.
5. **Granularity upside, if we want it later:** across 40 spread-refused PDMs,
   re-grouping the *same rows* by exact `codigoItemCatalogo` let a median **22%**
   of codes (those with ≥5 purchases) pass the gate the PDM failed, and 31 of 40
   had at least one passing code [M]. Because `tipo=codigoPdm` already returns
   `codigoItemCatalogo` on every row, this is **local arithmetic at zero extra
   API cost** — but only if the minimal tuple keeps that column, which §4 does.
   Two anecdotes suggested 53–56%; the 40-PDM statistic says 22%, and the
   statistic is the one to plan on.

   **DECIDED 2026-10-03 — do not build CATMAT-level. Measured, and it fails.**
   500 exact-matched closed awarded items, both arms scored on the *same* items
   with the same real `priceBand()` and the same no-look-ahead bound:

   | arm | bands | coverage | hit rate | vs the 50% benchmark | bias |
   |---|---|---|---|---|---|
   | **PDM-level** | 38 | 7.6% | **47%** [32, 63] | **p=0.871 — indistinguishable from correct** | +3.5% |
   | CATMAT-level | 101 | **20.2%** | **33%** [24, 42] | **p<0.001 — significantly below** | −5.8% |

   CATMAT buys **2.7× the coverage and breaks the calibration that is the whole
   reason for changing source.** The mechanism is the one named before the probe
   ran: at CATMAT level the spread is tight *by construction*, so `MAX_SPREAD`
   stops protecting anything and the only protection left is whether the item
   was pointed at the right code — which is unmeasured and, measured here,
   wrong often enough to matter. Better disambiguation does not rescue it:
   splitting the CATMAT bands by how well the chosen code's description covered
   the item's words gives 38% hit above 50% cover and 30% below.

   The threshold was **pre-registered before the probe ran** (≥50% build it,
   <45% do not) precisely so that 2.7× coverage could not be rationalised after
   the fact. It came in at 33%.

   So the remaining lever is **not** finer identity. `MAX_SPREAD` refusing a
   coarse PDM is the gate working, and the 22%-of-codes recovery measured
   earlier is real but buys bands that are wrong half the time. What is left is
   supply and matching *at PDM level*, and the honest statement is that the
   feature ships at ~1.5–2% of items or not at all.

## 12. Open questions for Sci

1. **The new opening date.** 17/10 proposed 2026-10-03 and not yet settled —
   note it is a **Saturday**, while the live copy says *"08/10 às 19h"*, a
   Thursday evening. It lands in `CLAIMS.md` row 85's due date,
   `docs/product.json`'s `opensOn`, and **two hardcoded date strings** in
   `pt-BR.json` (the founders badge and the `when` field) which do **not** read
   `opensOn` — so changing `product.json` alone leaves both wrong. Those two are
   sentences, so they are Sci's. ~~Queued job 103288~~ **cancelled 2026-10-03**,
   with an audit row in `events` (`founders_opening_broadcast_cancelled`); the
   dedupe is a unique index on the key, so re-queueing for a new date via
   `worker/scripts/schedule_founders_opening.py` is unaffected.
2. **Neon's CU-hour / compute price** — not in any repo file; the only figure that
   could make this materially expensive. Dashboard only.
3. **Egress cost** of 6.85 GB per full refresh — depends where the worker runs
   (Easypanel [M, spec §13]); invoice only.
4. **Whether `awards` keeps feeding the thin rungs** alongside the catalogue, for
   the PNCP edital citation D37 wants. Catalogue rows cite a *compra* instead.
5. **The six sentences** and the count label, §9.
