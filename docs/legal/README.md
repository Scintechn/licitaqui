# legal/ — LicitaQui legal texts

Drafts in **Brazilian Portuguese**, v1.1 (2026-09-20). The English entry point for Claude Code is `LEGAL_AND_BILLING_BRIEF.md` — share that one file and it points here. **They are drafts, not legal advice.** A lawyer must review them before publication. Everything in `[brackets]` is a placeholder Sci has to fill in.

| File | What it is | Route when published |
|---|---|---|
| `politica-de-privacidade.md` | Privacy policy (LGPD), 17 sections | `/privacidade` |
| `termos-de-uso.md` | Terms of service, incl. the founders price clause, 16 sections + 2 annexes | `/termos` |
| `faq-cobranca.md` | Customer-facing Q&A on subscription, cancellation and refunds (pt-BR, ready to paste) | `/ajuda` + Offer page + `/conta/plano` |
| `LEGAL_AND_BILLING_BRIEF.md` | **English brief for Claude Code**: company identification, locked commercial rules, what to read, what it means in code, what is still open | not published |

## 1. Placeholders left

| Placeholder | Where | Note |
|---|---|---|
| ~~`[DATA]`~~ | — | **Resolved 20/09/2026.** Filled with the day the pages went live. `/fundadores` was already accepting signups with an unlinked consent checkbox, so publishing could not wait for the 09-24 marketing date |

That is the only one. Resolved on 09-20: company identification (**Scint Tecnologia Serviços Ltda, CNPJ 36.955.612/0001-85**, check digits validated), contact channels (`contato@`, `privacidade@`, WhatsApp (11) 96246-0678), **no physical address published for now**, **no elected forum** (legal default applies), grace period (10 days), guarantee (30 days, first month, once per CNPJ, not on Pro), cancellation model (auto-renewal off, access to the end of the paid period), 7-day withdrawal limited to the first purchase.

**Address caveat to revisit:** Decreto 7.962/2013 expects a physical address in e-commerce. We are publishing CNPJ + e-mails + WhatsApp, which identifies the supplier and gives a working channel, and the company address is in any case public in the Receita's CNPJ record. If a payment partner, marketplace or the lawyer pushes back, the fix is one line in each document.

Keep the "não é parecer jurídico" banner in the file until the lawyer signs off; remove it only in the published version.

## 2. Benchmark — what v1.0 was checked against (2026-09-20)

Compared with the public policies of three Brazilian SaaS with our business model (recurring subscription, PJ customers, processors abroad), plus Basecamp's CC-licensed policies for structure.

**Where we are ahead of all three:**

- Purpose × legal basis **table** (none of them has one; the bases are scattered in prose).
- **Nominally listed processors** in the policy itself (only RD Station publishes a named list, and only as a DPA annex).
- Concrete **retention table** with deadlines per data type (they say "while the account exists" and little else).
- Explicit **15-day** response deadline for data-subject requests (none of them states a deadline).
- A real **AI section**: what the model reads, what it never receives, no-training option, no automated decision. They only cite the art. 20 review right.
- **30 days' notice** for price changes — Conta Azul gives 7, Asaas gives none for card fees.

**What they had and we adopted into v1.0:**

| Adopted | From | Where it landed |
|---|---|---|
| Short glossary before the technical sections | Asaas §1, Conta Azul §4 | privacy §3 |
| Anti-fraud guidance to the user | Conta Azul §16 | privacy §14 + terms §4 |
| Art. 20 right (review of automated decisions) listed among the rights | both | privacy §12 |
| Governing law and forum inside the privacy policy too | Asaas §12 | privacy §16 |
| Version history table | Conta Azul §17 | privacy §17, terms §16 |
| Commitment to keep the processor list current on the page | RD Station | privacy §8 |
| Export window before deletion (they give 90 days after suspension) | Conta Azul | terms §12 (30 days) |

**What they have and we deliberately did not copy:**

- **Uptime SLA** (Asaas promises 99%). At R$ 26–98/month a numeric SLA is a liability with no upside; terms §11 keeps "as is" plus notice of planned maintenance.
- **Separate cookie policy page.** We use essential cookies only; one section is enough and a second page would be noise.
- **CCTV, biometrics, job-applicant data.** Not applicable.

**Validated, not changed:** our liability cap (12 months paid) is exactly Asaas's; our 10-day suspension sits between Asaas (5 days) and Conta Azul (rescission at 10); the 7-day CDC withdrawal matches both.

Sources: [Asaas — Política de Privacidade](https://central.ajuda.asaas.com/hc/pt-br/articles/32098003163035-Pol%C3%ADtica-de-Privacidade) · [Asaas — Termos e Condições](https://central.ajuda.asaas.com/hc/pt-br/articles/32096847160859-Termos-e-Condi%C3%A7%C3%B5es-de-Uso) · [Conta Azul — Privacidade](https://contaazul.com/termos/privacidade/) · [Conta Azul Pro — Termos](https://contaazul.com/termos/pro-v5/) · [RD Station — Lista de suboperadores](https://www.rdstation.com/legal-e-privacidade/lista-de-suboperadores/) · [basecamp/policies (CC BY 4.0)](https://github.com/basecamp/policies) · [ANPD — Guia de Segurança para Agentes de Pequeno Porte](https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia-orientativo-sobre-seguranca-da-informacao-para-agentes-de-tratamento-de-pequeno-porte)

## 3. Best practices these drafts follow

- **Resolução CD/ANPD nº 2/2022** (small-porte agents): no DPO required, but a **titular contact channel is mandatory** (privacy §1); simplified records and security policy; extendable response deadlines, stated explicitly.
- **Resolução CD/ANPD nº 19/2024**: international transfers rely on the ANPD **standard contractual clauses** — the grace period ended 2025-08-23, so the clauses must actually be in place with the US-based processors (privacy §9). Action item, not just text.
- **LGPD art. 8 §4 / art. 9**: consent separate, specific, never pre-ticked — terms Annex B.
- **LGPD art. 20**: no automated decision with legal effect; the right to review is still listed.
- **Marco Civil art. 15**: access logs kept 6 months.
- **Decreto 7.962/2013** (e-commerce): identification, clear total price, easy cancellation — terms §1, §5, §8.
- **CDC art. 49** (7-day withdrawal) and **art. 51** (liability cap yields to the CDC) — terms §8 and §11.
- **Price change**: 30 days' notice, in writing, with free cancellation — terms §6 and §13, repeated on screen and in the confirmation e-mail (Annex B), which is what makes the clause hold up in practice.

## 4. Where these texts are used in the product

| Text | Used in | Task |
|---|---|---|
| Privacy + Terms links | Offer page form, footer of every page | D2 / D3 |
| Founders consent checkboxes (Annex B) | Offer form (`/oferta`) | D2 / F1 |
| Sign-up acceptance line | `/conta/criar` | U1 |
| WhatsApp / Telegram opt-in | `/conta/alertas` | E1 / E2 |
| Price-change notice on checkout | `/conta/plano` | F2 |
| Price-change e-mail / WhatsApp, 30 days ahead | `promo_price_change` job (spec §10), from `subscriptions.promo_ends_on` | F3 |
| 10-day suspension after failed payment | Asaas webhook + plan downgrade | F2 / F3 |
| 30-day export window before deletion | Account deletion job | U1 |
| Cancel = no auto-renew, access to end of period | Asaas subscription update + `subscriptions.ends_on` | F2 |
| Refund rules (7 days first purchase · 30-day guarantee, once per CNPJ) | Admin refund action + `subscriptions.refunded_at` | O1 |
| FAQ text (`faq-cobranca.md`) | Offer page, `/conta/plano`, `/ajuda`, support replies | D2 / F2 |
| "Não é assessoria jurídica" notice | Every AI result screen | D4 / C1 |

Two database fields exist for the price clause: `subscriptions.promo_ends_on` and `subscriptions.promo_notice_sent_at`. The notice job must be idempotent and must record the date it sent — that record is the evidence the 30-day notice was given.

## 5. Before publishing — checklist

1. [ ] Lawyer reviewed both files (ask specifically about terms §11 liability cap, §6 price clause, §15 forum).
2. [ ] All placeholders filled; banner removed.
3. [ ] ANPD standard contractual clauses signed/accepted with Vercel, Neon, AWS, OpenRouter, Asaas, Resend, Sentry, Google, Cloudflare.
4. [ ] Processor list in privacy §8 matches what is actually deployed.
5. [ ] Asaas dunning configured **inside** the 10-day window promised in terms §7.
6. [ ] NFS-e obligation confirmed with the accountant (plan item G13) — municipal rule, not a commercial choice; automate before the first charge if required.
7. [ ] Pages published at `/privacidade` and `/termos`, linked in the footer and in both consent flows.
8. [ ] Retention jobs implemented to match privacy §11 (visitor 30 days, logs 6 months, founders list 24 months) and the 30-day export window.
9. [ ] Version history row added whenever the text changes; keep the previous version file (privacy §15 promises it).
10. [ ] FAQ wording identical in all three places it appears (`faq-cobranca.md` is the source).
