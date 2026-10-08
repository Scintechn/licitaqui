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
| ~~2~~ | ~~Offer omits refunds, which the FAQ says it must carry~~ | — | **closed 28/09** |
| 3 | `faq-cobranca.md` carries an internal note | publishing `/ajuda` | medium |
| 4 | Drafting note stripped at render, not at source | nothing | low |
| ~~5~~ | ~~Publication date~~ | — | **closed 21/09** |
| ~~6~~ | ~~Two `subscriptions` columns the brief requires do not exist~~ | — | **closed 26/09** |
| ~~7~~ | ~~`/conta/criar` and `/conta/alertas` 404~~ | — | **closed 21/09** |
| 8 | Spec still calls the Telegram bot temporary | nothing | low |
| 9 | Knowledge base and repo disagree on who owns legal copy | future edits | low |
| 10 | What separates a triagem from an análise completa — depth or breadth | **C2**, and a live sentence on `/` | **high** |
| 11 | Whether a **closed** tender is ever re-read for its value, and the attempt bound | **B38** | medium |
| 13 | Two Radar header sentences shipped as drafts: there is no approved copy for "no company" or "no CNAE to compare" | nothing — both render today | ~~medium~~ · **resolved 2026-10-06** — approved; gate moved to segments reached |
| 14 | Two *Favoritar* failure sentences shipped as drafts: there is no approved copy for "we could not save this" or "too many, wait a moment" | nothing — both render today on `/radar` | ~~medium~~ · **resolved 2026-10-07** — approved as drafted, two sentences, no edital name |
| 15 | A third necessary cookie exists (`lq_scope`) and the privacy policy's cookie list names two — and this one is derived from the CNPJ, not random | nothing in code; `/privacidade` renders the sentence at build time | ~~alta~~ · **resolved 2026-10-08** — §10 rewritten, approved by Sci |

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

## ~~5. The publication date~~ — closed, and it is 21/09/2026

Brief §6 targeted **2026-10-01 or later**, reasoning that Essencial should be in beta
before the date could be estimated. `legal/README.md` says something stricter and
incompatible: the date is the day the pages go live, and that must precede the Offer
form collecting its first e-mail.

`/fundadores` was already live and collecting, so the second rule decided it. The pages
went live on **20/09/2026** and both documents say so.

**To close:** nothing, unless you disagree. If you want the 10-01 date instead, the
pages have to come down until then, and the form with them.

## ~~6. Two columns the brief requires do not exist~~ — closed 2026-09-26

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

**Closed by `db/migrations/0004_subscription_refunds.sql`**, which adds `ends_on date`,
`refunded_at timestamptz` and `refund_reason`, with a constraint tying the last two
together (`(refunded_at is null) = (refund_reason is null)`) and partial indexes on
both. Written **before** F2 rather than during it, so the billing lane finds the columns
instead of discovering them mid-task — which is why this item could be closed without
waiting for the billing work itself.

Worth separating, because merging a migration is not applying one: confirm `0004` is
applied to `neondb` before F2/F3 rely on the columns. The same distinction bit us on
`0007_rate_limits`, which was merged on 25/09 and only confirmed applied on 26/09.

## ~~7. `/conta/criar` and `/conta/alertas` 404 from live pages~~ — closed 21/09

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

## 10. What separates a triagem from an análise completa — found 2026-09-29

The product sells **two** AI readings and the copy already names them apart:
`radar.screening.title` *"Triagem por IA"*, and `plans.essential.feature4` — *"10
análises completas por mês, com trechos citados do edital"*, rendered by
`<Plans>` on `/`. `0002_plan_limits` meters them separately: screening is 2 for a
visitor, 5/month on Básico and **unlimited** on Essencial and Pro, while
`deep_analysis` is 10/month on essencial **and promocional** and 60 on pro.
Sci confirmed exactly this on 2026-09-29, so none of it is in doubt.

**What is in doubt is what the second one does**, and the two candidate answers
are different products with different copy.

Measured 2026-09-29 against a real tender (Dispensa 017/2026, máquinas de lavar),
using the worker's own `documents.is_wanted` and `ai_tender.select_pages`:

| | |
|---|---|
| Documents published | 3 — `01 EDITAL DE DISPENSA 017.2026`, `AVISO DE CONTRATACAO DIRETA 17.2026`, `005 - Autorizacao de Contratacao` |
| Documents the triagem reads | **1.** `WANTED_TERMS = ("edital", "termo de referencia")`, so the aviso and the autorização are skipped |
| Pages in that document | 36, 83 429 characters |
| Pages the triagem reads | **24.** The 60 000-character budget drops 12 |
| Pages the deep budget reads | **36.** 320 000 characters fits the whole file |

The twelve dropped pages include **p. 24, `ANEXO VI – MODELO DE PROPOSTA
COMERCIAL (uso obrigatório por todas participantes)`** and **p. 34, `DECRETO Nº
167/2025 … Regulamenta o tratamento favorecido, diferenciado`** — the decree
behind the "Tratamento favorecido ME/EPP" tick the triagem prints.

**(A) Depth.** Same documents, the whole of them, and every claim carrying a
verbatim excerpt (`check_excerpt_citations`) rather than a page number
(`check_citations`). This is what the code does today, and what the approved
sentence already promises: *"com trechos citados do edital"*, singular.

**(B) Breadth.** The annexes as well — Sci's own description on 2026-09-29,
*"validate the tenders and all files that come with them"*. **The code does not
do this and C2 as carded would not add it:** `documents.wanted_files` takes no
mode, so both readings resolve the same list, capped at `MAX_DOCUMENTS = 8`.
B means widening `WANTED_TERMS` and the cap, and it means editing
`plans.essential.feature4`, which is live on `/`.

Nothing is re-keyed either way: `files_hash` digests the file **list**, not the
selection, and `ai_analyses` is unique on `(tender_id, mode, …)`, so the two
modes cannot overwrite each other.

**To close:** answer A or B. Under A, C2 ships as carded and the sentence stands.
Under B, C2 grows and the sentence changes — and per `CLAIMS.md` the new wording
needs its row in the same PR. Either way the two features must stop sharing
strings: `deep_analysis` has **no** CTA, cost line or quota label today, and
reusing the triagem's is how `screeningCost` came to tell founders on an
unlimited plan that every reading spent an allowance.

---

## Not contradictions, but open and owned by you

From brief §6, unchanged:

- **Lawyer review — deferred, not cancelled.** There is no budget for it **before the
  first charge**, so brief §2.2's product-framing rules are the **interim** mitigation and
  terms §2 states the same limits in the customer's language. **Revisit after Gate 0 on
  2026-11-06.** Recorded this way deliberately: a document that outlives its budget
  constraint and says we decided never to review is worse than one that says we ran out of
  money in September.

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

## ~~A. Refunds appear nowhere in the product — 0 strings~~ — closed 2026-09-28

**Both promises are now in the product's copy**, so the table below records what was
true when the sweep ran and not what is on screen. `foundersPage.refunds.items.0`
carries the CDC art. 49 sentence — *"Nos primeiros 7 dias da primeira assinatura, você
pode desistir e recebe tudo de volta"* — and `foundersPage.refunds.ctaLine` carries the
guarantee: *"Garantia de 30 dias: não gostou, devolvemos o primeiro mês."* Both render
on `/fundadores`; the same search that returned nothing now returns four strings.

They arrived with the terms §8 rule in #137, alongside the processing-fee deduction the
page states as a rule rather than a figure — the net amount is derived from
`docs/product.json`, never stored, so it cannot drift from the price.

### What the sweep found on 2026-09-25

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

Visitor limits (3 days, 2 triagens), Básico's 5/month, the promotional price change with its 30-day
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

---

# Framing rulings — 2026-09-21

Sci's decisions on the sweep above. All six are in brief §2.2 v1.7; repeated here so a
reader of this file does not have to hold both open.

| # | Ruling | Applied |
|---|---|---|
| 1 | `whyTitle` → "Por que este edital apareceu para você" | ✅ |
| 2 | "costuma vencer" → "a faixa em que os vencedores fecharam" — the fix is the **subject**, not the verb | ✅ **3 strings, not 2** |
| 3 | "preço-alvo" kept, **never alone** — always paired with "o máximo a pagar ao fornecedor para manter a sua margem" | ✅ 4 strings |
| 4 | "Até quanto ofertar com lucro" blessed in marketing; the **result screen** must show the inputs and label the output "teto para manter a margem que você informou" | keys added; the screen lands with the band |
| 5 | `radar.price.estimated` acceptable today; rule 3's full label **mandatory at B8** | ✅ in B8's acceptance criteria |

**On ruling 2 — I had under-reported.** The sweep listed `radar.landing.opportunity.body`
under rule 1 but did not flag it, so the ruling named two strings when three carried the
phrasing. The ruling is about the pattern, so all three are fixed. Worth noting as a
failure of the sweep rather than of the ruling: a list that matches loosely and triages
silently can drop a real one.

---

## E22 — what the locked rung may send (2026-10-01)

**The contradiction.** Sci's ruling of 2026-10-01 is *raw evidence free,
computation paid*: the matched past results are free at every rung, the band's
quartiles and the preço-alvo are Essencial. At the top rung those two halves
describe the same numbers, so they cannot both hold.

**Measured, not inferred.** At five editais the free payload sent four of the
five per-edital prices. Feeding them back through `priceBand` returns the real
`low`, `median` and `high` — exactly, when the fifth is recoverable, and
two-of-three plus a bracket on the median when it is not. Over five sorted
values the band *is* `sorted[1]`, `sorted[2]`, `sorted[3]`, so four known values
leave almost nothing to buy. `state: 'locked'` is itself a second channel: it is
sent if and only if the spread gate passed, so it reports the gate's verdict on
a sample the caller already holds. Removing the `{low, high}` range (done)
closed the widest channel; it did not close this one.

**Why it is not urgent in reach, and is urgent in principle.** It applies only
where a band exists: **0.67%** of open items, measured 2026-10-01 over 600. So
whichever way it goes, the 11.17% of items the ladder was built for are
unaffected — this is a decision about the top rung alone, seven days before
paying founders arrive on 08/10.

**The two coherent answers.**

1. **Accept it.** The band at ≥5 editais is effectively free, and what Essencial
   sells is the preço-alvo and the margin calculator — which are genuinely not
   reconstructible from past prices, because they encode the subscriber's own
   margin. Monotonicity holds perfectly. `plans.essential.feature3` would need
   re-reading against this, since it currently sells the band itself.
2. **Withhold the values at the top rung.** Send `editais` and the descriptions,
   not the prices, once `priceBand` returns non-null. The reader still learns
   that five editais closed on this product and what was matched; the numbers
   are the thing behind the gate. This *is* an inversion — prices visible at
   four editais, withheld at five — but it is confined to 0.67% of items and
   runs in the direction readers already expect from a paywall.

**My recommendation is (2)**, on the grounds that (1) quietly re-prices Essencial
seven days before launch and would need `plans.essential.feature3` rewritten,
which is copy and therefore Sci's anyway. But it is a pricing decision, not a
defect, so nothing was changed either way: the code currently does (1), because
that is what the ruling literally said.

**Blocks**: the render half of E22, which is where a reader would see either
answer. Nothing user-facing has shipped.
---

## 11. Whether a closed tender is ever re-read for its value (2026-10-05)

**What was found.** `refresh_tender_value` runs ~15 408 jobs/day — about half of
all job volume — and settles **148** of them. A tender valued from the item sum
is marked `items` and stays eligible for re-read **forever**, because the sum
over-counts on ~5 % of tenders. Measured on 2026-10-05: **52 113 of 54 513
tenders (95.6 %)** are permanently eligible, **22 090 of them already closed**,
another 5 055 with no deadline. Conversion is 1.6 % per pass and falling
(334/day → 73/day). `due_tenders`' docstring says the backlog "drains in well
under a day"; at 150/day against 52 113 it needs ~347 days.

**Why it is here and not simply fixed.** Both halves of the fix are product
rules, not engineering:

1. **Is a closed tender ever re-read?** Its estimated value can no longer inform
   a bid, but it still appears on historical screens, so "never again" may be
   wrong. If it should be re-read, on what trigger?
2. **What is the attempt bound for an `items` row?** The refinement it chases is
   real (~5 % of tenders are over-counted) but it currently has no stopping
   condition at all.

**What it would take to close.** Sci answers both; B38 then changes `DUE_SQL`
and `PARK_SQL` in `worker/licitaqui/tender_value.py` only.

**Not a cost item.** It would reduce compute as a side effect — see
`docs/COST.md` §6 — but it should be judged on whether the behaviour is right.


---

## 12. What the cited purchase id is called, and whether `awards` still feeds the rungs (2026-10-05)

**Raised by D37**, which put a citation on E22's thin rungs and then could not
name it.

**What shipped.** Each past result on a thin rung now prints the
Compras.gov.br purchase it came from — a bare 17-digit identifier, selectable,
with a *"Copiar"* control reusing `common.copy`. It is **not** a link: the
reasons are measured and recorded on the D37 card and in `lib/radar/compra.ts`.

**What is waiting on Sci — two sentences** (legal brief §5, so nothing was
written in their place):

1. A **visible label** naming the identifier. It must say *compra*, not
   *edital*: since B35 the evidence rests on `id_compra`, a purchase record.
2. The **screen-reader context** for the copy control. The one string already
   approved for this job is `radar.opportunity.copyIdContext` — *"o Id PNCP"* —
   and it is **false here**, so the accessible name is currently the digits
   themselves and a test asserts *"PNCP"* never appears on this screen.

This is the same drift as `CLAIMS.md`'s B35 row (the *"editais parecidos" / "editais encerrados"* row, due 17/10), where three live
strings still say *editais* about a mechanism that now reads *compras* — and
**D37 makes that drift visible rather than latent**: an unlabelled *purchase*
identifier now sits directly under `radar.price.evidenceHelp`, which is one of
the sentences that row names. No new claim was created, because no new
Portuguese string was written, so that row needs no companion — but it is now
something a reader can see on one screen rather than a wording mismatch only we
knew about. Worth answering together; the card is **D43**.

**And one older question this re-opens**, from
`docs/catalogue-price-band-approach.md` §12 open question 4, which B35 left for
Sci and which D37 is the first thing to actually need answered:

> Whether `awards` keeps feeding the thin rungs alongside the catalogue, for the
> PNCP edital citation D37 wants. Catalogue rows cite a *compra* instead.

D37 answers it *for now* by citing the compra, which costs nothing and keeps the
rung honest. The question Sci still owns is whether a **PNCP edital** citation is
worth keeping the `awards` path alive for — it is the only source that can
produce one, and the approach doc already recommends keeping the table because it
"costs nothing to keep".

## 13. ~~The Radar header shipped two sentences nobody approved~~ — **resolved 2026-10-06**

> **Sci approved all of it on 2026-10-06**, and decided the open question with it.
>
> `radar.list.noCompany` and `radar.list.groupHintNoCnae` stand as drafted.
>
> **The gate moves from *CNAEs read* to *segments reached*.** The question this
> row raised was that a company whose CNAEs map to no segment still read *"seu
> CNAE atende"* over an empty Compatíveis tab — a claim about a match where
> there is none, and the same shape as D19 one step further in. B6 leaves 777
> of 1 332 CNAEs unmapped on purpose, so it is a normal outcome rather than an
> error. A third string, `radar.list.groupHintNoSegment` — *"seu CNAE não
> alcança nenhum segmento ainda"* — now says so, and `segmentState()` in
> `radar-view.tsx` is what the hint reads.
>
> Note for whoever reads the test next: **D19's invariant loop cannot catch
> this one.** It holds the header and the hint to agreeing about *CNAEs*, and
> in this state they did agree — the header truthfully said "3 CNAEs" while
> the hint claimed a match. The header renders CNAEs, not segments, so the
> loop is structurally blind to it. A dedicated case in
> `radar-header.test.tsx` carries it, and it fails on the old behaviour.

D19 closed a false claim by **adding two strings**, which is the one thing legal
brief §5 says not to do without Sci. They render on `/radar` today, so this is a
decision about live copy rather than about scope.

| Key | Draft | Where it renders | Why a new string was needed |
|---|---|---|---|
| `radar.list.noCompany` | *"Sem empresa informada"* | the header line, in place of `companyFallback`, **only** once the list route has answered with no company at all | `companyFallback` is *"Sua empresa"*, which asserts there is one. It stays for the state where nothing is known yet, where it is exactly right |
| `radar.list.groupHintNoCnae` | *"sem CNAE lido para comparar"* | under the tabs, replacing `groupHint.compatible` (*"seu CNAE atende"*) and `groupHint.check` (*"pode haver exigências"*) when no CNAE was read | Those two sentences are claims about the reader's CNAEs. Rendered with none read, they are the half of D19 that was false. `groupHint.keyword` is untouched — it is about the search term |

Both are **true as rendered**: each is gated on the state it describes, which is
what `app/radar/radar-header.test.tsx` holds them to. The open question is only
the wording. Two things worth knowing before deciding:

- *"sem CNAE lido"* in the second draft is lifted from `cnaeCount`'s own
  already-approved zero branch, so the header and the hint read as one sentence
  rather than two vocabularies.
- A third option was considered and not taken: **render nothing** in both places,
  the way D47 ships no label rather than an unapproved one. It was rejected for
  the header because a line that disappears moves the tabs, and taken for the
  *unknown* state, where the hint genuinely draws nothing.

One related wording question this card does **not** answer, raised in review:
`groupHintNoCnae` is gated on **CNAEs read**, not on **segments reached**. A
company with three CNAEs that B6 maps to no segment therefore still reads *"seu
CNAE atende"* over an empty Compatíveis tab. That is consistent with the header
beside it (*"3 CNAEs"*), and the tab is empty so nothing is claimed about any
edital — but if Sci wants the hint to speak about what is comparable rather than
about what was read, it is a one-line change and a third string.

---

## 14. ~~Two *Favoritar* failure sentences, shipped as drafts~~ — **resolved 2026-10-07**

> **Sci, 2026-10-07: "Approve both as drafted, two sentences, don’t name the edital."**
> All three questions this row asked are answered.
>
> **The wording** — `failed` and `tooMany` ship exactly as drafted; `signedOut` was
> already his from D23.
>
> **One sentence or two** — **two.** The remedy differs, and that is the whole of it:
> *"Tente de novo"* is wrong advice on a 429, because the route allows 60 a minute
> and an immediate retry fails again. Pointing the 429 branch at `failed` would have
> told the reader to do the one thing that makes it worse.
>
> **Whether it names the edital** — **no, and not yet.** D57 put every card title in
> a node with an id, so interpolating costs no new *key*, but it is a new *sentence*
> and a longer announcement that `aria-atomic` re-reads whole. It would also inherit
> **D67**: two cards whose visible titles are identical would produce identical
> announcements, so naming is worth no more than the titles are unique. Revisit it
> after D67 is measured, not before.
>
> The reasoning behind each sentence stays in `pt-BR.json` beside it — *"o edital"*
> and not *"este edital"* because the region sits twenty cards from the star, and
> `tooMany` impersonal because the 60/minute budget is per **IP**, counted before
> the auth check, and spent by un-marking too. Approval does not make that reasoning
> stale; it is why the sentences read as they do.

D56 closed a hole by **adding two strings**, which legal brief §5 says is Sci's.
They render on `/radar` today, so this is a decision about live copy rather than
about scope.

Until 2026-10-06 the only sentence a failed *Favoritar* could produce was
`radar.favourites.signedOut` — Sci's, and about not having an account. `refused`
was set on **401 alone**, so a 429 (the route allows 60 a minute), a 400, a 500
and a dropped connection all reverted the star in silence. Reusing `signedOut`
for those would have been a lie about a 500, and nothing in `radar.states.*`
fits: `errorTitle` is *"Não conseguimos carregar o Radar"*, which names the wrong
subject — the D47 trap of borrowing a sentence whose words are about something
else.

| Key | Draft | When it renders | Why a new string was needed |
|---|---|---|---|
| `radar.favourites.failed` | *"Não conseguimos guardar o edital. Tente de novo."* | a 400, a 500, a 200 whose body is not `ready`, or a dropped connection | The one honest fact available is that the edital was not saved and the press can be repeated. Nothing in the client knows why, so the sentence deliberately does not say |
| `radar.favourites.tooMany` | *"Muitas tentativas em pouco tempo. Espere um instante e tente de novo."* | a 429 | Separate from `failed` **because the remedy differs**: *"tente de novo"* on its own is wrong advice inside a rate limit, where an immediate retry fails again |

Each is gated on the status it describes, and
`app/radar/favourite-feedback.test.tsx` plus
`e2e/journeys/favourite-feedback.spec.ts` hold it there. **Two things the §4b
review corrected before they shipped**, both worth knowing when deciding the
wording:

- `tooMany` first read *"Você marcou muitos editais em pouco tempo"*, which is
  false three ways. `app/api/tenders/[id]/favorito/route.ts` calls
  `rateLimitRequest` **before** the auth check and keys it on request headers —
  so the budget is an **IP's**, not a person's; un-marking spends it exactly as
  marking does; and on a 429 nothing was stored at all. Behind an office NAT it
  need not even be the reader's own traffic. The draft is now impersonal.
- `failed` first read *"este edital"*. The region is fixed to the bottom of the
  window, up to twenty cards away from the star that failed, so the
  demonstrative pointed at nothing.

So there are three questions here, not one:

1. **The wording of each sentence.**
2. **One sentence or two.** If Sci would rather have a single failure line,
   delete `tooMany` and point the 429 branch of `favourite-star.tsx` at
   `failed`. The `_note` in `pt-BR.json` says so, so whoever acts on this does
   not have to rediscover where the branch is.
3. **Whether the sentence should name the edital.** It is written on the
   *answer* and cleared on the *press*, so a slow failure on card A can surface
   just after the reader has pressed card B — and would be read as being about
   B. D57 has just put every card's title in a node with an id, so
   interpolating it costs no new **key**; it is a new **sentence**, which is why
   this is a question and not a decision taken in that PR. The alternatives are
   a notice per card (D56 rejected it: there is no room beside a 44px control
   over a card's corner) and serialising presses across cards (which makes the
   second press wait on the first, for a failure that is rare).

*Rendering nothing* — D47's answer — was never a candidate here: silence is the
defect D56 exists to remove.

`signedOut` is unaffected and still Sci's. **D66 reuses all three on the
opportunity screen and adds no key of its own**, so a rewording here lands in
both places at once — which is a reason to decide before D66 is built rather
than after.

---

## 15. ~~The privacy policy lists two necessary cookies and there are now three~~ — **resolved 2026-10-08**

> **Sci approved the replacement bullet on 2026-10-08**, drafted for his approval and pasted verbatim into `docs/legal/politica-de-privacidade.md` §10. Both questions this row asked are answered.
>
> **Does the *necessários* bullet cover it** — it does now, because the bullet was rewritten to name all three: the login session, the random visitor identifier, and the code derived from the CNPJ.
>
> **Is a cache-correctness cookie *necessário*** — **yes.** `docs/legal/README.md` records the product’s position (*"we use essential cookies only"*), and this one exists so a cached list of editais cannot be shown to a different person on the same device. That is a protection measure, not a convenience.
>
> **One thing the new sentence does beyond this card.** It also discloses that the visitor identifier *"lembra o CNPJ da sua última busca"*. That was never in the policy: §4 a) said the identifier existed only *"para aplicar os limites de 3 dias e 2 triagens"*, while the CNPJ it remembers is what the Radar groups by — live on production before this change. The wording was chosen to stay true after the *prefill, do not group* decision of 2026-10-07, so it will not need rewriting when that ships.

Opened 2026-10-07 by D58/D60 (`task/d58-d60-snapshot-identity`). **Not a code
question: nothing here is blocked on engineering, and the sentence is Sci's
under legal brief §5. The wording is deliberately not drafted below.**

### The three sentences, verbatim

`docs/legal/politica-de-privacidade.md` §10:

> Usamos **duas categorias** de cookies:
> - **Necessários ao funcionamento:** sessão de login e um identificador
>   aleatório do visitante, usado para aplicar os limites de 3 dias e 2 triagens
>   do acesso sem conta.

…and §4 a), on what is collected from a visitor:

> Identificador aleatório gravado em cookie próprio, versão resumida (hash) do
> seu IP e do navegador, para aplicar os limites de 3 dias e 2 triagens.

…and §10 again, on the Google Analytics identifier:

> essas métricas **não são anônimas**, ainda que não contenham o seu nome, o seu
> e-mail nem **o CNPJ que você pesquisou**.

**A reader of those three sentences concludes that nothing derived from their
CNPJ is kept in their browser.** After D58/D60 that conclusion is wrong.

### What `lq_scope` actually is

| | |
|---|---|
| set by | `POST /api/radar/cnpj`, in the same branch that writes `visitors.cnpj` — so only for a visitor, never for an account |
| value | `HMAC-SHA256(key, cnpj)`, base64url, truncated to 22 characters. The key is derived from `AUTH_SECRET` with its own label |
| is it derived from the CNPJ? | **Yes.** It is not a random identifier, which is the word both §4 and §10 use for the cookie they do name |
| reversible? | Not without `AUTH_SECRET`, which never leaves the server. A reader holding their own browser cannot read their CNPJ back out of it, and neither can anyone else |
| readable by page scripts? | **No** — `httpOnly`. It is read only by the server, which turns it into an opaque digest for the Radar's cache key |
| lifetime in the browser | `VISITOR_COOKIE_MAX_AGE_SECONDS` = **30 days**, `SameSite=Lax`, `Path=/`, `Secure` in production — the same attributes as `lq_visitor` |
| what it is for | the Radar's `sessionStorage` list cache keys by it, so a device that searched company B is never served company A's editais under A's name. Without it that defect is D60, and with no cookie there is no way for the browser to tell the two lists apart — `visitors.cnpj` is `httpOnly` by design (§12, D19) |
| where it is written down | `apps/web/lib/radar/scope.ts`, and card **D60** in `DEVELOPMENT_PLAN.md` §5 |

### The two questions for Sci

1. **Does the existing *"Necessários ao funcionamento"* bullet already cover it,
   or does §10 need a third item?** The *categories* are still two — this is a
   third cookie inside the first category, not a third category. But the bullet
   enumerates its contents (*"sessão de login e um identificador aleatório"*),
   and this cookie is neither of the two it names and is not random.
2. **Is it *necessário ao funcionamento*?** This is the sharper half, because
   §10 offers no consent choice for that category — it says only that the
   browser's own settings can refuse them. The case for *necessary*: without it
   the product shows one company's editais under another company's name, which
   is a correctness and privacy defect rather than a convenience. The case
   against: it exists to make a **cache** correct, and the product works without
   any cache. If the answer is *not necessary*, the gap is larger than a missing
   noun.

A third thing worth ruling on at the same time, because it is one reading:
§4 a) lists what is kept and would be the other place a third cookie is named.

### What this is not

Not a leak, and not a §12 breach: the value never reaches page JavaScript, never
reaches `sessionStorage` and never reaches a response body, and it cannot be
decoded. **The contradiction is a disclosure one** — the document describes the
browser's contents less completely than the product now fills them, in the
direction that matters (a reader would believe less is held than is).

Also in `docs/CLAIMS.md`, under *"Due before the founders publicity"* — there
because `/privacidade` is generated from this file at build time
(`apps/web/lib/legal/document.ts`), so the incomplete sentence goes public with
the merge, three days before the 08/10 opening. This row carries the question;
that row carries the exposure and the date. Closing one closes both.
