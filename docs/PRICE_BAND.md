# The price band — what it is, what it costs, and what it does not do

**Written 2026-10-02.** Every number here was measured, on the dates given,
against the Neon `main` database and the real code path. Nothing is inferred
from the schema or remembered from a previous session. Where a figure is a
projection it says so.

This file exists to be read **by someone with no context** — in particular,
someone evaluating whether a different data source or API should replace any
part of this. §8 is written for exactly that.

---

## 0. Status, 2026-10-03 — the source is changing underneath this document

**Everything below describes what *renders* today, and it is still accurate for
that.** The band on screen is still built from `awards` by `comparablesForItem`,
because the read path has not changed. What has changed is the decision about
where the numbers will come from.

A back-test over 1 350 items from closed tenders where the winning price is
known, every band computed by the real `priceBand()`, each source asked only
what it could have known strictly before the award date:

| | this document's source (`awards`) | the Compras.gov.br catalogue |
|---|---|---|
| hit rate | 14% / 31% | **56%** |
| against the ~50% a correct quartile band scores *by construction* | **below it: p=0.001, p=0.002** | indistinguishable, p=0.45–1.00 |
| median signed bias | **−10% to −30%** | **+0.2%** |
| band width | 27% (narrower — more confident, more wrong) | 34% |

So §3's gates and §4's coverage figures remain true of the shipped path, and
§7's supply argument is now historical: the feed this document calls "the real
constraint" is being replaced rather than fixed.

**What is built already** (B36, B35's write half): the vocabulary is mirrored,
**477 746 open items are mapped** (17.1% to an exact code), and 41 362 catalogue
price rows are stored. **What is not built is the read path** — so none of it
reaches a screen yet, and this document's §5 is still what a reader sees.

**The measured reach of the new source, which is the number that matters:**
roughly **1 edital in 23** will show a band (4.3%, inferred from a 4% per-code
band rate on demand-ordered codes), against 7.3% if the random-sample rate of
8.8% holds. Either way it is rare, and *"cada item"* in
`radar.landing.opportunity.body` is further from true than this document's §4
already said.

The decision, its evidence and the open questions live in
`docs/catalogue-price-band-approach.md`. **C4 is measuring whether `MAX_SPREAD`
is the right threshold**, because 27 of the first 28 codes ever refreshed were
refused by it while holding 29 to 3 572 purchases each.

---

## 1. What the product promises

Two sentences, both live on `/`:

- `plans.essential.feature3` — *"Faixa em que os vencedores fecharam, nos
  editais em que já temos esses dados, e o preço-alvo de compra: o máximo a
  pagar ao fornecedor para manter a sua margem"*
- `timeline.steps[3].body` — the same capability, promised for **08/10**.

The product proposition behind them, in Sci's words (2026-09-30): a newcomer to
public tenders reads a **past** tender's winning prices as the baseline for a
**new** one. The band is that baseline. The preço-alvo is the decision it feeds:
the most you may pay your supplier and still keep your margin.

`docs/CLAIMS.md` row 85 tracks these two sentences and is the register of what
is promised versus what renders. **Read it before changing any of this.**

---

## 2. The pipeline, end to end

```
PNCP /api/consulta (worker)                     ← the only source of prices
  └─ sync_tender_awards job                     worker/licitaqui/sync_awards.py
       └─ awards table                          (tender_id, item_number, sequence)
            └─ comparablesForItem()             apps/web/lib/radar/comparables.ts
                 ├─ SQL: segment + canonical unit + trigram similarity
                 └─ TS:  sameProduct() gate     apps/web/lib/radar/product-key.ts
                      └─ priceBand()            apps/web/lib/radar/price-band.ts
                           ├─ the band (quartiles)        → Essencial
                           ├─ targetPurchasePrice()       → Essencial
                           └─ priceEvidence()  (E22)      → free at thin rungs
```

**No web request ever reads PNCP** (spec §3). Prices arrive only through the
worker. Note that PNCP refuses some origins outright — see CLAUDE.md — so any
new measurement that needs PNCP runs on the worker, not on a laptop.

### 2.1 `awards` — the corpus

`db/migrations/0001_initial.sql`, primary key `(tender_id, item_number,
sequence)`. One item routinely carries several rows: lot splits, the ME/EPP
quota, a re-homologation.

| column | note |
|---|---|
| `unit_awarded_value` | `numeric(16,4)`, the price a winner closed at |
| `awarded_on` | `date`, used for the recency bound |
| `quality` | `OK` \| `confidential` \| `out_of_range` \| `cancelled` |
| `supplier_doc` | CNPJ; **CPF is masked on write** (spec §12) |

**Only `quality = 'OK'` may enter a band.** That is `worker/licitaqui/awards.py`'s
rule. Measured 2026-09-28, before the backfill: 745 of 6 094 rows (12.2%) were
not OK — 655 `out_of_range` (the order-of-magnitude errors a median must not
see), 60 confidential, 30 cancelled. The web query ignored `quality` for a
while and including those rows moved bands in both directions, silently.

### 2.2 Corpus size — measured 2026-10-02

| | |
|---|---|
| `awards` rows | **27 161** |
| of which `quality = 'OK'` | **24 381** |
| distinct tenders with awards | **2 991** |
| OK rows with `unit_awarded_value > 0` | **24 381** across **2 893** tenders |
| OK priced rows inside the 18-month window | **23 488** |
| open tenders / open items | **21 619** / **448 807** |

For the trajectory: on 2026-09-28 the corpus was 6 094 rows. On 2026-10-01,
before that day's backfill, it was 5 408 usable priced items across 970
editais; after it, 23 448 across 2 805. The backfill was **4.3×**, and it was
run by hand.

---

## 3. The gates, and why each number is what it is

All five are exported constants, so a test can read them rather than copy them.

| constant | value | file | why |
|---|---|---|---|
| `SIMILARITY_FLOOR` | **0.3** | `comparables.ts:73` | pg_trgm floor on description similarity |
| `MAX_COMPARABLES` | **200** | `comparables.ts:84` | cap on rows returned per item |
| `MIN_SAMPLE` | **5** | `price-band.ts:79` | distinct **editais**, not rows. At three, one outlier moves the median by a third |
| `MAX_SPREAD` | **0.5** | `price-band.ts:89` | inter-quartile spread as a fraction of the median — the middle half within ±25% |
| `MAX_AGE_MONTHS` | **18** | `price-band.ts:100` | public prices move with the IPCA and the contract cycle |
| `MAX_SAMPLES_SHOWN` | **4** | `price-band.ts:215` | E22: how many past results a thin rung prints |

Three properties of these worth knowing before touching them:

1. **`MIN_SAMPLE` counts editais and the quartiles are taken over per-edital
   medians.** Counting editais for the floor while taking quartiles over *rows*
   was the first version, and it was worse than the bug it replaced: row
   duplication **compresses** the inter-quartile range, so the more one edital
   dominated, the more likely the spread check was to pass. A registro de preços
   split into 40 lots at R$ 1,20 beside four editais at R$ 2,40–2,60 cleared the
   floor with a spread of zero and showed *"R$ 1,20 · 5 editais"* while four of
   the five paid double.
2. **There is no UF, município or region predicate anywhere.** The join is
   nationwide. *"na sua região"* was removed from two live places on 2026-09-28
   for this reason — it was not a missing caveat, it was a filter that does not
   exist.
3. **Nothing here claims a confidence percentage, and nothing may.** There is no
   model and no back-test. **C4** is the card that measures a real hit rate —
   predict from awards that existed before a closed tender's award date, compare
   to what actually won — and only then may a number reach a screen.

### 3.1 The product-identity gate — the most important correction so far

`apps/web/lib/radar/product-key.ts`, added 2026-09-30.

Sci found two items on `96291141000180-1-006394/2026` whose band was built from
the wrong product. Item 37, a cast-iron desk punch the edital valued at
R$ 168,78, was priced from **nine cadernos and a roll of toilet paper** — the
one real punch among its eleven comparables, at R$ 204,00, had the *lowest*
similarity of the set and was outvoted. The screen advised paying at most
**R$ 9,35**. Item 13, a *compatível* Lexmark toner estimated at R$ 129,85, was
priced from *original* cartridges at roughly double.

**The spread gate cannot catch this and no threshold on it could**: cadernos all
cost R$ 9–15, so a sample made entirely of them is *tighter* than a correct one.

Measured over 103 open items in `Gráfico / Escritório` and `Informática / TI`
that returned any comparables: the **median share that were even the same
product was 0%**, and 65 of 103 were under half.

So `sameProduct()` compares product name to product name: `productHead()` takes
the words before the first `atributo:`, strips attribute-key vocabulary, dedupes
and caps at `HEAD_WORDS = 4` (candidate side `CANDIDATE_WORDS = 12`), and
`productGrade()` separates *compatível* from *original*, returning `null` on
ambiguity rather than guessing.

**What it cost in coverage**, measured through the real path: over 400 open items
across every segment, items keeping any comparable fell **62 → 14**, while items
showing a band went **0 → 0**.

---

## 4. Coverage — the number that decides whether any of this is worth building

**Measured 2026-10-01, 600 open items, after the backfill and with the product
gate in place:**

| | share of open items |
|---|---|
| ≥1 past winner of the same product | **11.17%** |
| ≥2 | 4.83% |
| ≥3 | 3.33% |
| ≥5 (the floor) | 0.83% |
| **a band (≥5 and a tight spread)** | **0.67%** |

So roughly **one in five** of the items that reach the floor is refused by the
spread gate, and that case is reachable on screen (see §5.2).

**Measured 2026-10-02, 3 000 open items, through the real code path:** at least
three items do have a band — `07954480000179-1-025100/2026` items 1, 2 and 3,
with 46, 9 and 8 editais. The 46-edital one is A4 paper, the most commoditised
line in Brazilian procurement.

**Also measured 2026-10-02:** three real 60-item open editais, 180 items total,
had **0 items with a band** between them.

**C3's ceiling, measured 2026-10-01**: with the trigram floor removed and only
the product gate applied, ≥5 editais would reach **2.67%**. So C3's entire upside
on this metric is about **2.7×**, and it cannot make the band common.

---

## 5. What renders today

### 5.1 The price screen (`/radar/edital/<id>/preco`)

**E22's ladder**, shipped on branch `task/e22-price-evidence-ladder`, PR **#209**
(open as of writing). Four rungs:

| editais | what a reader sees | who |
|---|---|---|
| 0 | *"Ainda sem dados de vencedores para este item."* | everyone |
| 1 | *"Encontramos 1 resultado parecido"* + the price + the matched description | **free** |
| 2–4 | the count + every result, each with its price and description | **free** |
| ≥5, tight | the band (quartiles) + the preço-alvo + margin calculator | Essencial |
| ≥5, tight, unentitled | the count + the matched descriptions, **no prices** | free |
| ≥5, scattered | the count + the results, **and no explanation** | free |

Two rulings behind that table:

**Raw evidence free, computation paid** (Sci, 2026-10-01), **narrowed
2026-10-02**: at five editais the four sampled prices *rebuild* the band. The
quartiles of five sorted values are `sorted[1..3]`, so four give two of the
three figures exactly and bracket the third — verified by running it, with the
oldest edital also the cheapest, returning the real low, median and high to the
cent. So above the floor the values are withheld too. It is enforced by
`LockedEvidence`, a type with **no price field**, rather than by a nullable
value somebody must remember to clear.

The cost of that, stated: a real inversion — prices at four editais, none at
five — bounded to the 0.67% of items that reach a band. `docs/TO_VALIDATE.md`
holds the alternative, which is to accept that the band is effectively free
wherever it exists and sell only the preço-alvo.

**Thin rungs print what was matched** because below the floor nothing has checked
product identity: no spread, nothing to outvote a wrong match, and a single
clean number looks *more* authoritative for being one number. The top rung earns
the right to hide its sources because the spread did the judging.

### 5.2 The one silence, deliberately left

`radar.price.evidenceHelp` — *"Mostramos a faixa quando encontramos pelo menos
{$minEditais} editais encerrados com o mesmo produto. Neste item encontramos
N."* — renders **only below `MIN_SAMPLE`**, because above it the sentence is
false: five editais is necessary, not sufficient, and `MAX_SPREAD` must also
pass. Rendered unconditionally it read *"…pelo menos 5 editais… Neste item
encontramos 6"* directly above no faixa.

So at ≥5 scattered the reader gets the count and the results with **no
explanation**. That is a silence, not a false sentence. Filling it needs a
sentence about the prices disagreeing with each other, and **copy is Sci's**
(legal brief §5). It has its own row in `CLAIMS.md`.

### 5.3 The edital screen renders no price at all

`opportunity-screen.tsx` never calls `getBand`, and `page.tsx` reads
`readPriceBandEntitlement()` only inside `PricePane`. **D25 (2)** was the card to
add a preço-alvo block there and is **parked** — §6.

---

## 6. Cost — measured 2026-10-02, and why D25 (2) is parked

The question *"does any item of this edital have a band"* has no cheap answer.

Three real open editais, 60 items each:

| edital | ask every item | one batched query | items with a band |
|---|---|---|---|
| `19558782000107-1-000019/2026` | **51 495 ms** | 626 ms | 0 |
| `63025530000104-1-003778/2026` | **34 382 ms** | 1 005 ms | 0 |
| `46634291000170-1-000985/2026` | **30 210 ms** | 315 ms | 0 |

B21 measured the per-item figure independently: **412 ms median, 2 715 ms
worst**.

The batched query is the SQL half of `comparablesForItem` — segment, canonical
unit, trigram floor — grouped by item, counting distinct award editais. Because
the TS product gate only ever **removes** rows, a count below `MIN_SAMPLE` there
is a **definitive no**; it cleared two of the three editais outright. On the
third it narrowed 60 items to 17 "worth asking about", of which the real path
found **0** — and asking those 17 properly would still cost ~8 s.

So: a block on the most-visited screen in the product, costing seconds, that on
180 measured items would have appeared **zero times**. That is why D25 (2) is
parked, and **its real blocker is C3, not F5** (F5 shipped). **D33** says the
same thing about the same signal: it must be a precomputed per-item flag written
by a job, and it is "worth nothing until C3".

There is **no index** on `tender_items.description` for trigram search —
`gin (description gin_trgm_ops)` does not exist. B21 owns that decision.

---

## 7. The supply side, which is the real constraint

Every band comes from an `awards` row, so the feed is the proposition.

**B32**: nothing enqueues `sync_tender_awards`. Measured 2026-10-01: 0 queued,
0 done in 24 h, last success **2026-09-29 07:27 UTC**. The handler works — a
25-edital probe returned 25 of 25 with zero failures — and `sync_awards.py` has
the follow-up machinery. What no scheduled job does is notice that a tender has
closed with items flagged `has_award` and no `awards` row. The 4.3× growth in
§2.2 was a **manual** backfill; without B32 it stops again.

Measured 2026-10-02: **3 002 done, 917 failed**, last failure 08:17 UTC. Note
that 917 is one more than the 916 measured on 2026-10-01, so the breaker is not
thrashing — it is holding. Every recorded failure is `CircuitOpen: circuit
'pncp-resultados' is open`, and underneath it PNCP's own `HTTP 503`,
`ReadTimeout`, `RemoteProtocolError`.

**Do not fix this by widening the breaker or shortening its reset.** The breaker
is the only thing that stopped 916 failing jobs becoming a hammering. And
**alarm on `0 done in 24 h`, never on `0 queued`** — a feed that never enqueues
also never fails, which is precisely why this was invisible for two days.

**B34** (new, 2026-10-02): 47 of 27 161 `awarded_on` values are in the
**future** — 38 later in 2026 and **9 in 2028** — and 7 are before 2015, with
one at `0001-01-01`. All 47 future rows are `quality = 'OK'` and all 47 fall
inside the 18-month window, so they pass the freshness filter by construction
and, because `priceEvidence` sorts newest-first, a future-dated award is the
**first** past result a reader sees for its item. 0.2% of the corpus, and it
sits at the top of the list.

---

## 8. If you are evaluating a new API

What a replacement or supplement has to beat. Read §4 first: the binding
constraint is **coverage**, not accuracy or latency.

**The questions worth asking, in order:**

1. **Does it raise coverage above 11.17% / 0.67%?** If it does not, it does not
   address the product's problem. C3 — better matching on the data we already
   hold — has a measured ceiling of 2.67% at ≥5 editais, so *matching* is not
   where the remaining upside is. More **priced history** is.
2. **Does it give per-item winning prices for closed tenders, nationwide?** That
   is the shape `comparablesForItem` needs. An API that returns tender-level
   totals cannot feed a band at all, because the band is per unit per item.
3. **Does it solve product identity, or inherit our problem?** §3.1 is the
   hardest part of this system and it is not a PNCP limitation — it is free-text
   descriptions. An API with a product code (CATMAT/CATSER, NCM, GTIN) against
   which items and awards both resolve would replace `product-key.ts` outright,
   and that is worth more than any threshold change. `tender_items.ncm` exists
   and is unused here.
4. **What does it cost per item, and can it be asked about 60 items at once?**
   §6 is the whole reason D25 (2) is parked. A batch endpoint changes which
   screens can carry a price.
5. **Is it a licence we can ship?** The current source is public procurement
   data. Anything else needs the terms checked against `docs/legal/`.

**What must not change without re-deciding deliberately:**

- `quality = 'OK'` filtering (§2.1), the per-edital collapse (§3), and the
  absence of any confidence figure (§3). Each exists because of a specific
  measured defect.
- The entitlement line (§5.1) and the `LockedEvidence` type.
- The copy. Every user-facing sentence is Sci's; `CLAIMS.md` records what each
  one commits to.

**What to measure before believing anything about a new source:** the probe used
for §4 and §6 walked 3 000 open items in ~11 minutes through the real
`comparablesForItem` / `priceBand` / `priceEvidence`, bucketed them by rung, and
wrote URLs. It is **not committed** — it was deliberately kept out of
`pnpm test`, because it reads the production database and takes minutes. Rebuild
it rather than trusting a count from SQL that re-derives the gates: the TS
product gate is not expressible in that SQL, and a measurement that skips it
overstates coverage by roughly 4× (62 → 14 items, §3.1).

And the standing rule, from CLAUDE.md: **an empty result is not an absence.**
`coverage_check` raises on an empty walk instead of recording a zero, because on
2026-09-29/30 every PNCP read from Sci's laptop was refused while the worker was
served 47 times in 24 h. A new API measured from the wrong machine will report
that we hold 0% of everything.

---

## 9. Open cards

| card | what it is | blocked on |
|---|---|---|
| **C3** | better comparables — canonical product key | — (Sci testing a new approach) |
| **C4** | a measured hit rate, before any screen quotes confidence | awards history |
| **B21** | the trigram index and the caching decision | — |
| **B32** | the enqueuer, so the corpus keeps growing | B8 (done) |
| **B34** | 47 future-dated awards sort first on the thin rungs | — |
| **D33** | a precomputed per-item "has a band" flag | C3, B21 |
| **D34** | a 251-item list is not navigable (arrangement half is unblocked) | — / D33 for ordering |
| **D37** | a thin rung's results cannot be looked up | — |
| **D25 (2)** | the preço-alvo block on the edital screen | **parked** — C3 (§6) |

Open for Sci, in `docs/TO_VALIDATE.md`: whether the top rung keeps withholding
prices. Open in `docs/CLAIMS.md`: the sentence for the ≥5-scattered silence, and
row 85, which cannot close while three claims stand.
