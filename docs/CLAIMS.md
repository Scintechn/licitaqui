# Claims register

**Every user-facing promise that is not yet true, where it renders, what would
make it true, and the date it comes due.**

## Why this file exists

Four times in two days the same defect was found from four different
directions: a sentence shipped that described something the product does not
do. The alert cadence said *todo dia* while one weekly job ran. The founders
benefit sold early access to a Radar already public. The confirmation said a
WhatsApp had been sent while the kill switch was off. The welcome message
promises an access link on 08/10 that nothing sends.

None of these was carelessness. Each was found by someone reading one screen
closely, and each had been invisible to everyone else because **the claim and
the machinery live in different files, owned by different tasks, on different
timelines**. `docs/DEVELOPMENT_PLAN.md` knows what is unbuilt; it does not know
what has already been promised in public.

This register is the join. A claim belongs here from the moment it renders
until the moment the thing it describes is provably real.

Under **CDC art. 30** an advertised feature binds: *"a oferta … obriga o
fornecedor"*. A page taking money is where that bites, so the bar for removing
a row is evidence, not a green suite and not a deploy.

## How to use it

**Before writing or approving user-facing copy**, check whether the sentence
describes something that exists. If it does not, it gets a row here in the same
PR — the same rule `CLAUDE.md` applies to a string that renders nowhere, in the
opposite direction.

**Before a launch date**, read the Due column. Anything due and unresolved is
either built, or the sentence changes. The sentence is Sci's under legal brief
§5; the choice between the two is his, and this file exists so it is a choice
rather than a discovery.

**Evidence is per-recipient and per-event**, never per-deploy. E4 is the worked
example: `jobs.status = 'done'` said the founders welcome had been sent for
days while `WHATSAPP_DELIVERY` was off, because a dry run and a real send differ
only by the event name. It was closed by a `whatsapp.sent` row carrying
a real `message_id`, and by the message arriving on a handset.

---

## Due before the founders publicity

These bind on people we are about to pay to attract.

**As of 2026-09-25 the only seat taken is Sci's**, so every message described
below as delivered to a handset was delivered to him. Nothing in this file
binds a third party yet, which is why the rows below are copy corrections and
not retractions. That stops being true with the first real signup: these are
dated for the publicity, not for today's audience of one.

| Claim, verbatim | Renders in | What would make it true | Card | Due |
|---|---|---|---|---|
| *"No dia 8 de outubro de 2026 eu mando aqui o link de acesso."* | the founders **WhatsApp welcome**, already delivered to a real recipient; `founders.confirmation.nextOpening` on `/fundadores`; the terms | **2026-09-25, reviewed:** a sender now exists — `whatsapp.founders_opening_broadcast` fans out one `send_whatsapp` per **seated** founder, rendering `founders-opening`, verified per recipient by `whatsapp.sent`/`whatsapp.dry_run` (real DB tests, not unit stubs). A dated run is queueable via `worker/scripts/schedule_founders_opening.py --commit`, deliberately a manual step nothing runs automatically. What still stands between here and 08/10: (1) **somebody must actually run that script** before 19:00 BRT on the day, or nothing fires; (2) `WHATSAPP_DELIVERY` is still unset everywhere — this PR ships it off, on purpose; (3) `worker/templates/whatsapp/founders-opening.md` is `status: draft` but carries **no** `TODO(Sci):` marker, so — unlike the e-mail (E6) — nothing in the code actually blocks it from rendering and sending exactly as written the moment the switch flips; the "draft" label is documentation only in this codebase (confirmed against `templates.py`'s own gate and `test_no_whatsapp_template_is_approved_yet`'s own docstring, "a tripwire, not a requirement"), so Sci has not technically approved the words that would ship; (4) the decision on what a **waitlisted** person receives that day is still open, no template covers it; (5) **new gap found reviewing this card:** the matching opening *e-mail* (`email/founders-opening.md`, whose own front matter says "Pairs with whatsapp/founders-opening") has no caller at all — the broadcast sweep is WhatsApp-only. Tracked as **E12** | **E5** | **08/10** |
| *"receber por e-mail e WhatsApp o aviso de abertura das vagas"* — the consent box a founder **must tick to sign up** | `consent.founders`, `consent.foundersRequired`; Annex B of the terms | **2026-09-25, reviewed:** the caller now exists — `worker/licitaqui/email.py`'s `send_email` job, enqueued in the **same transaction** as the WhatsApp job (`apps/web/lib/founders/signup.ts`'s `queued_email` CTE), re-checking `contact_consent` independently before it renders anything, verified per recipient by `email.sent`/`email.dry_run` against the real database. What still stands: (1) **resolved on 2026-09-25 by merging `main`:** `partial-footer.md` is now `status: approved` with no `TODO(Sci):` left, so `founders-welcome` and `founders-waitlist` render. The test that pinned the old state was written to fail the day it stopped being true — and it now must; (2) `email/founders-opening.md` carries a *second*, independent `TODO(Sci):` about the 08/10 price, so it stays blocked even once the footer lands; (3) `EMAIL_DELIVERY` is still unset everywhere — off on purpose; (4) nothing enqueues the opening e-mail on 08/10 at all — see **E12**, found while reviewing this card. Once the footer is approved and the switch is on, a founder who ticks the box today *would* receive `founders-welcome`/`founders-waitlist` by e-mail; the 08/10 opening e-mail is the one channel with no trigger yet | **E6** | **08/10** |
| *"você recebe o link de assinatura"* · *"Pix ou cartão, pelo checkout seguro do Asaas"* | `foundersPage.signup.note`, `faq.columns[0][0]`, `account.screen.founderNote`, `radar.landing.plans.essentialPaymentNote` | **no payment integration exists** — no Asaas code anywhere, no `subscriptions` write path, the whole `billing.*` tree renders nowhere. Distinct from E5: `founders-opening.md` carries `link_acesso`, not a payment link | **E8** | **08/10** |
| *"Sem fidelidade. Você cancela quando quiser, em um clique."* · *"aviso 3 dias antes de cada cobrança"* | the **terms of use** and `faq-cobranca.md` — a **term of the contract**, not only an advert; the landing's guarantees grid; the `/fundadores` comparison table and FAQ; the founders welcome **e-mail** | a cancel flow and a billing-reminder job. Neither exists; `app/conta/actions.ts` has no subscription write. The terms name the location — *"Conta → Plano"* — and **that screen does not exist** | **D8** | **08/10** |

## Also due 08/10 — Essencial goes on sale that day

Sci, 2026-09-25, **superseding the note that stood here earlier the same day**:
the opening and the payment both start on 08/10. A founder receives the
subscription link, subscribes to Essencial at the promotional price and pays
for it, and the features that plan advertises are what they are paying for.
The promotional price applies only while seats remain; once all 48 are taken, a
new subscriber pays the standard Essencial price.

These four were deferred that morning on the premise that Essencial was weeks
away and therefore did not gate the publicity. **That premise is gone.** On
08/10 Essencial is the thing being sold, and its card on `/` is the description
of what the money buys — which is the strictest reading CDC art. 30 has, not
the loosest.

| Claim, verbatim | Renders in | What would make it true | Card | Due |
|---|---|---|---|---|
| *"Avisos diários no Telegram, com 10 palavras-chave e as atividades do seu CNPJ"* | `plans.essential.feature2`, the Essencial card on `/` | a daily digest job. `0006_alert_limits` set `essencial` to `alert · week · 1`; the scheduler holds one `weekly_digest`. **This is D6 alive again in different words** — the guard keys on *"todo dia"* and *"diários"* walks past it | **D6** | **08/10** |
| *"Faixa em que os vencedores fecharam e preço-alvo de compra"* | `plans.essential.feature3` on `/`; `timeline.steps[3].body` promises the same for 08/10 | **not a data-depth question.** `price-view.tsx:217-227` masks band, market price and ceiling **unconditionally** — no plan check, no branch. `TenderDetail` has no field for a band, nothing reads `awards`, and `0002_plan_limits` grants `market_price` to **`pro` alone**, so Essencial resolves to zero by `readLimit`'s rule | **B8** · 08/10 half is **E9** | **08/10** |
| *"10 análises completas por mês, com trechos citados do edital"* | `plans.essential.feature4` on `/` | `deep_analysis` has quota rows and a name in a constants map. **Nothing else reads it** — no route, no handler, no job | **E10** | **08/10** |
| *"avisamos por e-mail 30 dias antes"* of the price change | six copy sites, and the **terms** | job `promo_price_change` — not a registered kind, no scheduler entry, no mail sender. Its template's front matter: *"The value may **NEVER** change before this email is confirmed as sent"* — a gate on revenue recorded only in a template | **E11** | **09/03/2027**, derived — a first charge on 08/10 puts the seventh at 08/04/2027, so the 30-day notice falls a month before it. `price-change-30-days.md`'s own `TODO(Sci)` flags that the Asaas cycle decides whether that charge lands on the change date or after, so confirm before trusting the day |

### The query that measures B8's data half

Necessary, and nowhere near sufficient — the screen masks the band
unconditionally, so a large answer still shows locked bars. Against **`neondb`**,
not a `licitaqui_test_*` database, which is a mistake that has already cost an
evening:

```sql
select count(*) filter (where awarded_items >= 3)  as com_banda,
       count(*)                                    as com_algum_award,
       sum(awarded_items)                          as itens_premiados
  from (select tender_id, count(*) as awarded_items from awards group by tender_id) t;
```

`>= 3` is the floor a median needs. Raise it rather than lower it.

## Closed

Four rows — and **two were removed from this section on 2026-09-25 after being
verified as not closed.** D6 and D7 are back above. Both had been closed on a
narrower surface than the claim occupied: the copy catalogue, while the same
promise sat in `worker/templates/` and `docs/legal/`. One of D7's instances had
already been delivered to a handset; another was approved the day *after*
closure.

That is the failure this file exists to prevent, and it happened inside the
file on its first day.

| Claim | How it was closed |
|---|---|
| *"Mandamos uma mensagem no seu WhatsApp confirmando a vaga."* | **E4**, 2026-09-24. Not by setting `WHATSAPP_DELIVERY=send` — configuration is not proof. By job `84044` writing **`whatsapp.sent`** with `status: 201` and `message_id 3EB008D19200C77C23A850`, and the message arriving on Sci's handset at 21:51 BRT |
| *"Resumo toda segunda"* — the weekly Telegram digest promised to a founder | **E7**, 2026-09-25. Not by building the path: Sci ruled that **Telegram alerts belong to people who create an account**, and a founder has only reserved a seat. So the sentence was the defect, not the missing feature. `timeline.steps[2].body` now makes the account the condition, reusing the Básico card’s already-approved clause verbatim (*"1 aviso por semana no Telegram, com 1 palavra-chave e 1 estado"*) rather than inventing terms. Every other weekly-Telegram promise in the catalogue was already account-gated — checked, this was the only one that was not. It would have come due Monday 28/09 07:00 BRT |
| Editais named as closing **30/09** in example panels | **D11b**, 2026-09-25. Two of the three named here were never defects — `opportunity` carries an as-of source line bound to `EXAMPLE_AS_OF`, and the `/fundadores` screening panel carries *"Edital publicado no PNCP em 16/09/2026"*. The one real gap was `alerts.items[0].note`, whose panel names no date at all, and it closed by **deleting the claim** rather than dating it: the note is now *"R$ 48 mil · exclusivo ME/EPP"*. An example that makes no dated claim cannot go stale |
| *"Você usa o Radar antes da abertura pública"* and its variants | **D7**, 2026-09-25 — the second attempt, after the first closed on too narrow a surface and this file had to reopen it. Closed by removing the claim from **all four** sites at once: `timeline.steps[3].body` (*"Acesso antecipado."*), `founders.confirmation.nextOpening`, `email/founders-welcome.md:24` and `whatsapp/founders-welcome.md:14`. Verified by the absence of the phrase rather than by a guard: `grep -rn "antes da abertura" apps/web/messages worker/templates` returns **0**, which is the check the original keyword guard could not make because it walked only `messages.*` |

### Why a passing guard is not closure evidence

Both guards written to hold D6 and D7 shut were defeated by a rewording, not a
regression. D6's keys on the literal **"todo dia"**; the live string says
**"Avisos diários"**. D7's requires the literal **"radar"** within 80 characters
and walks only `messages.*`, never `worker/templates/`, where two of its four
live instances are — and its doc comment exempts a key that does not exist.

A guard a synonym defeats is a guard against one phrasing. Cite it as evidence
only for the phrasing it pins.

## What this file is not

It is **not** a bug list. A defect belongs in `docs/DEVELOPMENT_PLAN.md` §5. A
row belongs here only when the product has already told somebody something.

It is **not** a copy review. The wording is Sci's under legal brief §5. This
records what a sentence commits us to and by when — never what it should say.
