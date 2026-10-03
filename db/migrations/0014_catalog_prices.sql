-- The Compras.gov.br price base and the per-code band (card B35).
--
-- ## Why these live in our database at all
--
-- The band's source changes because ours is **measured** miscalibrated: over
-- 1 350 closed-tender items with the winning price known, every band computed
-- by the real `priceBand()`, ours hits 14%/31% at -10% to -30% bias against
-- the ~50% a correct quartile band scores by construction (p=0.001, p=0.002),
-- while the catalogue hits 56% at +0.2% (p=0.45-1.00, indistinguishable from
-- correct). Measured 2026-10-02.
--
-- There is **no bulk endpoint**: `1_consultarMaterial` / `3_consultarServico`
-- require `tipo`+`codigo` and a date-window-only request is a 404, so the cost
-- is intrinsically per code -- 12 974 calls, 3 904 985 rows and 6.85 GB on the
-- wire for one full pass over the 7 109 codes the open corpus references
-- (6 198 PDM + 911 CATSER), ~6.5 h at the only arrival rate measured clean
-- (0.55 calls/s). All measured 2026-10-02. Asking that per request is what
-- spec §3 forbids; asking it per screen is impossible. So the rows are held
-- here and the screen reads a band by primary key.
--
-- ## Storage is the row shape, not the row count
--
-- The lever is the shape of the tuple, not the number of codes: restricting to
-- the popular 20% of codes removes only 25% of the rows [M], because the
-- popular codes are the heavy ones.
--
-- The raw 41-field payload for the 7 109 codes is **9.65 GB** [M] -- 5.1x the
-- whole current database (1.894 GB [M]) -- at **$3.38/month**. This minimal
-- tuple is **~0.24 GB [I: ~68 B/row, ~40 B of data + 23 B tuple header +
-- alignment]** at **$0.09/month [I]**.
--
-- Both costs are at $0.35/GB-month, which is the repo's own measured figure:
-- `LAUNCH_STORAGE_USD_PER_GB_MONTH` in `apps/web/lib/admin/neon.ts`. Two
-- measured reductions compound: dropping the 33 fields nothing reads, and
-- collapsing to one price per `id_compra` (**-47%** [M: median 1.87 rows per
-- purchase, mean 2.98, worst 47.8 -- a registro de precos with 48 lots]).
--
-- Not stored at all would be cheaper still (the band summary alone is 4.44 MB
-- [M]) and is deliberately refused, for two reasons: an incremental refresh can
-- ask `dataCompraInicio = last fetch` instead of re-walking 18 months, which is
-- what turns a 6.5-hour pass into minutes; and `MIN_SAMPLE`, `MAX_SPREAD` and
-- `MAX_AGE_MONTHS` are the part of this system we are least sure of, so C4's
-- re-tuning must be a query rather than a 6.5-hour re-fetch.
--
-- ## What is deliberately NOT here
--
-- **No supplier column, in either table, ever. This is a rule, not an
-- optimisation.** Every price row the API returns carries `niFornecedor` and
-- `nomeFornecedor`, and `niFornecedor` is a CNPJ **or a CPF** for an individual
-- supplier [M]. Storing ~3.9 M of them is storing ~3.9 M supplier identifiers,
-- against `CLAUDE.md`'s *"never log CPF, emails or tokens"* and spec §12.
-- `awards.supplier_doc` answers the same problem by masking CPF on write at
-- 23 448 rows; at 3.9 M rows the answer is no column, because a masking rule is
-- a line of code somebody can forget and an absent column is not. If a
-- supplier name is ever wanted on screen, that is a separate decision with its
-- own review -- not a `select` that already works.
--
-- **No `raw jsonb`**, which breaks `0001_initial.sql`'s stated convention
-- (*"raw PNCP payloads kept in `raw jsonb` with their original Portuguese field
-- names"*) on purpose and in the only place it has been broken. `raw` here
-- would re-import both things this table exists to avoid: the 41-field payload
-- (9.65 GB [M], against this tuple's 0.24 GB [I]) and `niFornecedor` inside
-- it. Do not add it back for symmetry.
--
-- ## Clocks -- three of them, and mixing two has produced a wrong answer here
--
-- - `purchased_on` and `window_end` are **calendar dates in the data's own
--   calendar**, with no timezone: `dataCompra` arrives as a plain date and
--   `MAX_AGE_MONTHS` is counted off it in whole months.
-- - `fetched_at` and `computed_at` are **UTC**, like every other timestamp in
--   this schema.
-- - The refresh job's schedule hour is **BRT** (`scheduler.py`'s `daily_at`),
--   and the row it writes is UTC.
--
-- So `window_end` is **not** `now()::date`. A UTC `now()` is up to three hours
-- ahead of Sao Paulo, so between 21:00 and 00:00 BRT `now()::date` names
-- tomorrow, and the band would claim a window ending on a day that, in the
-- calendar its own rows are dated in, has not started. Take it from
-- `(now() at time zone 'America/Sao_Paulo')::date`.

create table if not exists catalog_prices (
  -- 'M' | 'S'. Constrained rather than merely documented: `code` means
  -- `codigoPdm` under 'M' and `codigoServico` under 'S', so a third value is
  -- not a bad label, it is a row whose code points at nothing.
  --
  -- 'S' is legal and is expected to stay empty: 22.4% of service items resolve
  -- to a code and **0 bands were produced from any source** across 136 service
  -- items [M 2026-10-02], so B35 spends no refresh budget on the 911 CATSER
  -- codes. The column admits 'S' because the day a service-specific probe says
  -- which gate fires is not the day to run a migration.
  kind              char(1)  not null
    constraint catalog_prices_kind_check check (kind in ('M', 'S')),
  -- `codigoPdm` (materials) or `codigoServico` (services). No foreign key to
  -- `catalog_pdm` / `catalog_service`: which table it points at depends on
  -- `kind`, and SQL cannot express that. The same reason 0013 keeps an
  -- inactive PDM instead of deleting it applies here -- a vocabulary row going
  -- inactive must not take 379 median purchases with it.
  code              integer  not null,
  -- `idCompra`. **The collapse key**, and the reason it is in the primary key
  -- rather than alongside it: a registro de precos split into lots is one
  -- purchasing decision, and `priceBand` publishes quartiles over one price per
  -- key, not per row (its own comment measures what happens otherwise -- 40
  -- lots at R$ 1,20 compress the inter-quartile range to zero and clear the
  -- floor while four of the five sources paid double). Whatever the read path
  -- passes as `Comparable.tenderId` must be **this** column.
  id_compra         text     not null,
  -- `numeroItemCompra`. In the key because the API can return several items of
  -- the same code under one `idCompra` (measured worst case 47.8 rows per
  -- purchase), so without it the ingest would silently overwrite lots.
  -- **Note what this means: the -47% above is the job's discipline, not the
  -- schema's** -- this key permits the uncollapsed row set. Correctness does
  -- not depend on it, because `priceBand` collapses by its own key, but the
  -- storage figure does.
  item_number       integer  not null,
  -- `precoUnitario`. `numeric(16,4)` to match `awards.unit_awarded_value` and
  -- `tender_items.unit_estimated_value`, so no scale is lost moving a price
  -- between the old source and this one.
  --
  -- No positivity check: `priceBand` and `priceEvidence` already discard
  -- non-finite and non-positive prices, which is where that gate belongs
  -- (shared with the old path and covered by its tests). A check here would
  -- turn one strange API row into a failed walk of a whole page, and a failed
  -- walk writes no band at all.
  unit_price        numeric(16,4) not null,
  -- `dataCompra`, a **calendar date with no timezone** -- see the clocks note
  -- above. `MAX_AGE_MONTHS` (18) is counted off this.
  purchased_on      date     not null,
  -- `siglaUnidadeFornecimento`. Kept because R$/CX beside R$/UN is not a wide
  -- market, it is a wrong comparison, and 99% of refusals are `MAX_SPREAD`
  -- (below) -- so this column is how "the PDM mixes units" can be told from
  -- "the PDM mixes products" in SQL. That separation is C4's, which is the
  -- card that re-tunes the gates; nothing on a screen reads it.
  supply_unit       text,
  -- `codigoItemCatalogo`, the exact CATMAT item, which arrives free on every
  -- row of a `tipo=codigoPdm` response.
  --
  -- **It must not become a band key. Measured and rejected 2026-10-03**, on a
  -- pre-registered threshold (>=50% build it, <45% do not) set before the probe
  -- ran: scored on the same 500 exact-matched items with the same real
  -- `priceBand()`, a CATMAT-level band gives 2.7x the coverage (20.2% against
  -- PDM-level's 7.6%) at a **33% hit rate, p<0.001 below the ~50% a correct
  -- quartile band scores**, against PDM-level's 47% (p=0.871, indistinguishable
  -- from correct). At CATMAT level the spread is tight by construction, so
  -- `MAX_SPREAD` stops protecting anything and the only protection left is
  -- whether the item was pointed at the right code. The column is kept so that
  -- measurement stays repeatable as local arithmetic at zero API cost (C4),
  -- not as an upgrade path.
  catalog_item_code integer,
  -- The purchase's own words, and **kept only for the newest handful of rows
  -- per code** -- the thin rungs print at most `MAX_SAMPLES_SHOWN` (4) matched
  -- descriptions and nothing else reads this, while descriptions are the bulk
  -- of the payload (~18 MB [I] at the newest ~10 per code, against 9.65 GB for
  -- the full field set). The intent is stated here; **the job enforces it**,
  -- because "newest" is a window the schema cannot express.
  --
  -- So a null here means *"not kept"* and **not** *"the purchase had no
  -- description"*: the two are deliberately indistinguishable in this column.
  -- Counting nulls here as descriptionless purchases would be
  -- `memory: empty-result-is-not-absence` with a schema behind it.
  description       text,
  -- UTC. **Not** the staleness source: "when did we last ask about this code"
  -- is a `group by` over 3.9 M rows here and one row per code in
  -- `catalog_bands`, which is where the refresh reads it (see below).
  fetched_at        timestamptz not null default now(),
  primary key (kind, code, id_compra, item_number)
);

-- **No index beyond the primary key, and each read says why.**
--
-- The band computation reads one code's prices inside a date window:
-- `where kind = $1 and code = $2 and purchased_on >= $3`. `(kind, code)` is the
-- primary key's own prefix, so that is an index scan already; the date then
-- filters at most the rows of a single code -- median 379 purchases, max 1 649
-- [M 2026-10-02]. The `(kind, code, purchased_on)` btree that an earlier draft
-- of the approach proposed would add ~3.9 M more index entries (~125 MB [I at
-- 32 B/entry], a ~50% increase on a 0.24 GB table whose entire justification is
-- its size) to avoid filtering 1 649 rows in memory. Same for the description
-- pruning job, which orders one code's rows by `purchased_on desc`.
--
-- 0013 dropped two indexes nothing queried and said so; this is the same
-- answer. If a reader appears that scans by date **across** codes, it will need
-- one -- and it does not exist today.

-- One row per code per refresh window: the band, or why there is none.
--
-- This table is also the **ledger of what we have asked**, which is why a
-- refused code writes a row rather than leaving none. ~6% of uniformly sampled
-- needed codes genuinely have no rows in 18 months [M, verified by re-asking
-- over 5 years], so "no purchases" and "never asked" must be distinguishable --
-- and the refresh reads its staleness from here, one row per code per window,
-- rather than from 3.9 M price rows.
create table if not exists catalog_bands (
  kind           char(1) not null
    constraint catalog_bands_kind_check check (kind in ('M', 'S')),
  code           integer not null,
  -- The last calendar date the window includes, in the data's own calendar
  -- (see the clocks note). The window is `MAX_AGE_MONTHS` (18) wide and the
  -- band is a quartile over `purchased_on` inside it, so storing the end makes
  -- a published band reproducible from the rows that produced it -- and makes
  -- "which code is stale" answerable without a second table.
  window_end     date    not null,
  -- p25 / median / p75 of one price per `id_compra`, exactly as `priceBand`
  -- computes them. Null together, and only when `refused_reason` is set.
  low            numeric(16,4),
  median         numeric(16,4),
  high           numeric(16,4),
  -- **Distinct `id_compra`, not rows** -- the same discipline
  -- `PriceBand.sampleSize` applies to editais, for the same reason. This is the
  -- count a `MIN_SAMPLE` (5) comparison is made against.
  --
  -- Filled on a refusal too, and that is the point: the refused rows are not
  -- thin. Of 183 exact-matched items that got no band, every code had >=5
  -- purchases, median **379** [M 2026-10-02, the open-item probe].
  n_purchases    integer not null,
  -- **Why there is no band, as a column rather than an absence.** A code whose
  -- prices disagree must be a counted number, not something discovered on a
  -- screen.
  --
  -- This is the dominant fact about the whole design, and it is only visible
  -- because this column exists: of 183 exact-matched items with no band, **182
  -- (99%) were refused for spread and exactly 1 for too few purchases** [M
  -- 2026-10-02, the open-item probe]. So `MIN_SAMPLE` is not a binding gate on
  -- this source at all -- the data is abundant and the identity is too coarse.
  -- `MAX_SPREAD` (0.5) refusing a coarse PDM is the gate working, and the
  -- product's ceiling is that one fact rather than supply, matching rate or
  -- cost.
  --
  -- Unlike 0013's `rule`, the permitted values are **not** constrained here:
  -- the vocabulary belongs to the job that writes it (B35's ingest and refresh,
  -- in flight in a sibling PR) and pinning it from this side would be guessing
  -- at another lane's strings. The cost of that is real and worth naming -- a
  -- typo splits a count silently -- so whichever change writes the first reason
  -- owns closing the set.
  refused_reason text,
  -- UTC.
  computed_at    timestamptz not null default now(),
  -- Which matcher selected the rows this band rests on. Stored for the reason
  -- 0013 stores it on `tender_item_codes`: the measured accuracy (56% hit,
  -- +0.2% bias) is a property of the population the matcher selects, and that
  -- population is defined by the comparison and its word cap. Change either and
  -- the figure no longer describes what ships, so a later run can tell whether
  -- it is reading the rows a number was measured on. The cap fix in #212 is
  -- exactly this happening once already: it moved 41.1% of active CATSER from
  -- unmatchable to matchable, which makes every exact-match figure taken before
  -- it a floor.
  matcher        text    not null,
  primary key (kind, code, window_end),
  -- A row that contradicts itself cannot exist: either all three quartiles and
  -- no reason, or a reason and no quartiles. Same shape as 0013's
  -- `tender_item_codes_code_matches_rule`, and for the same reason -- the
  -- worker has no type checker, and the read path trusts a non-null `median`
  -- the way it trusts `rule = 'exact'`. A half-filled band would render a bar
  -- with a missing end, and a band beside a refusal would render a number the
  -- gate had already refused.
  constraint catalog_bands_band_xor_refusal
    check ((low is not null and median is not null and high is not null
            and refused_reason is null)
        or (low is null and median is null and high is null
            and refused_reason is not null))
);

-- **No index beyond the primary key here either.**
--
-- The price screen asks "what is this code's current band" -- `(kind, code)`
-- with the greatest `window_end` -- which is the primary key's prefix read
-- backwards; that is B35's "read by primary key, no `similarity()`, no per-item
-- API call". The refresh asks "which codes are stale", a `group by kind, code`
-- over the leading columns of the same index across ~7 109 codes [M] times a
-- handful of windows. And the question this table was added to answer -- how
-- many codes were refused, and for what -- is a `group by refused_reason` over
-- the same few thousand rows, which the planner seq-scans regardless.
