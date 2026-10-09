-- 0015_billing_asaas — what the Asaas integration (F2, D8, F4) needs and
-- `0001`/`0004` did not give it. Its own PR, per CLAUDE.md, and the
-- application half degrades honestly when it has not been applied: the plan
-- screen shows the plan without a checkout, and the webhook receiver still
-- answers 200 rather than letting Asaas retry 15 times and pause our queue
-- for 14 days.
--
-- **Numbered 0015, not 0008.** A `0008_billing_asaas.sql` was written on
-- 2026-09-25 in a worktree and never committed; 0008 through 0014 have since
-- been taken by other lanes. This file is that one, renumbered, reviewed line
-- by line and extended with F4's table.
--
--
-- ## A correction to three comments in applied migrations, which cannot be edited
--
-- `0001_initial.sql:288-289` says `promo_ends_on` is "first charge + 6 months"
-- and `promo_notice_sent_at` is the "30-day notice before R$ 26 → R$ 57", and
-- `0002_plan_limits.sql` is stale at **three** lines, not one — `:18` calls the
-- promotional row "R$ 26 (founders, first 6 months)", `:23` says "Essencial
-- R$ 57" and `:28` says "Pro R$ 98". The first version of this section named
-- only `:18`, which review pointed out is the shape of the defect it exists to
-- catch. All five are stale: `docs/product.json` has said R$ 57 for **3**
-- months → R$ 75 since 2026-10-05 (#257). An applied migration is a historical
-- record and editing its text would change a file the migration runner has
-- already hashed, so the correction is written here instead.
--
-- **The same drift was in nine other places and every one of them is fixed in
-- the F2 code PR**: `docs/TECHNICAL_SPEC.md` at six sites — including `:438`,
-- the line specifying the route that creates the subscription —
-- `docs/design/README.md` at four, and comments in `lib/admin/gates.ts`,
-- `lib/auth/founder-seat.ts` and `app/(public)/fundadores/page.tsx`. The spec's
-- three plan prices and its promo length are now held to `docs/product.json` by
-- `apps/web/lib/product.test.ts`; the rest are prose and are not.
--
--
-- ## 1. `subscriptions.checkout_url`
--
-- Asaas puts no hosted-checkout URL on the subscription itself. The documented
-- recipe is POST /v3/subscriptions, then GET /v3/subscriptions/{id}/payments,
-- and read `invoiceUrl` off the first charge — which is the link the copy
-- promises ("Pix ou cartão, pelo checkout seguro do Asaas",
-- `radar.landing.plans.essentialPaymentNote`). `POST /api/subscribe` fetches it
-- inside the request, but the plan screen has to render it on every later page
-- load, so there has to be somewhere to put it.
--
-- It is a URL that opens one named customer's invoice, so it is treated as
-- personal data (spec §12): read only by the account that owns the row, and
-- never logged.
--
--
-- ## 2. One live subscription per user
--
-- `0001` made `asaas_subscription_id` the primary key and put a plain index on
-- `user_id`, so nothing stopped one account accumulating subscriptions — which
-- is the shape of a double charge. The partial unique index below is the
-- database's half of the guarantee; the application's half is a
-- read-before-write on `externalReference`, because Asaas has no
-- idempotency-key header and its own docs tell integrators to query before
-- retrying.
--
-- Partial, not total: cancelling must leave the row for the financial history
-- and still let the same person subscribe again later, which is a second row
-- with a second Asaas id.
--
-- The CHECK keeps that index honest. A status outside the vocabulary would
-- fall out of the index predicate and silently stop protecting anything, so an
-- unexpected value has to fail loudly instead.
--
-- **The vocabulary is ours, not Asaas's**, and that is load-bearing.
-- `lib/admin/gates.ts` counts a paid founder seat from this column, and an
-- Asaas subscription is `ACTIVE` from the moment it is created — before anyone
-- has paid — so writing Asaas's own value here would make the "founder seats
-- paid" gate count unpaid signups. `pending` is the state a created-but-unpaid
-- subscription sits in, and the gate does not count it. The same PR narrows
-- that query from `in ('active','confirmed')` to `= 'active'`: `confirmed` was
-- a guess about Asaas's vocabulary made before this file existed, nothing has
-- ever written it (`select count(*) from subscriptions` is 0), and the CHECK
-- below would now forbid it — a branch that can never match is worse than no
-- branch, because it reads as cover.
--
-- `suspended` is in the vocabulary and nothing writes it yet: it is terms §7's
-- 10-day suspension, which belongs to F4. It is listed here rather than added
-- later because leaving it out would make the CHECK reject the value on the
-- day F4 writes it, and a payment state machine that cannot express a state
-- the contract names is the more expensive mistake. **Carded as F4, not left
-- in this comment.**
--
-- `NOT VALID` is deliberately *not* used: the table should be empty, so
-- validation is free and a row that would violate it should fail now rather
-- than at the first `UPDATE` months from here. **That is an inference, not a
-- measurement I made** — `docs/DEVELOPMENT_PLAN.md`'s E8 card records `select
-- count(*) from subscriptions` = 0 as of its 2026-10-05 audit on Neon `main`,
-- and nothing has had a write path since. Re-run that count before merging; if
-- it is not 0, read the statuses first, because this constraint will refuse
-- any value outside the five.
--
--
-- ## 3. `subscription_payments`
--
-- **The idempotency `webhook_events` cannot provide.** That table dedupes by
-- *event* id, and one payment legitimately produces several events with
-- different ids: Asaas documents boleto and card as PAYMENT_CREATED →
-- PAYMENT_CONFIRMED → PAYMENT_RECEIVED, with the card's RECEIVED arriving ~32
-- days after CONFIRMED, and Pix as PAYMENT_CREATED → PAYMENT_RECEIVED with no
-- CONFIRMED at all. So *"has this payment already granted access?"* is a
-- question about `pay_…`, not `evt_…`, and `entitled_at` is where the answer
-- lives.
--
-- It is also the ledger side of a reconciliation: `value` is what the customer
-- was charged and `net_value` is what Asaas says it will pay out, so the two
-- can be compared against a payout report without asking Asaas to recount.
--
--
-- ## 4. `billing_reminders`
--
-- `docs/DEVELOPMENT_PLAN.md`'s F4 card names this table and its index: *"a
-- `billing_reminders` table with a unique index on (subscription_id, due_on)"*,
-- and spec §10 says the reminder *"is idempotent per (subscription, due date),
-- and is never sent for a cancelled subscription"*. The unique index **is**
-- that idempotency: the sweep inserts the row and sends only if the insert
-- created it, so two sweeps on one day, or a sweep that runs twice because the
-- scheduler ticked during a deploy, send one e-mail.
--
-- It is in this file rather than a later one because F4's sweep ships in the
-- same code PR that reads it. A table nothing reads is the shape CLAUDE.md
-- names five times over, and `tenders.short_title` is the worked example —
-- 8 712 rows read by no screen, handed off in a sentence inside a migration.

alter table subscriptions
  -- The Asaas invoice URL for the current charge: the "link de assinatura" the
  -- Offer promises. Null before the first charge exists. Never logged (§12).
  add column if not exists checkout_url text;

alter table subscriptions
  drop constraint if exists subscriptions_status_check;

alter table subscriptions
  add constraint subscriptions_status_check
    check (status is null or status in ('pending', 'active', 'overdue', 'suspended', 'canceled'));

-- At most one subscription per account that is not over. See note 2.
create unique index if not exists subscriptions_one_live_per_user
  on subscriptions (user_id)
  where status in ('pending', 'active', 'overdue', 'suspended');

create table if not exists subscription_payments (
  -- Asaas's own `pay_…` id. The primary key *is* the idempotency guard: a
  -- redelivered or duplicated event upserts this row instead of adding one.
  asaas_payment_id      text          primary key,

  -- The subscription this charge belongs to. A real foreign key, which the
  -- 2026-09-25 draft of this file left out: `subscriptions.asaas_subscription_id`
  -- is already a primary key, every write here happens after we have found that
  -- row, and without the constraint a payment for a subscription we do not
  -- know about would be stored as though it were ours.
  asaas_subscription_id text          not null
    references subscriptions(asaas_subscription_id) on delete cascade,

  -- **Written by `upsertPayment` and read by nothing today. Carded as F15.**
  -- Every query in `lib/asaas/` and in `worker/licitaqui/billing.py` filters on
  -- `asaas_payment_id` or `asaas_subscription_id`; the one `user_id` in
  -- `billing.py`'s join is `subscriptions.user_id`, not this column. The
  -- cascade is redundant as well — this table cascades from `subscriptions`,
  -- which cascades from `users`.
  --
  -- Review found it as the second reader-less column in this table, after
  -- `net_value` (**F14**), and dropping it was the first instinct. It is kept
  -- for one measured reason: this file was **already applied to the shared test
  -- database on 2026-10-08 16:32:58 UTC** and the table there has the column
  -- `not null`, so removing it here makes every `*.db.test.ts` run fail on a
  -- constraint until somebody with rights on that database un-applies 0015.
  -- F15 removes it in its own migration, which is what the house rule asks for
  -- and costs one file.
  user_id               bigint        not null references users(id) on delete cascade,

  -- Asaas's payment status, verbatim and uppercase (PENDING, CONFIRMED,
  -- RECEIVED, OVERDUE, REFUNDED, RECEIVED_IN_CASH, …), deliberately *not*
  -- constrained: their docs warn that new values arrive without a version
  -- bump, and a CHECK here would turn a new Asaas status into a failed job on
  -- a payment that really happened.
  status                text          not null,
  billing_type          text,                        -- PIX | CREDIT_CARD | BOLETO | …

  -- Money as exact decimal, never a float. `value` is what the customer pays;
  -- `net_value` is what Asaas credits us, i.e. after their fee.
  value                 numeric(10,2) not null,
  net_value             numeric(10,2),

  due_on                date,
  paid_on               date,

  -- When this payment first granted access. Set once, by the first of
  -- PAYMENT_CONFIRMED / PAYMENT_RECEIVED to arrive; every later event for the
  -- same payment reads it and does not repeat the grant. It is also the
  -- evidence a CLAIMS row can be closed against — per payment, not per deploy.
  entitled_at           timestamptz,

  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now()
);

-- "the charges of this subscription, newest first" — the plan screen's
-- `billing.status.lastPayment`, and the reconciliation query. The plan screen
-- orders by `coalesce(paid_on, due_on) desc`, which this serves for the common
-- case (`paid_on` null while pending) and not for the mixed one; at a handful
-- of charges per subscriber that is a sort of a few rows, not a scan.
create index if not exists subscription_payments_subscription_idx
  on subscription_payments (asaas_subscription_id, due_on desc);

create index if not exists subscription_payments_user_idx
  on subscription_payments (user_id, created_at desc);

create table if not exists billing_reminders (
  -- Which charge this reminder is about. Spec §10 phrases the idempotency as
  -- `(subscription, due date)`; the primary key below adds `kind`, because
  -- F4's three messages — the 3-day reminder, the payment-failed notice and
  -- the suspension notice — are independent and one must not suppress
  -- another. The key is how that is enforced rather than checked: a sweep that
  -- runs twice inserts once, per kind. `worker/licitaqui/billing.py` agrees
  -- (`on conflict (asaas_subscription_id, due_on, kind)`).
  asaas_subscription_id text        not null
    references subscriptions(asaas_subscription_id) on delete cascade,
  due_on                date        not null,

  -- `charge_reminder` today; `payment_failed` and `suspension` when F4's other
  -- two messages exist. Listed as a column rather than a second table because
  -- all three are "one message about one charge, at most once".
  kind                  text        not null,

  -- The job the sweep enqueued, so a person asking "was it sent?" has
  -- something to join to. The delivery itself is evidenced per recipient in
  -- `events` (`email.sent`), never by this row — CLAIMS.md's standard, and E4
  -- is why: `jobs.status = 'done'` said the founders welcome had been sent for
  -- days while the transport was off.
  job_id                bigint,

  created_at            timestamptz not null default now(),

  primary key (asaas_subscription_id, due_on, kind)
);

-- The sweep asks "which reminders are due today?", which is a date scan.
create index if not exists billing_reminders_due_idx
  on billing_reminders (due_on);
