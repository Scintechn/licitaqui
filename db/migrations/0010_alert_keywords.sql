-- 0010_alert_keywords — an alert may hold as many keywords as the plan grants (card E18).
--
-- `0002_plan_limits` grants `essencial` and `promocional` `keywords · total ·
-- 10`, and `basico` 1. The product has only ever delivered **one**, on every
-- plan, which means Essencial's alert is identical to Básico's and the row a
-- founder pays for on 08/10 differentiates nothing.
--
-- Found by Sci on his own Essencial account, 2026-09-29, not by a test:
-- nothing asserts that the number of keywords a person can configure matches
-- what `plan_limits` grants, which is why D6's pass walked past it. That guard
-- is card **F6**.
--
-- ## Why a column and not more rows
--
-- `alerts` has a `kind`/`value` shape that reads like one row per alert, and
-- the first plan for E18 said so. The **application** does not use it that
-- way. `saveAlert` updates exactly one row per account —
-- `channel = 'telegram' and frequency = 'weekly'` — `readLinkStatus` selects
-- it with `limit 1`, and the worker's `RECIPIENT_SQL` does the same. That one
-- row also carries `states`, `active`, and the `id` that `alert_deliveries`
-- references.
--
-- So spreading keywords across N rows would duplicate `states` and `active` N
-- times, turn `/pausar` into an N-row update, and leave a delivery with no
-- obvious `alert_id` to log against. An array on the row that already exists
-- keeps pause, states and delivery logging exactly as they are, and confines
-- the change to the read path in the web and the worker.
--
-- ## The backfill, and why `value` stays
--
-- Every existing alert's single keyword moves into the array, so nobody's
-- digest changes the moment this runs. `value` is **not** dropped: the worker
-- and the web both still read it until their side of E18 ships, and a
-- migration that breaks running code between deploys is not a migration, it is
-- an outage. Dropping it is a later card, once nothing reads it.
--
-- `kind` keeps its meaning — `'keyword'` when there is at least one, `'cnae'`
-- when there is none — and the check constraint below is what stops the two
-- from drifting apart silently.

alter table alerts
  add column if not exists keywords text[] not null default '{}'::text[];

-- Existing single keywords, preserved. `value` is left in place on purpose.
update alerts
   set keywords = array[btrim(value)]
 where value is not null
   and btrim(value) <> ''
   and keywords = '{}'::text[];

-- No empty strings and no nulls inside the array: `websearch_to_tsquery` would
-- happily accept `''` and match every open tender in Brazil, which is the
-- portal this product exists to replace.
--
-- Written with `array_position` rather than the `not exists (select 1 from
-- unnest(...))` this first said, because **Postgres forbids a subquery in a
-- CHECK constraint** — the first version parsed fine to read and failed on
-- execution. Trimming is therefore the application's job (`clampPreferences`
-- already trims), and this catches the two values that would silently match
-- everything.
alter table alerts
  drop constraint if exists alerts_keywords_check;

alter table alerts
  add constraint alerts_keywords_check
  check (
    keywords is not null
    and array_position(keywords, null) is null
    and array_position(keywords, '') is null
  );

comment on column alerts.keywords is
  'Keywords this alert matches, any of them. Capped per plan by plan_limits '
  '(feature ''keywords''), enforced server-side in clampPreferences. Replaces '
  'the single `value`, which is kept until the web and worker read this column.';
