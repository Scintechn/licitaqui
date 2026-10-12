-- 0016_profile_identity — the two columns the simplified profile form needs,
-- and that `0001_initial.sql` did not give it. Its own PR, per CLAUDE.md.
--
-- Sci's requirement, 2026-10-12: *"all user needs to inform their name, birth
-- date, mobile number (BR or other country), Company/Business name
-- (optional)"*, and *"for Asaas we need to have a CPF or CNPJ to create the
-- account and charge the user, so one of them should be required."*
--
-- Three of those four are already columns: `users.name`, `users.whatsapp`, and
-- `users.cnpj`. Only these two are new — **and that count depends on a reading
-- of "Company/Business name (optional)" that is stated here rather than
-- assumed.** `users.cnpj` is a `char(14)` document, not a business name; the
-- name lives in `companies.legal_name` / `trade_name`, which `0001` labels the
-- **BrasilAPI cache** — keyed by CNPJ and written only by
-- `lib/radar/company.ts` and the worker, never by a person.
--
-- The reading taken, and it follows Sci's F32 ruling of 2026-10-12 that **a
-- CNPJ stays required to use the Radar**: the optional field is the **CNPJ**,
-- from which BrasilAPI supplies the name. There is therefore no free-text
-- business-name column and none is added. If Sci means a name typed by hand,
-- that is a different column and a different migration — say so and it gets
-- one, rather than F31 stalling mid-task on a schema change no card asked for.
--
--
-- ## Why there is no NOT NULL and no CHECK here
--
-- The requirement is *"one of CPF or CNPJ"*, and it is tempting to write
-- `check (cpf is not null or cnpj is not null)`. That would be wrong, and the
-- reason is the product rather than the schema: **the free Básico tier asks
-- for no document at all.** A visitor who creates an account to read editais
-- has neither, and a constraint would make the row unwritable at sign-up —
-- the gate belongs where the document is actually needed, which is the
-- checkout (`lib/asaas/checkout.ts`, today `needs_company`).
--
-- `name` is likewise left nullable. `lib/auth/adapter.ts` writes
-- `user.name ?? null` because the Resend magic-link provider supplies no name,
-- so a NOT NULL here would break sign-in itself. **F29** is the card for the
-- sentence a nameless subscriber reads, and it is Sci's.
--
--
-- ## Why `cpf` is `char(11)` and carries no foreign key
--
-- Symmetry with `cnpj char(14)`: digits only, no punctuation, normalised by
-- the application before it reaches here. `cnpj` references `companies(cnpj)`
-- because a CNPJ names a business we hold CNAEs for; **a CPF names a person
-- and there is no such table, nor should there be.**
--
-- The `check` is a shape check only — eleven digits — not a verifier. Check
-- digits **will be** validated in `lib/cpf.ts` beside `lib/cnpj.ts` (**F32**);
-- **nothing validates them today**, and that matters because the weak schema
-- check is justified by a validator that does not exist yet: a constraint
-- rejecting a typo at write time gives the reader a 500 instead of a message,
-- but until F32 lands an unvalidated eleven-digit string would reach Asaas's
-- `cpfCnpj` and be refused there. F31 lists F32 in `Depends on` for this
-- reason, so the sequencing holds — the guarantee simply is not in place yet.
--
--
-- ## §12 and the LGPD note that is not a code concern
--
-- A CPF is personal data about a natural person, where a CNPJ usually is not.
-- CLAUDE.md already forbids logging one. Two further things are **not** solved
-- by this file and must not be assumed solved by it:
--
--  * `docs/legal/politica-de-privacidade.md` §4 lists *"Nome, e-mail e, se
--    informar, WhatsApp"* and *"CNPJ da empresa"*. It does **not** say we
--    collect the subscriber's own CPF or their date of birth. §4(c)'s
--    *"identificação"* arguably covers sending a document to Asaas; it does
--    not cover storing one here. **The amendment is Sci's** (legal brief §5),
--    it is tracked in `docs/CLAIMS.md`, and **nothing may write these two
--    columns until it ships** — which is why this migration lands before the
--    form rather than with it.
--  * The policy already says the service *"não é destinado a menores de 18
--    anos"*, which is the purpose that justifies `birth_date` under data
--    minimisation. Collecting it for any other reason would not be justified.
--
-- So this file creates the columns and **F31** builds the form that fills
-- them — a column nothing writes yet, carded in the same PR, per CLAUDE.md.

alter table users add column if not exists cpf char(11);
alter table users add column if not exists birth_date date;

alter table users drop constraint if exists users_cpf_shape;
alter table users add constraint users_cpf_shape
  check (cpf is null or cpf ~ '^[0-9]{11}$');

-- A person has one CPF, and two accounts sharing one is either a duplicate or
-- somebody else's document. Partial, so the many NULLs of the free tier do not
-- collide — `unique` alone would allow only one NULL in some engines and all
-- of them in Postgres, and being explicit says which was meant.
-- Named `_unique_idx`, **not** `users_cpf_key`: that is exactly what Postgres
-- auto-generates for a unique *constraint* on `users(cpf)` — compare
-- `users_email_key` and `users_founder_seat_key`, which `0001` creates
-- implicitly — so a later `add constraint … unique (cpf)` would collide on the
-- index name. Two forward costs of a partial index, recorded for F31 which
-- writes this column: it is an index and not a constraint, so it is absent
-- from `pg_constraint` and cannot carry a foreign key; and it is **not a valid
-- `ON CONFLICT` arbiter** unless the predicate is restated —
-- `on conflict (cpf) where cpf is not null`, never bare `on conflict (cpf)`.
create unique index if not exists users_cpf_unique_idx on users (cpf) where cpf is not null;

comment on column users.cpf is
  'Digits only. Billing identity for a subscriber with no CNPJ (Asaas cpfCnpj). Never logged (CLAUDE.md, spec §12).';
comment on column users.birth_date is
  'Collected only to apply the 18+ rule the privacy policy states. Never logged.';
