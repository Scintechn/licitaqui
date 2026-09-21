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
| ~~1~~ | ~~Offer promises a charge notice that does not exist~~ | — | **resolved 21/09** |
| 2 | Offer omits refunds, which the FAQ says it must carry | M1, 09-24 | medium |
| 3 | `faq-cobranca.md` carries an internal note | publishing `/ajuda` | medium |
| 4 | Drafting note stripped at render, not at source | nothing | low |
| 5 | Publication date is 20/09, brief targeted 10-01 | nothing | low |
| 6 | Two `subscriptions` columns the brief requires do not exist | F2/F3, M5 | medium |
| 7 | `/conta/criar` and `/conta/alertas` 404 from live pages | conversion, now | medium |
| 8 | Spec still calls the Telegram bot temporary | nothing | low |
| 9 | Knowledge base and repo disagree on who owns legal copy | future edits | low |

---

## ~~1. The Offer promises a charge notice the product will not send~~ — resolved 2026-09-21

**Sci kept the promise and made it true**, rather than deleting the copy. The Offer is unchanged;
"3 dias antes de cada cobrança" becomes true at M5, which is when billing starts and nobody is
charged before then.

The premise of this item was too narrow. Asaas charges per customer notification, so those
notifications are **already disabled** in the account — which means Asaas is not sending the
payment-failed notice either, and terms §7 already promised one. **Every billing message is ours
to build**, not just the reminder I happened to find.

What changed:

| | |
|---|---|
| `legal/termos-de-uso.md` §7 | new clause: e-mail 3 days before each charge, with date and amount (v1.2, published 21/09) |
| `legal/faq-cobranca.md` | new Q&A, "Vou ser cobrado de surpresa?" (v1.3) |
| `legal/LEGAL_AND_BILLING_BRIEF.md` §2 | the rule, and that every billing message is ours (v1.2) |
| `legal/LEGAL_AND_BILLING_BRIEF.md` §2.1 | **the promise register** — see below |
| `legal/LEGAL_AND_BILLING_BRIEF.md` §5 | hard rule: never ship a billing promise absent from §2.1 |
| `DEVELOPMENT_PLAN.md` | task **F4 `charge_reminder`**, and M5 now ships it |
| `TECHNICAL_SPEC.md` §10 | billing messages are ours, not Asaas's |

**The structural fix is §2.1, not this row.** A promise now exists only when three columns are
filled: where it is contractual, what makes it true, and from when. Copy claiming something with
an empty column is wrong until the gap closes. That catches the next instance of this class
before it ships, which deleting one sentence would not have.

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

- ~~**Lawyer review**~~ — **decided 2026-09-21: not happening.** There is no budget for it
  before the first charge, so the exposure is managed by **how the product describes
  itself** instead. Brief §2.2 carries the six rules that replace it, terms §2 states the
  same limits in the customer's language, and every UI string is now checked against
  them before shipping. Under CDC art. 30 advertising binds the supplier, which is why
  accurate copy is a real substitute and not a consolation prize.
- **NFS-e with the accountant (G13)** — municipal obligation, blocks item 3 above.
- **ANPD standard contractual clauses** with Vercel, Neon, AWS, OpenRouter, Asaas,
  Resend, Sentry, Google and Cloudflare — compliance of privacy §9, not code.
- **Physical address** — deliberately not published; revisit only if a partner or the
  lawyer requires it.

---

# Copy sweep — 2026-09-21

Every string in `apps/web/messages/pt-BR.json` touching charges, renewal, cancellation, refunds,
notices, personal data or what the AI does, checked against `docs/legal/` and the promise register
(brief §2.1). Prompted by the "3 dias" finding: the catalogue was written before the legal texts
existed, so nothing had ever been reconciled.

**No copy was changed.** These are findings.

## A. Refunds appear nowhere in the product — 0 strings

The strongest result of the sweep. Searching the whole catalogue for `devolv`, `reembols`,
`garantia`, `arrepend`, `estorno` returns **nothing**.

Both refund promises are contractual and both are in the register:

| Promise | Contractual | In the product's copy |
|---|---|---|
| 7 dias de arrependimento, 1ª compra | terms §8 | **absent** |
| Garantia de 30 dias, 1× por CNPJ | terms §8 | **absent** |

`faq-cobranca.md`'s own table says the Offer must carry *devolução*. It does not, and neither does
`/conta/plano`, `/ajuda` or anywhere else. This is the inverse of the "3 dias" bug: there the copy
over-promised, here the copy under-sells something already owed — and a 30-day guarantee is a
reason to subscribe.

## B. "renovação" where the contract says "cobrança"

`radar.landing.guarantees[2].body` — *"E-mail 3 dias antes de cada renovação."*

Terms §7 and the FAQ both say **cobrança**. For a monthly subscription the two coincide today, but
they are not the same word, and `faq-cobranca.md` opens by insisting the two documents move
together. Worth aligning before F4 makes the promise real.

## C. The list of un-disableable billing messages is now stale

`notifications.billingHelp` — *"Confirmação de pagamento e aviso de mudança de preço. Esses não dá
para desligar, porque a gente precisa te avisar."*

Correct that they cannot be switched off, but the list is short by three: the 3-day reminder, the
payment-failed notice and the suspension notice are all ours now (brief §2, F4). A user reading
this will not expect them.

## D. Suspension at 10 days is promised in the contract and mentioned nowhere in the product

Terms §7 and the FAQ both state it. No string in the catalogue does — there is no suspension
messaging at all, which F4 will need to write anyway.

## E. Comparative claims nobody has re-checked

`foundersPage.founderValue.comparisonRows` compares LicitaQui against competitors
("muitas com contrato anual"), and `foundersPage.pain.source` cites *"Preços de concorrentes:
sites oficiais, setembro de 2026"*.

Comparative advertising has to stay accurate and verifiable. These were written in September; if a
competitor changes terms, the claim becomes false without anyone touching our code. Not a defect
today — a thing with an expiry date on it.

## F. Two `TODO(Sci)` still inside the catalogue

`_meta.todo[2]` and `_meta.todo[6]` both ask for a word-by-word review of `consent.*`, the LGPD
consent record for WhatsApp and e-mail (spec §12, terms Annex B). Still unreviewed. `_meta` is not
rendered, so nothing leaks to a user, but the review they ask for has not happened.

## What checked out

Visitor limits (3 days, 2 triagens), Básico's 5/month, the R$ 26 → R$ 57 change with its 30-day
notice, "sem fidelidade", "cancela em 1 clique", Pix/cartão via Asaas, the AI disclaimer and
"não substitui assessoria jurídica ou contábil", and the footer identification — all consistent
with the legal texts. No copy anywhere promises a nota fiscal, which brief §2 forbids until G13.

---

# Framing sweep — 2026-09-21

Against brief §2.2 rules 1–3, after Sci replaced the lawyer review with product-framing
rules. **No strings changed.**

## Breaks rule 2 — one string

`radar.opportunity.whyTitle` — **"Por que você pode participar"**. Verbatim one of the two
phrasings rule 2 bans, and it is a heading on the live Opportunity screen. The content
beneath it already complies (it shows *which* CNPJ activity matched); only the heading
turns a reading into a verdict. Nothing anywhere says "está habilitada".

## Borderline on rule 1 — two strings

`foundersPage.hero.promises[2]` and `foundersPage.pillars.items[2].body` both say
**"costuma vencer"**. Describing past awards is factual; "tends to win" edges into a claim
about the reader's next bid. Not on the banned list, close to its spirit. Sci's call.

## Prospective gap on rule 3

Rule 3 requires every price labelled *"estimativa a partir dos dados do edital"*. That
wording appears **nowhere**; the only labelling is `radar.price.estimated` =
"Edital paga (estimado)".

It does not bite today only by accident: D4 renders the winning band and the market price
as **locked** bars, so there is no figure to mislabel. Every one of those numbers needs
the label the moment B8's data unlocks the band at v1 Essencial. Belongs in that card now.

Also flagged, not condemned: **"preço-alvo"** (4 strings). Rule 3 bans "preço ideal", and
this is adjacent — though it means the maximum paid to a *supplier*, not what to bid.

## Checked and clear

"Garantir minha vaga" / "Vaga garantida" guarantee a founder **seat**, which F1 assigns in
a transaction. "Garantia contratual" is the edital's own bid-bond field. "quem venceu
ofertou…" describes public results and is sourced (`ruler.source`). "Até quanto ofertar
com lucro" is a ceiling derived from the reader's own margin, not "oferte R$ X" — worth
Sci's explicit blessing since it is the core value proposition, but compliant as written.
