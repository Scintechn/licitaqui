-- ───────────────── §6.1 A short, human title for every tender ─────────────────
--
-- The card and the detail heading render `trimObject(tender.object)`. PNCP has
-- no short-title field and `object` is the legal "objeto", so the useful noun is
-- usually buried:
--
--   CONTRATAÇÃO DE EMPRESAS PARA FORNECIMENTO DE MATERIAIS PERMANENTES, para
--   Secretaria de Saúde, conforme descrito no Anexo I – Termo de Referência…
--
-- `worker/licitaqui/titles.py` turns that into "Fornecimento de materiais
-- permanentes" — deterministically where it can (25.7% of the 4,760 production
-- rows), and with the screening model where it cannot.
--
-- These columns carry the answer *and* enough provenance to tell, later, where
-- a title came from and whether it is still current. Nothing here is rendered
-- yet; the web change is separate and later.

alter table tenders
  -- The title itself. Null means "not titled yet", which is also what a
  -- rate-limited backfill leaves behind, so the row is picked up again.
  add column if not exists short_title text,

  -- Which branch produced it:
  --   deterministic — cut from the objeto; cannot have invented anything.
  --   ai            — the model's answer, and it passed `titles.validate`.
  --   ai_fallback   — the model was asked and its answer was NOT used. Either
  --                   the validator rejected it or the call failed, and the
  --                   deterministic title shipped instead. Deliberately not
  --                   folded into `deterministic`: it is the only way to see
  --                   how often the validator is earning its keep, and a rising
  --                   count here is the signal that the prompt has drifted.
  add column if not exists short_title_source text,

  -- Bumped when the deterministic rules or the branch predicate would answer
  -- differently (`titles.RULES_VERSION`). A bump re-titles every row.
  add column if not exists short_title_rules_version int,

  -- The prompt/validator version (`titles.PROMPT_VERSION`), null on a row the
  -- model was never asked about. Two columns rather than one combined version
  -- on purpose: a prompt change must not re-title — or re-pay for — the quarter
  -- of the corpus the model never saw.
  add column if not exists short_title_prompt_version text,

  -- Digest of everything the title was derived from: the objeto, the PNCP
  -- revision, and the item set. This is what makes "is this title stale?" a
  -- plain column comparison instead of a guess — the title is current only
  -- while this still equals the digest recomputed from the live row, so a title
  -- is invalidated exactly when `pncp_updated_at` moves or the items change.
  -- The expression that produces it lives in one place, `titles.BASIS_SQL`.
  add column if not exists short_title_basis text,

  -- When the title was written. Provenance for a later "regenerate everything
  -- titled before <date>" without having to bump a version.
  add column if not exists short_title_at timestamptz;

alter table tenders
  drop constraint if exists tenders_short_title_source_check;

alter table tenders
  add constraint tenders_short_title_source_check
    check (short_title_source is null
           or short_title_source in ('deterministic', 'ai', 'ai_fallback'));

-- The sweep that enqueues titling work looks for untitled rows first; this is
-- the index that keeps that cheap once the backfill has run and the answer is
-- "almost none". Staleness by digest still costs a scan, which is why that
-- sweep is periodic and not per-request.
create index if not exists tenders_short_title_pending_idx
  on tenders (updated_at)
  where short_title is null;
