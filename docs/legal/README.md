# legal/ — LicitaQui legal texts

Drafts in **Brazilian Portuguese**, written 2026-09-17. **They are drafts, not legal advice.** A lawyer must review them before publication. Everything in `[brackets]` is a placeholder Sci has to fill in.

| File | What it is | Route when published |
|---|---|---|
| `politica-de-privacidade.md` | Privacy policy (LGPD) | `/privacidade` |
| `termos-de-uso.md` | Terms of service, incl. the founders price clause | `/termos` |

## 1. Placeholders to fill before anything is published

| Placeholder | Where | Note |
|---|---|---|
| `[razão social completa]` | both, §1 | Full company name as registered |
| `[00.000.000/0001-00]` | both, §1 | CNPJ |
| `[endereço completo]` | both, §1 | Registered address |
| `[privacidade@dominio]` | privacy §1, 2, 5, 14 | Data-subject channel; may be the same inbox as below |
| `[contato@dominio]` | terms §1, 4, 8, 9, 15 | Support / contract notices |
| `[número]` | privacy §1 | WhatsApp for data requests (optional) |
| `[DATA]` | both, header | Publication date and effective date |
| `[10] dias` | terms §7 | Grace period after failed payment — confirm with Asaas dunning settings |
| `[comarca]` | terms §15 | Company's judicial district |
| `[opcional — garantia]` | terms §8 | Decide whether to offer a money-back guarantee |
| Invoice paragraph | terms §7 | Confirm with the accountant (plan item G13) |

Keep the "não é parecer jurídico" banner in the file until the lawyer signs off; remove it only in the published version.

## 2. Best practices these drafts follow

- **ANPD Resolução CD/ANPD nº 2/2022** (small-porte processing agents): no DPO is required, but a **titular contact channel is mandatory** and is stated in §1 of the privacy policy; simplified records and security policy; response deadlines may be extended, which the policy says explicitly.
- **ANPD Resolução CD/ANPD nº 19/2024**: international transfers rely on the ANPD **standard contractual clauses** — the grace period ended 2025-08-23, so the clauses must actually be in place with the US-based processors (privacy §8). Action item, not just text.
- **LGPD art. 8 §4 / art. 9**: consent is **separate, specific and never pre-ticked** — see terms Annex B.
- **LGPD art. 20**: the product does not take automated decisions with legal effect; the policy says so and says the AI output may be wrong.
- **Marco Civil (Lei 12.965/2014) art. 15**: access logs kept 6 months — stated in the retention table.
- **Decreto 7.962/2013** (e-commerce): identification, clear price and total, easy channel for cancellation — covered by terms §1, §5, §8.
- **CDC art. 49**: 7-day withdrawal for distance contracts — terms §8.
- **CDC art. 51**: no clause that removes the consumer's rights; the liability cap explicitly yields to the CDC (terms §11).
- **Price change**: announced 30 days ahead, in writing, with free cancellation — terms §6 and §13, and repeated on screen and in the confirmation e-mail (Annex B), which is what makes the clause enforceable in practice.
- Plain language, a summary table, and the same numbers as the product (48 seats, 6 months, R$ 26 → R$ 57).

## 3. Where these texts are used in the product

| Text | Used in | Task |
|---|---|---|
| Privacy + Terms links | Offer page form, footer of every page | D2 / D3 |
| Founders consent checkboxes (Annex B) | Offer form (`/oferta`) | D2 / F1 |
| Sign-up acceptance line | `/conta/criar` | U1 |
| WhatsApp / Telegram opt-in | `/conta/alertas` | E1 / E2 |
| Price-change notice on checkout | `/conta/plano` | F2 |
| Price-change e-mail / WhatsApp, 30 days ahead | `promo_price_change` job (spec §10), fired from `subscriptions.promo_ends_on` | F3 |
| "Não é assessoria jurídica" notice | Every AI result screen (triagem, análise) | D4 / C1 |

Two database fields exist for the clause: `subscriptions.promo_ends_on` and `subscriptions.promo_notice_sent_at`. The notice job must be idempotent and must record the date it sent — that record is the evidence the 30-day notice was given.

## 4. Before publishing — checklist

1. [ ] Lawyer reviewed both files (ask specifically about §11 liability cap, §6 price clause, §15 forum).
2. [ ] All placeholders filled; banner removed.
3. [ ] ANPD standard contractual clauses signed/accepted with Vercel, Neon, AWS, OpenRouter, Asaas, Resend, Sentry, Google.
4. [ ] Processor list in privacy §7 matches what is actually deployed.
5. [ ] Pages published at `/privacidade` and `/termos`, linked in the footer and in both consent flows.
6. [ ] Versions dated; keep the previous version file when updating (privacy §13 promises it).
7. [ ] Retention jobs implemented to match the table in privacy §10 (visitor 30 days, logs 6 months, founders list 24 months).
