-- 0004_subscription_refunds — what cancellation and the two refunds need to be
-- enforceable (legal brief §4, terms §8, spec §10).
--
-- The brief lists five things billing needs. Three shipped in 0001
-- (`promo_ends_on`, `promo_notice_sent_at`, `founders_list.seat`); the two here
-- never did, and they are exactly what turns two published promises into
-- something the code can check:
--
--   * "o cancelamento desliga a renovação automática; você continua com o plano
--     pago até o último dia do período que já pagou" — the Prime model. Nothing
--     stored the last day, so nothing could enforce it.
--   * "garantia de 30 dias, uma vez por CNPJ" — nothing recorded that a CNPJ had
--     already used its one, so a second claim could not be refused.
--
-- The 7-day withdrawal (CDC art. 49) and the 30-day guarantee are different
-- animals: the first is law and unconditional on the first purchase, the second
-- is a commercial offer we chose to make. Both are refunds, so both are recorded
-- here, and `reason` is what tells them apart afterwards.
--
-- Written before F2 rather than during it, so the billing lane finds the columns
-- it needs instead of discovering them mid-task.

alter table subscriptions
  -- Paid access runs to this date after auto-renewal is switched off. Null while
  -- the subscription is live: only cancellation sets it.
  add column if not exists ends_on date,

  -- When a refund was issued for this subscription, and under which rule. Null
  -- means never refunded, which is what the once-per-CNPJ check reads.
  add column if not exists refunded_at timestamptz,
  add column if not exists refund_reason text;

alter table subscriptions
  drop constraint if exists subscriptions_refund_reason_check;

alter table subscriptions
  add constraint subscriptions_refund_reason_check
    check (
      -- Either both are set or neither is: a refund without its rule cannot be
      -- audited, and a rule without a date did not happen.
      --
      -- Written as an equality of two `is null` tests rather than the obvious
      -- `(a is not null and b in (...))`. The obvious form does not work: with
      -- `refund_reason` null the `in` yields NULL, so the branch is NULL, the
      -- whole expression is `false or NULL` = NULL, and a CHECK passes on NULL.
      -- It would have enforced nothing. Both operands here are `is null` tests,
      -- which are never NULL, so the comparison is always true or false.
      (refunded_at is null) = (refund_reason is null)
      and (refund_reason is null or refund_reason in ('withdrawal_7d', 'guarantee_30d'))
    );

-- The once-per-CNPJ check. The guarantee follows the company, not the login: a
-- CNPJ that claimed it cannot claim again through a second account or a second
-- subscription, which is what `legal/termos-de-uso.md` §8 says. `users.cnpj` is
-- the join, so the index carries the lookup rather than the uniqueness — two
-- refunds under different rules are legitimate (withdrawal on a first purchase,
-- guarantee on a later one), so this must not be a unique constraint.
create index if not exists subscriptions_refunded_idx
  on subscriptions (user_id, refund_reason)
  where refunded_at is not null;

-- Cancellations due to expire. The downgrade job reads this every day, so it
-- must not sequential-scan a growing table.
create index if not exists subscriptions_ends_on_idx
  on subscriptions (ends_on)
  where ends_on is not null;
