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

| Claim, verbatim | Renders in | What would make it true | Card | Due |
|---|---|---|---|---|
| *"Resumo toda segunda"* · *"Até 3 editais que combinam com você, já triados, no Telegram"* | `foundersPage.timeline.steps[2]` and `founderValue.benefits[1].body`, both on `/fundadores` | **A founder cannot receive this.** `telegram_alerts.py`'s `ELIGIBLE_SQL` requires a `users` row, a linked `telegram_links` row **and** an `alerts` row. A founder has none, nothing in the funnel asks them to link Telegram, and `founders_list` is never read by that file | **E7** | **overdue** — the first Monday it describes is 28/09 07:00 BRT |
| *"No dia 8 de outubro de 2026 eu mando aqui o link de acesso."* | the founders **WhatsApp welcome, already on a real handset**; `hero.badge` and `timeline.steps[3].when` on `/fundadores`; the terms | a sender for `whatsapp/founders-opening.md` — exists, still `status: draft`, **rendered by no code path**. `ScheduleEntry` cannot express a one-off dated run today. And `email/founders-waitlist.md` already promises waitlisted people the same link, with no template addressing them | **E5** | **08/10** |
| *"receber por e-mail e WhatsApp o aviso de abertura das vagas"* — the box a founder **must tick** (`z.literal(true)`) | `consent.founders`, `consent.foundersRequired`; **Annex B of the terms** | a caller for the three approved templates. Transport is proven (Resend, via the magic link) — **except** all three declare `partials: [partial-footer]`, and that partial is `status: draft` with two literal `TODO(Sci):` lines **in its body**. Until it is written, a real send renders TODOs to the recipient | **E6** | **08/10** |
| *"você recebe o link de assinatura"* · *"Pix ou cartão, pelo checkout seguro do Asaas"* | `foundersPage.signup.note`, `faq.columns[0][0]`, `account.screen.founderNote`, `radar.landing.plans.essentialPaymentNote` | **no payment integration exists** — no Asaas code anywhere, no `subscriptions` write path, the whole `billing.*` tree renders nowhere. Distinct from E5: `founders-opening.md` carries `link_acesso`, not a payment link | **E8** | **08/10** |
| *"Sem fidelidade. Você cancela quando quiser, em um clique."* · *"aviso 3 dias antes de cada cobrança"* | the **terms of use** and `faq-cobranca.md` — a **term of the contract**, not only an advert; the landing's guarantees grid; the `/fundadores` comparison table and FAQ; the founders welcome **e-mail** | a cancel flow and a billing-reminder job. Neither exists; `app/conta/actions.ts` has no subscription write. The terms name the location — *"Conta → Plano"* — and **that screen does not exist** | **D8** | **08/10** |
| Three editais named as closing **30/09**, as literal strings with no clock | `radar.landing.opportunity.deadlineValue`/`deadlineNote`, `radar.landing.alerts.items[0].note`, and `foundersPage.screening.buyer` — *"sessão 30/09 às 08:30"*, **on the page that takes the money** | D11 unfroze the clock on the `ExampleRadar` panel **only**. These three are hardcoded, and `alerts.items[0]` carries no as-of date at all | **D11b** | **30/09** |
| *"Você usa o Radar antes da abertura pública"* and its variants | `founders.confirmation.nextOpening`; `timeline.steps[3].body` (*"Acesso antecipado"*, added 2026-09-25); `whatsapp/founders-welcome.md`, **delivered to a handset**; `email/founders-welcome.md`, approved **the day after D7 was closed** | the Radar is public now. D7 changed one benefit string and closed on a guard that requires the literal word *"radar"* and walks only `messages.*` | **D7** | with the publicity |

## Due when the Essencial plan goes on sale

Sci, 2026-09-25: Essencial is weeks away, so these do not gate the founders
publicity — but they are advertised on the public landing **today**.

| Claim, verbatim | Renders in | What would make it true | Card | Due |
|---|---|---|---|---|
| *"Avisos diários no Telegram, com 10 palavras-chave e as atividades do seu CNPJ"* | `plans.essential.feature2`, the Essencial card on `/` | a daily digest job. `0006_alert_limits` set `essencial` to `alert · week · 1`; the scheduler holds one `weekly_digest`. **This is D6 alive again in different words** — the guard keys on *"todo dia"* and *"diários"* walks past it | **D6** | Essencial on sale |
| *"Faixa em que os vencedores fecharam e preço-alvo de compra"* | `plans.essential.feature3` on `/`; `timeline.steps[3].body` promises the same for 08/10 | **not a data-depth question.** `price-view.tsx:217-227` masks band, market price and ceiling **unconditionally** — no plan check, no branch. `TenderDetail` has no field for a band, nothing reads `awards`, and `0002_plan_limits` grants `market_price` to **`pro` alone**, so Essencial resolves to zero by `readLimit`'s rule | **B8** · 08/10 half is **E9** | Essencial on sale |
| *"10 análises completas por mês, com trechos citados do edital"* | `plans.essential.feature4` on `/` | `deep_analysis` has quota rows and a name in a constants map. **Nothing else reads it** — no route, no handler, no job | **E10** | Essencial on sale |
| *"avisamos por e-mail 30 dias antes"* of the price change | six copy sites, and the **terms** | job `promo_price_change` — not a registered kind, no scheduler entry, no mail sender. Its template's front matter: *"The value may **NEVER** change before this email is confirmed as sent"* — a gate on revenue recorded only in a template | **E11** | gates the first price change |

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

One row — and **two were removed from this section on 2026-09-25 after being
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
