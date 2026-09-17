-- 0002_plan_limits — quota reference data (spec §6.2 comments and §10).
-- Production reference data, not dev fixtures: it ships as a migration so every
-- environment has it. `quantity is null` means unlimited.
-- The table is deliberately editable at runtime ("configurable without a deploy"),
-- so this upsert only fills gaps and refreshes the shipped defaults.

insert into plan_limits (plan, feature, period, quantity) values
  -- no account: 2 screenings total, 3-day window
  ('visitor',     'screening',     'total',   2),
  ('visitor',     'days',          'total',   3),

  -- Básico R$ 0
  ('basico',      'screening',     'month',   5),
  ('basico',      'alert',         'week',    1),
  ('basico',      'keywords',      'total',   1),
  ('basico',      'states',        'total',   1),

  -- Promocional R$ 26 (founders, first 6 months) — same entitlements as Essencial
  ('promocional', 'screening',     'month',   null),
  ('promocional', 'deep_analysis', 'month',   10),
  ('promocional', 'keywords',      'total',   10),

  -- Essencial R$ 57
  ('essencial',   'screening',     'month',   null),
  ('essencial',   'deep_analysis', 'month',   10),
  ('essencial',   'keywords',      'total',   10),

  -- Pro R$ 98
  ('pro',         'screening',     'month',   null),
  ('pro',         'deep_analysis', 'month',   60),
  ('pro',         'keywords',      'total',   10),
  ('pro',         'market_price',  'month',   100)
on conflict (plan, feature) do update
  set period   = excluded.period,
      quantity = excluded.quantity;
