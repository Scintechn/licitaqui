-- The Compras.gov.br closed vocabularies, mirrored locally (card B36).
--
-- ## Why these live in our database at all
--
-- The mapper turns an item's free-text description into a catalogue code, and it
-- must do that for 450 445 open items (measured 2026-10-02) in one offline pass
-- with no network. `4_consultarItemMaterial?descricaoItem=…` returns 0 rows for
-- ordinary words like CADEIRA or PERFURADOR -- text search against the catalogue
-- does not work the way it reads -- so the only workable shape is to hold the
-- vocabulary here and match against it locally. Measured: the full resolve over
-- every open item takes ~4 minutes of CPU and zero API calls.
--
-- ## Size, measured
--
-- 20 440 PDM rows of which 15 039 are active; 3 103 CATSER rows of which 3 023
-- are active (walked 2026-10-02). ~3 MB. Both are refreshed by
-- `sync_catalog_vocabulary`, which `scheduler.DEFAULT_SCHEDULE` enqueues weekly
-- (Sunday 03:20 BRT) -- scheduled in the same change as the handler, because
-- B32 is what happens otherwise: a working handler, no enqueuer, and a feed
-- that stopped growing for two days unnoticed. `statusPdm` flips over time and
-- an inactive code must stop feeding bands.
--
-- ## What is deliberately NOT here
--
-- The 345 257 CATMAT **items** (`4_consultarItemMaterial`). The mapper resolves
-- to a PDM (materials) or a CATSER service, and the exact `codigoItemCatalogo`
-- arrives for free on every price row, so mirroring 345 257 rows (~140 MB) buys
-- nothing the price feed does not already carry. If CATMAT-level bands are
-- adopted, the codes come from the price rows themselves -- see B35.

create table if not exists catalog_pdm (
  -- `codigoPdm`. The product *kind*, which is the granularity comparables want.
  code            integer primary key,
  name            text    not null,
  -- The folded head is NOT stored. `catalog_sync.load_index` recomputes it from
  -- `name` on every run, because a stored head would be folded by whichever
  -- matcher was deployed when the row was written -- and a `remap`, whose whole
  -- purpose is to re-resolve after a matcher correction, would then resolve
  -- against stale heads and report success. 18 062 names fold in milliseconds.
  class_code      integer,
  class_name      text,
  group_code      integer,
  group_name      text,
  -- `statusPdm`. An inactive PDM is kept, not deleted: a tender item mapped
  -- last month may still point at it, and a silently vanishing row would turn
  -- a mapped item into an unmapped one with no record of why.
  active          boolean not null,
  updated_at      timestamptz not null default now()
);

-- No index on `active`: the only query is `select code, name ... where active`
-- over 15 039 rows, which the planner seq-scans regardless, and no SQL ever
-- searches the folded head -- the matching is done in Python.

create table if not exists catalog_service (
  -- `codigoServico` (CATSER).
  code            integer primary key,
  name            text    not null,
  class_code      integer,
  class_name      text,
  active          boolean not null,
  updated_at      timestamptz not null default now()
);

-- Same for 3 023 service rows; see the note above catalog_pdm.

-- One row per tender item: which catalogue code it resolved to, and HOW.
--
-- `rule` is stored rather than derived because it is load-bearing: Sci's
-- decision of 2026-10-02 is that **only an exact match may feed a band**.
-- Measured over 1 350 back-tested items, a prefix match's band is biased
-- **+18.6%** against the real winning price while an exact match's is -3.6%, so
-- the distinction decides whether a number may be computed at all. Storing it
-- means that rule is inspectable in SQL rather than buried in the mapper.
create table if not exists tender_item_codes (
  tender_id       text    not null,
  item_number     integer not null,
  -- 'M' | 'S', copied from tender_items.kind so a reader needs no join.
  kind            char(1) not null,
  -- null when nothing resolved; `rule` then says which way it failed.
  code            integer,
  -- Constrained, not merely documented: B35's read path will be a SQL
  -- `where rule = 'exact'`, so a typo'd or newly-invented value would be a
  -- silent band. `unknown_kind` is an item whose `tender_items.kind` was
  -- neither 'M' nor 'S' (the column is nullable) and which was therefore never
  -- matched against any vocabulary.
  rule            text    not null
    constraint tender_item_codes_rule_check
      check (rule in ('exact', 'prefix', 'prefix_rev', 'no_match', 'no_head',
                      'unknown_kind')),
  -- How many words of the item's head the catalogue name matched. 1 means a
  -- one-word PDM like CADEIRA or COLA, which is a product *class*, not a
  -- product; measured coverage and accuracy both differ sharply by this.
  matched_words   integer not null default 0,
  -- How many codes shared the matched head, so an ambiguous resolution is a
  -- counted number. Measured: 4 026 active PDM names are a single word and 118
  -- begin with PAPEL, so collisions are the norm, not the exception.
  candidates      integer not null default 0,
  -- Which matcher produced this row. The band's measured accuracy (56% hit,
  -- -3.6% bias) is a property of the population the matcher selects, and that
  -- population is defined by the comparison and its word cap. Change either and
  -- the figure no longer describes what ships, so the row records which matcher
  -- it came from and a later run can tell whether it is reading the rows a
  -- number was measured on.
  matcher         text    not null,
  mapped_at       timestamptz not null default now(),
  primary key (tender_id, item_number),
  -- A row that contradicts itself cannot exist: exactly the rules that mean
  -- "nothing resolved" may carry a null code, and no other rule may.
  constraint tender_item_codes_code_matches_rule
    check ((code is null) = (rule in ('no_match', 'no_head', 'unknown_kind'))),
  foreign key (tender_id, item_number)
    references tender_items (tender_id, number) on delete cascade
);

-- The screen asks "what code does this item point at" by primary key, and the
-- refresh job asks "which codes does the open corpus reference" by code.
create index if not exists tender_item_codes_code_idx
  on tender_item_codes (kind, code) where code is not null;
