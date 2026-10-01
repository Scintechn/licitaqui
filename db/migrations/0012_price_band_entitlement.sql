-- 0012_price_band_entitlement — the price band becomes a `plan_limits` row (F5).
--
-- Every other entitlement is a row in this table, seeded by 0002, *precisely so
-- a plan change is one UPDATE rather than a deploy* (§6.2, "configurable
-- without a deploy"). The band was the exception: E9 gated it on a frozen list
-- in `lib/radar/quota.ts`, because 08/10 was ten days out and a schema change
-- is its own PR. The cost was small and specific — changing who gets a band
-- meant a deploy, and the one place a person would look to find out did not
-- mention it.
--
-- ## A capability in a table of quotas
--
-- `quantity` already carries the convention this needs, documented in two
-- places (`readLimit`, and `Limit.quantity`): **`null` is unlimited, `0` is
-- "the plan does not include this"**. A capability is therefore a feature that
-- is only ever `null` or `0`, and needs no companion table and no new rule.
--
-- ## Why every plan gets a row, including the ones that do not have it
--
-- Because **absence is the one thing this table cannot currently say
-- unambiguously**. The web reads a missing row as zero (`lib/radar/quota.ts`)
-- and the worker reads the same absence as uncapped
-- (`worker/licitaqui/telegram_alerts.py`: *"Reading a missing row as 'zero' —
-- the web's rule — would silence every founder on promocional on opening
-- week"*). Both are deliberate, both are documented, and **F6 exists to settle
-- which one wins**.
--
-- So this migration does not lean on absence in either direction: `visitor`
-- and `basico` get an explicit `0`. Whatever F6 decides, nothing here changes
-- meaning underneath it.
--
-- `period` is null because a capability has no period — it is not consumed.
--
-- The values are a transcription, not a decision: they are exactly what
-- `PRICE_BAND_PLANS` froze into code, moved to where a person can read it.

insert into plan_limits (plan, feature, period, quantity) values
  -- No band without a paid plan.
  ('visitor',     'price_band', null, 0),
  ('basico',      'price_band', null, 0),

  -- Promocional (founders), Essencial and Pro include it.
  ('promocional', 'price_band', null, null),
  ('essencial',   'price_band', null, null),
  ('pro',         'price_band', null, null)
on conflict (plan, feature) do update
  set period   = excluded.period,
      quantity = excluded.quantity;
