# To validate — Sci's open decisions

Contradictions found while building, each one waiting on Sci rather than on code.
They are here instead of in `docs/STATUS.md` because a status row records what a
task did; these record what nobody has decided yet.

**How to use this file.** Each item states what was found, where, and what it would
take to close. Nothing here is blocked on engineering — every one is a call about
copy, commercial rules or product scope. When you resolve one, delete the row and
put the decision where it belongs (the spec, the legal files, or `plan_limits`).

Verified on **2026-09-21** against `main`, the live site and the legal brief v1.1.

| # | Item | Blocks | Severity |
|---|---|---|---|
| 1 | Offer promises a charge notice that does not exist | first real charge, 10-29 | **high** |
| 2 | Offer omits refunds, which the FAQ says it must carry | M1, 09-24 | medium |
| 3 | `faq-cobranca.md` carries an internal note | publishing `/ajuda` | medium |
| 4 | Drafting note stripped at render, not at source | nothing | low |
| 5 | Publication date is 20/09, brief targeted 10-01 | nothing | low |
| 6 | Two `subscriptions` columns the brief requires do not exist | F2/F3, M5 | medium |
| 7 | `/conta/criar` and `/conta/alertas` 404 from live pages | conversion, now | medium |
| 8 | Spec still calls the Telegram bot temporary | nothing | low |
| 9 | Knowledge base and repo disagree on who owns legal copy | future edits | low |

---

## 1. The Offer promises a charge notice the product will not send

**High.** This is the one that can cost money.

The live Offer page says it twice:

- `messages.foundersPage.founderValue.comparisonRows[3]` — feature "Aviso de cobrança", ours: **"3 dias antes de cada cobrança"**
- `messages.foundersPage.faq.columns[1][2].a` — "Não. O plano é mensal, cancela em 1 clique e **você recebe aviso 3 dias antes de cada cobrança**."

Nothing backs it:

| Checked | Result |
|---|---|
| `legal/termos-de-uso.md` | no such clause |
| `legal/faq-cobranca.md` | no such clause |
| `legal/politica-de-privacidade.md` | no such clause |
| Any job in `worker/` | not implemented |
| `TECHNICAL_SPEC.md` §548 | listed under **v1 Essencial**, "billing reminder 3 days before each charge" |
| `DEVELOPMENT_PLAN.md` §4 | v1 Essencial releases **2027-01-11** |

Billing goes live at **M5, 2026-10-29**. So for roughly ten weeks the product would
charge people who were told they would be warned first, and were not. `faq-cobranca.md`
names this exact failure: *"Cliente que lê uma regra na Oferta e outra no contrato pede
chargeback."*

**Options, in the order I would take them:**

1. Drop the row and the FAQ clause. The Offer is strong without it, and nothing else
   on the page depends on it.
2. Replace it with a promise that is already true and already contractual: the 30-day
   notice before the R$ 26 → R$ 57 change.
3. Keep the promise and bring the reminder job forward into M5. That is real work in
   the billing lane and it makes the claim true on the day it starts mattering.

Not changed: billing copy is yours under brief §5.

## 2. The Offer omits refunds

`faq-cobranca.md` ends with a table naming where each answer belongs:

> | Página da Oferta, abaixo do preço | fidelidade · cancelamento · devolução · 7º mês |

The page carries three of the four. **Devolução is absent** — no mention of the 7-day
CDC withdrawal or the 30-day guarantee anywhere on `/fundadores`.

Less serious than item 1, because an omission misleads nobody the way a false promise
does. But the 30-day guarantee is a reason to sign up, so leaving it out is also
leaving money on the table.

**To close:** paste the "Vocês devolvem o dinheiro?" answer from `faq-cobranca.md`
under the price, per its own instruction to paste rather than paraphrase.

## 3. `faq-cobranca.md` contains a note meant for you

Line 42:

> A emissão de documento fiscal segue a legislação vigente.
> **[Confirmar com o contador antes de publicar — item G13.]**

The brief says to paste from this file into customer-facing copy. As it stands, that
bracket would ship to users. It is why `/ajuda` has not been built yet.

**To close:** resolve G13 with the accountant, then delete the bracket — or move it to
a comment that is not part of the answer.

## 4. The drafting note is stripped at render, not removed at source

Both legal documents open with:

> **Minuta v1.1 · 20/09/2026 · não é parecer jurídico.** Este texto foi escrito para ser
> revisado por um advogado antes de publicar.

That is addressed to you and the lawyer. Published verbatim it tells every visitor the
contract is an unreviewed draft, which argues against its own enforceability, so
`apps/web/lib/legal/document.ts` removes it when rendering — deliberately in the loader
rather than in your Markdown, because brief §5 says nobody else edits the wording.

**To close:** either confirm the render-time strip is what you want, or delete the line
at the source and remove the `DRAFTING_NOTE` constant. One or the other; having both
the note and the stripper is the state that will confuse the next reader.

## 5. The publication date is 20/09/2026, not the 10-01 target

Brief §6 targeted **2026-10-01 or later**, reasoning that Essencial should be in beta
before the date could be estimated. `legal/README.md` says something stricter and
incompatible: the date is the day the pages go live, and that must precede the Offer
form collecting its first e-mail.

`/fundadores` was already live and collecting, so the second rule decided it. The pages
went live on **20/09/2026** and both documents say so.

**To close:** nothing, unless you disagree. If you want the 10-01 date instead, the
pages have to come down until then, and the form with them.

## 6. Two columns the brief requires do not exist

Brief §4 lists five things billing needs. Three are there:

| Column | Spec §6 | `db/migrations/0001_initial.sql` |
|---|---|---|
| `subscriptions.promo_ends_on` | ✅ | ✅ |
| `subscriptions.promo_notice_sent_at` | ✅ | ✅ |
| `founders_list.seat` | ✅ | ✅ line 313 |
| **`subscriptions.ends_on`** | ❌ | ❌ |
| **`subscriptions.refunded_at`** (+ reason) | ❌ | ❌ |

`ends_on` is how cancellation keeps access to the end of the paid period — the Prime
model in brief §2 and the answer the FAQ gives to *"Se eu cancelar hoje, perco o acesso
na hora?"*. `refunded_at` is what makes the 30-day guarantee "once per CNPJ"
enforceable rather than a promise on the honour system.

Both are needed by **F2/F3**, so before **M5 on 10-29**. Not urgent, but it is a schema
change, and schema changes are their own PR.

**To close:** confirm the two columns and their types, and they go into a migration
with the billing card.

## 7. `/conta/criar` and `/conta/alertas` 404 from live pages

The live `/` links to `/conta/criar`; `/radar` links to both. Both return 404 behind the
branded not-found page. D3 documented this as expected until U1 and E1 land, and that
was right when nobody was looking at the site.

Founders week changes the calculation: a visitor who clicks **Entrar** during the week
you are driving traffic hits a dead end.

**Options:** point them at `/fundadores` until U1 lands, or hide the actions. Either is
a few lines; which one is a product call.

## 8. The spec still calls the Telegram bot temporary

`TECHNICAL_SPEC.md` §9.2 warns that the bot is temporary, that a bot has only one
webhook URL, and that we must confirm it is not already serving another system before
pointing it at LicitaQui.

Checked on 2026-09-20: the bot is **`@LicitaQuiBot`**, it has **no webhook set** and zero
pending updates. It is the LicitaQui-branded bot the avatar in `Marca/assest/` was made
for, and nothing else is using it.

**To close:** delete the warning and the "switch to the official bot later" note from
§9.2. Keeping stale caution in a spec costs someone an afternoon eventually.

## 9. Knowledge base and repo disagree on who owns legal copy

You settled this on 2026-09-20 — `docs/legal/` in this repository wins, and the
knowledge base is where you author amendments before copying them over. `CLAUDE.md`
now says so.

The knowledge base's own `CLAUDE.md` still says the opposite: its `legal/` folder is
"**Source of truth for legal copy** … Never edit without Sci".

**To close:** one line in the knowledge base pointing at the repo, next time you are in
that file. Left alone, an agent reading it will eventually edit the wrong copy.

---

## Not contradictions, but open and owned by you

From brief §6, unchanged:

- **Lawyer review** of terms §11 (liability cap), §6 (price clause), §8 (refunds) —
  before the first real charge, not before launch.
- **NFS-e with the accountant (G13)** — municipal obligation, blocks item 3 above.
- **ANPD standard contractual clauses** with Vercel, Neon, AWS, OpenRouter, Asaas,
  Resend, Sentry, Google and Cloudflare — compliance of privacy §9, not code.
- **Physical address** — deliberately not published; revisit only if a partner or the
  lawyer requires it.
