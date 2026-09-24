-- 0006_alert_limits — every paid plan gets an alert entitlement (card D6).
--
-- `0002_plan_limits` gave `alert` a row for `basico` alone, and the two sides
-- of the codebase read that absence in **opposite** directions:
--
--   * the web (`lib/radar/quota.ts`) — *"No row: the plan does not include the
--     feature. Not 'unlimited'."* So a paid plan resolves to **zero**.
--   * the worker (`telegram_alerts.py:50-57`) — a missing cap means
--     *uncapped* for the weekly digest, chosen deliberately "because reading a
--     missing row as zero would silence every founder on `promocional` on
--     opening week", and logged as ``plan has no alert limit`` so the gap
--     stays visible. That comment ends: "It wants a `plan_limits` row, which
--     is a migration, which is its own PR." This is that PR.
--
-- So no paid subscriber has ever been silenced — the worker's asymmetry did
-- its job. What broke is narrower and still real: the **web** displays zero,
-- which is what canvas 09's plan strip printed as "sem alertas neste plano"
-- the moment `FEATURES.alert` gave it a row to read.
--
-- ## Why weekly, when the spec says daily
--
-- §10 line 382 defines a `daily_alerts` job — every day 07:00 BRT, Essencial,
-- keywords + compatible CNAE — and line 455's plan matrix gives Essencial
-- "daily, 10 keywords + CNAE". It is marked **new**, it is listed under a
-- later phase at line 570, and Phase 0's own scope at line 563 reads "Básico
-- account …, Telegram linking, **weekly alert**. Founders opening 10-08".
--
-- So daily is designed, deferred and unbuilt, and `/fundadores` was describing
-- the product's roadmap while selling access to Phase 0. Sci's decision,
-- 2026-09-24: the page says what a founder will actually receive on 08/10.
--
-- This row is therefore the **Phase 0 cap**, not the final entitlement. When
-- `daily_alerts` ships, this row changes to `day` and the founders copy
-- changes with it — in the same PR, per CLAUDE.md. `plan-limits.db.test.ts`
-- and the cadence guard in `lib/messages.test.ts` both go red if one moves
-- without the other.

insert into plan_limits (plan, feature, period, quantity) values
  ('promocional', 'alert', 'week', 1),
  ('essencial',   'alert', 'week', 1),
  ('pro',         'alert', 'week', 1)
on conflict (plan, feature) do update
  set period   = excluded.period,
      quantity = excluded.quantity;
