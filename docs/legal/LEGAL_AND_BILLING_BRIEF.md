# LicitaQui — Legal & Billing Brief for Claude Code

**v1.7 · 2026-09-21 · English.** This is the entry point for anything touching **money, contracts, personal data or customer-facing legal copy**. Read this file first; then open only the files listed in §3 that your task needs. Do not restate or re-derive these rules from other documents — when another file disagrees with this one, this one wins and you tell Sci.

Talk to Sci in Brazilian Portuguese. All customer-facing copy is Brazilian Portuguese. Code, comments and commits in English.

---

## 0. How to use this file — read before anything else

**This file covers one domain: money, contracts and personal data.** It is not the entry point for the project as a whole.

1. The knowledge base is the folder that contains `CLAUDE.md`, `TECHNICAL_SPEC.md`, `DEVELOPMENT_PLAN.md`, `design/`, `legal/` and the POC scripts. On Sci's machine it is `~/Documents/POC Licitacao/`; this file lives at `legal/LEGAL_AND_BILLING_BRIEF.md` inside it.
2. **For anything that is not legal or billing** — repo layout, architecture, the task-card workflow, branches and PRs, UI, the POCs — open **`CLAUDE.md` at the root of that folder** and follow its reading order. It is short and it tells you what else to read and in which order.
3. **Before starting**, confirm you can actually open `legal/termos-de-uso.md` and `TECHNICAL_SPEC.md`. If you cannot, you were given this text without access to the folder: **stop and ask Sci for the folder path** rather than guessing the rules from memory.
4. Quick self-check — after reading this file you should be able to answer, without opening anything else: what happens on month 7 of a founder subscription; what a cancellation does to access; who gets a refund and when; how many days before suspension. If any of those is unclear, re-read §2.

---

## 1. Company identification — use this exact wording

```
Scint Tecnologia Serviços Ltda · CNPJ 36.955.612/0001-85
contato@licitaquiapp.com.br · privacidade@licitaquiapp.com.br · WhatsApp (11) 96246-0678
```

- **Footer of every page:** `LicitaQui é um produto da Scint Tecnologia Serviços Ltda · CNPJ 36.955.612/0001-85 · contato@licitaquiapp.com.br · WhatsApp (11) 96246-0678`
- `contato@` — support, contractual notices, refunds, cancellations.
- `privacidade@` — data-subject requests (LGPD). Mandatory channel; it must never bounce.
- **Support hours: Monday to Friday, business hours (America/Sao_Paulo).** Messages outside that window are answered on the next business day. This is stated in the FAQ; do not turn it into a response-time SLA anywhere else, and do not show a "resposta em X horas" badge.
- Both receive through Cloudflare Email Routing (tested). The domain is verified in Resend, so transactional sending is available; use `noreply@licitaquiapp.com.br` for automated mail and a reply-to of `contato@`.
- **No physical address is published for now** (decided 09-20). Do not invent one, do not use a placeholder in the UI, and do not add an "Endereço" field to the footer or the legal pages.
- **No elected forum** in the contract for now — the legal default applies. Do not add a "foro da comarca de X" clause.

## 2. The commercial rules — locked, do not change without Sci

**Plans** (limits live in the `plan_limits` table, never hardcoded):

| Plan | Price | Key limits |
|---|---|---|
| Visitor (no account) | R$ 0 | 3 days, counted per device **and** per CNPJ · 2 AI screenings |
| Básico (account) | R$ 0 | 5 AI screenings/month · 1 Telegram alert/week (1 keyword, 1 state) |
| Promocional (Founders) | **R$ 26/month for the first 6 months, then R$ 57** | Everything in Essencial · 48 seats only |
| Essencial | R$ 57/month | Unlimited screening · 10 deep analyses/month · saved filters · winning price range · margin calculator |
| Pro | R$ 98/month | 60 deep analyses/month · competitors by name · WhatsApp alerts |

**Founders price change — the most sensitive rule in the product:**

1. 48 seats, first come first served, seat number assigned in a transaction.
2. R$ 26/month for 6 months, counted from the **first confirmed charge**.
3. From month 7: R$ 57/month, automatically.
4. **Notice at least 30 days before** the first R$ 57 charge, by e-mail (and WhatsApp if consented), stating the date and the new amount.
5. **Never charge the new price if the notice was not sent.** `subscriptions.promo_notice_sent_at` is the evidence; the job must check it before updating the Asaas subscription value.
6. The seat is tied to the CNPJ and is not transferable; cancelling releases it and does not restore the promo price later.

**Cancellation, renewal and refunds:**

- Subscriptions renew monthly until cancelled. Cancelling in Conta → Plano **turns off auto-renewal**; access continues **to the last day of the period already paid** (the Prime model). No proportional refund outside the two cases below.
- **7-day withdrawal (CDC art. 49):** full refund, **first purchase only**. An automatic renewal does not reopen this window.
- **30-day guarantee:** first month back, no justification, **once per CNPJ**, on **Promocional and Essencial only**. On **Pro** only the 7-day withdrawal applies (60 deep analyses/month make an unconditional guarantee abusable).
- **Failed payment:** retries, then **suspension after 10 calendar days** from the due date; the account drops to Básico. Nothing is deleted at that moment. Asaas dunning must be configured **inside** this 10-day window.
- **After termination or suspension:** data available for export for **30 days**, then deleted or anonymised.
- **Reminder before every charge:** we e-mail the customer **3 days before each charge**, with the date and the amount. Asaas customer notifications are **disabled** in the account (Asaas charges per message), so *every* billing message is ours to send: the 3-day reminder, the payment-failed notice and the suspension notice. E-mail is the baseline channel; WhatsApp and Telegram are extra channels for users who opted in. Implemented by `charge_reminder` (task F4), shipping with billing at **M5**, not in v1.
- **A missed reminder is a breach, so it has its own rule.** Because the reminder lives in terms §7, silence is not a skipped courtesy — a customer can point at the clause. Never block the charge on it (blocking revenue over an e-mail failure is the worse outcome), but:
  - **Amount unchanged:** the charge proceeds. Send the notice immediately as a "sua cobrança sai hoje" message, record `charge_reminder_missed`, and treat a customer complaint about it as grounds for a goodwill refund without argument.
  - **Amount changed** (the R$ 26 → R$ 57 step): the existing rule wins — never charge the new price without `promo_notice_sent_at`. That one *does* block.
  - Absence must be as loud as error: daily reconciliation, a liveness alarm, `/admin` counter and a Telegram ping to the admin chat. Sentry alone cannot see a job that never ran. Spec §14 has the detail.
  - If Asaas moves `next_charge_on` after a reminder was sent, send an updated one; the unique index is on (subscription, due_on, kind), so a new due date is a new reminder.

**What we never promise:** an uptime SLA, a monthly invoice (NFS-e wording is "segue a legislação vigente" until the accountant confirms — item G13), legal or accounting advice, or any guarantee of winning a tender.

### 2.1 Promise register — every customer-facing billing promise

A promise only exists if all three columns are filled. If copy claims something with an empty column, the copy is wrong until the gap is closed, and you raise it with Sci instead of shipping it.

| Promise shown to the customer | Where it is contractual | What makes it true | Live from |
|---|---|---|---|
| "Cancele em 1 clique, sem multa" | terms §8 | Cancel action + Asaas subscription update | M5 |
| "Acesso até o fim do período pago" | terms §8 | `subscriptions.ends_on` + downgrade job | M5 |
| "Aviso 3 dias antes de cada cobrança" | terms §7 · FAQ | `charge_reminder` job (F4) | M5 |
| "Aviso 30 dias antes do R$ 26 → R$ 57" | terms §6, §13 | `promo_price_change` job (F3), gated on `promo_notice_sent_at` | M5 |
| "7 dias de arrependimento, 1ª compra" | terms §8 | Manual refund via Asaas + `subscriptions.refunded_at` | M5 |
| "Garantia de 30 dias, 1× por CNPJ" | terms §8 | Same, with the once-per-CNPJ check | M5 |
| "Suspensão em 10 dias de atraso" | terms §7 · FAQ | Asaas webhook + downgrade job, dunning configured inside 10 days | M5 |
| "Atendimento seg–sex, horário comercial" | FAQ | Sci answers the inbox | now |

**Lesson recorded 2026-09-21:** the Offer page shipped "aviso 3 dias antes de cada cobrança" while no clause and no job existed, and billing goes live ~10 weeks before the milestone that was going to build it. Sci chose to make the promise true rather than drop it. Keep this table updated whenever billing copy changes.

### 2.2 Product framing rules — the free substitute for a lawyer

There is no budget for legal review before the first charge, so the exposure is managed by **how the product describes itself**. Under CDC art. 30 advertising binds the supplier: what the copy claims becomes part of the contract. That cuts both ways — sloppy copy creates obligations, accurate copy removes them. These rules are not style preferences; they are the defence.

1. **Never promise an outcome.** Banned in any copy: "garanta", "vença", "ganhe licitações", "aumente suas chances em X%", "aprovado". The product finds, organises and calculates; it does not win anything. Flag any string like this to Sci instead of shipping it.
2. **A compatibility verdict is a reading, not a judgement.** "Compatível" and "Verificar" must always show **why** — which activity of the CNPJ matched what the edital declares — and must never be phrased as "você pode participar" or "sua empresa está habilitada".
3. **A price is always an estimate with its arithmetic visible.** Label every figure as calculated from data the edital or the public results declare. Never "oferte R$ X", never "preço ideal". The wording is "estimativa a partir dos dados do edital".
4. **Every extracted fact cites its page.** The citation is what makes the tool a transparent aid rather than an oracle, and it is the single strongest thing we have if a customer ever says the tool misled them. A screen that shows a conclusion without a source is a defect, not a design choice.
5. **The AI notice appears on every result screen**, not only in the terms.
6. **Keep the evidence trail**, because it costs nothing now and is what a lawyer would ask for later: version history on the legal texts, consent records with timestamp and wording version, `promo_notice_sent_at`, `billing_reminders`, and the copy sweep results.

Terms §2 states the same limits in the customer's language: the tool does not bid, does not decide, does not recommend a price. Product copy must stay inside that boundary.

**Rulings from the framing sweep of 2026-09-21** — decided, not open:

| String | Ruling |
|---|---|
| `radar.opportunity.whyTitle` = "Por que você pode participar" | **Change to "Por que este edital apareceu para você".** The body already complies; the heading was the only place a reading became a verdict. "Pode participar" is a habilitação judgement we do not make |
| "costuma vencer" (2 strings) | **Reword to the past, with the subject being the data, not the reader:** "a faixa em que os vencedores fecharam na sua região". Describing past public results is factual; "costuma vencer" attaches a tendency to the reader's next bid |
| "preço-alvo" (4 strings) | **Keep, never alone.** Always paired with what it means: "preço-alvo de compra — o máximo a pagar ao fornecedor para manter a sua margem". A MEI reading "preço-alvo" next to an edital will assume it is the bid |
| "Até quanto ofertar com lucro" | **Keep as the promise; constrain the screen.** It is the core value proposition and it is honest — a ceiling derived from the reader's own margin. But the result screen never shows the number alone: it shows the inputs (valor estimado do edital, faixa dos vencedores, custo do fornecedor, margem informada pelo usuário) and labels the output "teto para manter a margem que você informou" |
| `radar.price.estimated` = "Edital paga (estimado)" | Acceptable today. **Rule 3's full label becomes mandatory at B8**, when the winning band unlocks and there are real figures on screen |

## 3. Files — open only what your task needs

All paths are relative to the knowledge-base root (the folder that holds `CLAUDE.md`).

| File | Read it when |
|---|---|
| `legal/termos-de-uso.md` | Implementing checkout, cancellation, refunds, suspension, the price change. **Source of truth for contractual wording.** |
| `legal/politica-de-privacidade.md` | Handling personal data, consent, retention, deletion, the processor list, anything LGPD |
| `legal/faq-cobranca.md` | Writing customer-facing copy about billing. **Paste from here; do not paraphrase.** |
| `legal/README.md` | You need the benchmark, the remaining placeholders, or the pre-publication checklist |
| `TECHNICAL_SPEC.md` §6 | Table definitions (`subscriptions`, `plan_limits`, `usage`, `webhook_events`) |
| `TECHNICAL_SPEC.md` §10 | Plans, quotas and the `promo_price_change` job |
| `DEVELOPMENT_PLAN.md` §5 | The task card you were given (F1, F2, F3, U1, D2…) |

Terms §§ referenced below are sections of `legal/termos-de-uso.md`; privacy §§ are sections of `legal/politica-de-privacidade.md`.

## 4. What this means in code

**Database** (spec §6 already has these; do not rename):

- `subscriptions.promo_ends_on` — date the R$ 26 period ends.
- `subscriptions.promo_notice_sent_at` — when the 30-day notice went out. Gate the price change on this.
- `subscriptions.ends_on` — paid access runs to this date after cancellation.
- `subscriptions.refunded_at` + reason — enforces "once per CNPJ".
- `founders_list.seat` — unique integer, assigned in a transaction, 1..48; beyond 48 the signup is a waitlist entry.
- `subscriptions.ends_on date` — paid access runs to this date after cancellation; null while auto-renew is on.
- `subscriptions.canceled_at timestamptz` — when the customer cancelled.
- `subscriptions.next_charge_on date` — synced from the Asaas webhook; the 3-day reminder reads it.
- `subscriptions.refunded_at timestamptz`, `refund_kind text` (`arrependimento` | `garantia`), `refund_amount_cents int`.
- `companies.guarantee_used_at timestamptz` — single place that enforces "30-day guarantee, once per CNPJ". Check it before approving a refund, stamp it when one is granted.
- `billing_reminders (id, subscription_id, due_on date, kind text, channel text, sent_at timestamptz)` with a unique index on (`subscription_id`, `due_on`, `kind`) — the idempotency guard for F4.

**Jobs:**

- `promo_price_change` — daily, idempotent. (a) e-mails founders whose `promo_ends_on` is 30 days away and stamps `promo_notice_sent_at`; (b) on `promo_ends_on`, only if the stamp exists, updates the Asaas value to R$ 57 and sets `plan = essencial`.
- Suspension job / Asaas webhook — drops to Básico 10 days after the due date.
- Deletion job — respects the 30-day export window and the retention table in privacy §11.

**Screens and copy:**

- Offer form: consent checkboxes exactly as in terms **Annex B**, never pre-ticked, one per purpose, plus links to `/termos` and `/privacidade`.
- `/conta/plano` checkout: the price-change sentence and the acknowledgement checkbox from Annex B must be **on the screen, above the button** — not behind a link.
- Subscription confirmation e-mail: the paragraph in Annex B, with the real dates.
- Every AI result screen: the "não é assessoria jurídica/contábil, confira o edital original" notice.
- Billing copy in the Offer page, `/conta/plano` and `/ajuda` must be the **same wording** as `faq-cobranca.md`. A customer who reads one rule in the Offer and another in the contract files a chargeback.

**Invariants worth a test:**

1. 60 parallel founder signups → seats 1..48 unique, the rest waitlisted.
2. Price change never fires without `promo_notice_sent_at`.
3. Cancellation keeps access until `ends_on`, then downgrades.
4. Second refund request for the same CNPJ is refused.
5. Suspension happens on day 10, not earlier, and deletes nothing.

## 5. Hard rules

- **Never ship a billing promise that is not in §2.1.** Before writing or changing any copy about charges, renewal, cancellation, refunds or notices, check the promise register. New promise → it needs a clause, a job and a milestone first.
- **The drafting banner is authoring metadata, not page copy.** The `legal/` sources open with "Minuta … não é parecer jurídico"; the published pages must never show it. It is removed at render time (`apps/web/lib/legal/document.ts`). Do not delete it from the Markdown and do not remove the stripper — one source, mechanical removal, no draft banner can leak. When the lawyer signs off, Sci removes both in one PR.
- **Never write or edit legal wording yourself.** The three files in `legal/` are the source. If the product needs something they do not cover, stop and ask Sci.
- **Never publish the legal pages** without the publication date filled in and Sci's go-ahead — the pages must be live **before** the Offer form collects its first e-mail.
- **No real external side effects without Sci's OK:** Asaas **sandbox** only; no WhatsApp, Telegram or e-mail to anyone but Sci's test contacts; no migrations on the Neon `main` branch.
- **Secrets:** environment variable names only, in code and `.env.example`. Never commit, log or echo values.
- Numbers (prices, quotas, deadlines) come from `plan_limits` and the spec, not from literals scattered in components.

## 6. Still open — Sci owns these

| Item | Blocks | Note |
|---|---|---|
| ~~Publication date~~ | — | **Closed:** pages went live **21/09/2026**; both documents carry that date. The Offer form was already collecting, so the rule "pages live before the first e-mail" decided it over the 10-01 target |
| Lawyer review — **deferred, not cancelled** | Nothing in development. No budget before the first charge, so §2.2 carries the interim mitigation. Revisit after **Gate 0 (06/11)**, when the product has either sold or not | Scope: terms **§11** liability cap, **§6** price change, **§7** the 3-day reminder (now a self-imposed contractual obligation, so it has its own exposure), **§8** refunds. The briefing to send is `legal/BRIEFING_ADVOGADO.md` — it carries the context and the specific questions. Answer due 20/10 |
| NFS-e with the accountant (G13) | The first real charge | Municipal obligation, not a commercial choice. If required, automating it via Asaas becomes a task. The customer-facing wording stays "segue a legislação vigente" and carries no internal note |
| ANPD standard contractual clauses with the processors | Legal compliance of privacy §9, not the code | Vercel, Neon, AWS, OpenRouter, Asaas, Resend, Sentry, Google, Cloudflare |
| Physical address | Nothing for now. Revisit if a marketplace, a payment partner or the lawyer requires it | Decreto 7.962/2013 expects an address in e-commerce; we are publishing CNPJ, e-mails and WhatsApp instead, which is the pragmatic minimum and matches what the company already does elsewhere |
| Support hours | Nothing | If we ever state a response time, it goes in the FAQ first |

## 7. Version history

| Version | Date | What changed |
|---|---|---|
| 1.0 | 2026-09-20 | First version. Company identification without address, no elected forum, refunds and cancellation model locked |
| 1.1 | 2026-09-20 | Added §0 (how to use this file, and the pointer to `CLAUDE.md` for everything else), support hours, and the 2026-10-01 publication target |
| 1.2 | 2026-09-21 | 3-day charge reminder made contractual and scheduled (F4, M5); Asaas notifications off, so all billing messaging is ours; added the promise register (§2.1) and the rule that no billing promise ships without a clause and a job |
| 1.7 | 2026-09-21 | Framing-sweep rulings recorded in §2.2; lawyer review is **deferred, not cancelled** |
| 1.6 | 2026-09-21 | Terms §2 rewritten with what the tool does and does not do (no bidding, no decision, price is an estimate). Added §2.2 product framing rules — the interim substitute for legal review, which has no budget before the first charge |
| 1.5 | 2026-09-21 | Lawyer scope now includes §7; `BRIEFING_ADVOGADO.md` written, answer due 20/10 |
| 1.4 | 2026-09-21 | Missed-reminder policy: never block the charge, but alarm loudly and refund without argument if a customer is surprised; the price-change notice remains the one that blocks. Alarm requirements in spec §14 and F4 |
| 1.3 | 2026-09-21 | Legal pages published 21/09. Billing columns specified (`ends_on`, `next_charge_on`, refund fields, `companies.guarantee_used_at`, `billing_reminders`). Drafting-banner rule written down. NFS-e bracket removed from the FAQ so `/ajuda` can ship. `docs/legal/` in the repo is the published source; `legal/` here is the authoring copy |
