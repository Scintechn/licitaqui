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
| *"No dia 8 de outubro de 2026 eu mando aqui o link de acesso."* | the founders **WhatsApp welcome**, delivered to two real recipients; `founders.confirmation.nextOpening` on `/fundadores`; the terms | **2026-09-26 — the machinery is proven; the claim is not yet true.** Everything this row listed as outstanding is done: the dated run is queued (job `103288`, `run_after` 2026-10-08 22:00 UTC = **19:00 BRT**); `WHATSAPP_DELIVERY=send` is live on the worker and proven per recipient (founder 4, `outcome: sent`, `delivery_mode: send`); Sci approved `whatsapp/founders-opening.md` (`63fc27d`); and the matching opening **e-mail** is now fanned out by the same sweep (E12). **What is missing is the delivery itself.** This sentence promises a message *on 08/10*, and closing it on a scheduled row rather than a delivered one is precisely the mistake that reopened D6 and D7. One decision still open: what a **waitlisted** person receives that day — no template covers it | **E5** | **08/10** |
| *"receber por e-mail e WhatsApp o aviso de abertura das vagas"* — the consent box a founder **must tick to sign up** | `consent.founders`, `consent.foundersRequired`; Annex B of the terms | **2026-09-26 — both channels proven end to end, per recipient.** E-mail: Resend **Delivered** to founder 4 at 08:27 UTC, message id `01a0dcd3-d2d2-76fc-bb28-1a…`, body rendered *including the footer* — which is also the proof that all three of its placeholders bind, two of them having been found unbound in production that morning. WhatsApp: `outcome: sent`, `delivery_mode: send`. It took three fixes to the **deployed worker**, none of them code: an image too old to have the `send_email` handler, then `EMAIL_DELIVERY`, then `AUTH_EMAIL_FROM`/`RESEND_API_KEY`. **The consent names the *abertura* notice specifically**, so like E5 it becomes true on 08/10 when that message lands. The transport is no longer in doubt | **E6** | **08/10** |
| *"você recebe o link de assinatura"* · *"Pix ou cartão, pelo checkout seguro do Asaas"* | `foundersPage.signup.note`, `faq.columns[0][0]`, `account.screen.founderNote`, `radar.landing.plans.essentialPaymentNote` | **no payment integration exists** — no Asaas code anywhere, no `subscriptions` write path, the whole `billing.*` tree renders nowhere. Distinct from E5: `founders-opening.md` carries `link_acesso`, not a payment link | **E8** | **08/10** |
| *"Sem fidelidade. Você cancela quando quiser, em um clique."* · *"aviso 3 dias antes de cada cobrança"* | the **terms of use** and `faq-cobranca.md` — a **term of the contract**, not only an advert; the landing's guarantees grid; the `/fundadores` comparison table and FAQ; the founders welcome **e-mail** | a cancel flow and a billing-reminder job. Neither exists; `app/conta/actions.ts` has no subscription write. The terms name the location — *"Conta → Plano"* — and **that screen does not exist** | **D8** | **08/10** |
| *"os editais abertos que combinam com o que a sua empresa já faz"* and its variants | `radar.landing.subtitle` (pt-BR.json:81), `faq` intro (:148), `radarDescription` (:623), `analyzingListBody` (:986), `telegramHelp` (:602); `worker/templates/whatsapp/founders-welcome.md:20` — **already delivered to real recipients**; `email/founders-opening.md:5,21`, queued for 08/10; `telegram/start-linked.md:12` and both weekly-digest templates | **the sentence says *os* editais abertos; we hold 44% of them.** Measured 2026-09-27 against `q=saas, status=recebendo_proposta`: 56 of the 128 in-scope editais PNCP calls open. Not a freshness gap — **none of the 72 in-scope misses is past due and 37 close within 3 days** (BRT). Cause in B17: ingestion is keyed on `dataAtualizacaoGlobal`, and 54 of the 72 were never updated after publication. **The digest templates inherit it**: "até 3 editais abertos que combinam" draws from the same table, so a week's digest can be empty or wrong while a matching edital sits open on PNCP. Closed by evidence, not by a deploy — the `saas` comparison re-run returning ≥ 122 of 128 | **B17** | **08/10** |
| *"Hoje no Brasil · [Nº] editais abertos"* — a quantified public figure | the stats strip at the foot of `/` (`lib/radar/stats.ts`), ISR, public | **the figure printed on 2026-09-27 was 13.262; PNCP's own count for the same modalities was ~25 936** (18 073 + 3 790 + 4 073). "Hoje no Brasil" claims to count Brazil and counts our cache — understating by ~2.9×. Direction matters for CDC art. 30 (this undersells rather than oversells, unlike the 204-row overstatement this same query was corrected for on 2026-09-23) but the sentence is still false, and it is the one number on the landing a visitor can check. Either B17 makes it true, or the label stops saying *no Brasil* | **B17** | **08/10** |

## Also due 08/10 — Essencial goes on sale that day

Sci, 2026-09-25, **superseding the note that stood here earlier the same day**:
the opening and the payment both start on 08/10. A founder receives the
subscription link, subscribes to Essencial at the promotional price and pays
for it, and the features that plan advertises are what they are paying for.
The promotional price applies only while seats remain; once all 25 are taken, a
new subscriber pays the standard Essencial price.

These four were deferred that morning on the premise that Essencial was weeks
away and therefore did not gate the publicity. **That premise is gone.** On
08/10 Essencial is the thing being sold, and its card on `/` is the description
of what the money buys — which is the strictest reading CDC art. 30 has, not
the loosest.

| Claim, verbatim | Renders in | What would make it true | Card | Due |
|---|---|---|---|---|
| *"Avisos **semanais** no Telegram, com 10 palavras-chave e as atividades do seu CNPJ"* | `plans.essential.feature2`, the Essencial card on `/` | **The cadence half is closed, 2026-09-29.** It read *"diários"*; `0006_alert_limits` gives `essencial` `alert · week · 1` and the scheduler holds one `weekly_digest` (Monday 07:00 BRT) with no daily job anywhere, so the word moved to the cadence that runs. Sci's decision, 2026-09-29, over building a daily job. **The keyword half is still open and is the reason this row stays.** `0002_plan_limits` grants `essencial` and `promocional` **10** keywords, and the product delivers **one**: `Preferences.keyword` is `string \| null`, the form renders a single field, `clampPreferences` reads `limits.keywords` as a boolean (`!== 0`) instead of slicing to N, and the worker selects `a.value as keyword` and matches a single `%(keyword)s`. So Essencial's alert is **identical to Básico's**, which grants 1 — the row a founder pays for differentiates nothing. The `alerts` table already holds one row per alert, so no migration: the gap is the singular read path in both the web and the worker. Sci chose to build it rather than weaken the sentence | **D6** (cadence, done) · **E18** (keywords) | **08/10** |
| *"Faixa em que os vencedores fecharam e preço-alvo de compra"* | `plans.essential.feature3` on `/`; `timeline.steps[3].body` promises the same for 08/10 | **not a data-depth question.** `price-view.tsx:217-227` masks band, market price and ceiling **unconditionally** — no plan check, no branch. `TenderDetail` has no field for a band, nothing reads `awards`, and `0002_plan_limits` grants `market_price` to **`pro` alone**, so Essencial resolves to zero by `readLimit`'s rule  **Then, 2026-09-28, three corrections while E9 was built.** The band was **gated to Essencial and above** — it had shipped open, inverting this row's own point that a subscriber sees what a visitor sees. Both qualified render sites gained a condition: `timeline.steps[3].body` *"nos editais em que já temos dados de vencedores"*, `plans.essential.feature3` *"nos editais em que já temos esses dados"*. And ***"na sua região"* was removed from two places** — `radar.landing.opportunity.body` and `foundersPage.hero.promises[2]`, **the founders hero, live 08/10** — because `comparablesForItem` joins on segment, canonical unit and description similarity, **nationwide**: no UF, no município, no region predicate of any kind. That was not a missing caveat, it was a filter that does not exist. **Three claims still stand and are listed so this row cannot close while they do**: `radar.landing.opportunity.body` says *"cada item"* at ~1% coverage; `plans.locked.priceBand` describes the band flatly inside the homepage locked block; and `radar.price.intro` promises *"o preço de mercado"*, which **no state of that screen shows to anybody** — `plan_limits` grants `market_price` to `pro` alone and the row is a permanent lock, including for Pro. | ~~**B8**~~ — **B8 is done** (measured 2026-09-28: `awards` holds 6 094 rows, CPF masking verified). The claim now belongs entirely to **E9**, rewritten the same day into a **gated** phase 1 on Sci's decision: the band appears only where the data backs it, and nothing appears where it does not. **Measured coverage at that decision: ~1% of open items** pass ≥5 comparables with a tight spread — so on 08/10 this sentence is true wherever it renders and renders almost nowhere. **That is the risk to watch**, and it is a copy question rather than a code one: `plans.essential.feature3` and `timeline.steps[3].body` state the capability unconditionally, and a founder who opens ten editais on opening night may see a band on none of them. Either the wording admits the condition, or the gate's coverage rises first (**C3**), or the row stays open. **C4** must exist before any screen quotes a confidence figure. **2026-09-30 — the coverage this row watches fell again, and on purpose.** Sci found two items on `96291141000180-1-006394/2026` whose band was built from the wrong product: item 37, a cast-iron desk punch the edital values at R$ 168,78, was priced from **nine cadernos and a roll of toilet paper** — the one real punch among its eleven comparables, at R$ 204,00, had the lowest similarity of the set and was outvoted — and the screen advised paying at most **R$ 9,35**. Item 13, a *compatível* Lexmark toner estimated at R$ 129,85, was priced from *original* cartridges at R$ 256,95–294,49, about double. **The spread gate cannot catch either and no threshold on it could**: cadernos all cost R$ 9–15, so a sample made entirely of them is *tighter* than a correct one. Measured over 103 open items in `Gráfico / Escritório` and `Informática / TI` that returned any comparables, the **median share that were even the same product was 0%**, and 65 of 103 were under half. `lib/radar/product-key.ts` now requires the comparable to be the same product and the same grade. Measured after, through the real code path: those two items keep 2 comparables each and show **no band**, the audit's `Papel Kraft` keeps none, and over one sample of **400 open items across every segment** the items keeping any comparable fall **62 → 14** while the items showing a band are **0 → 0** — bands are already rare enough that 400 items find none either way, which is itself the finding. A 250-item sample of the two busiest segments found 4 before and 0 after. So the sentence is true wherever it renders and **renders even more rarely than the ~1% this row already called the risk to watch**. Nothing about the copy changed and nothing needed to: *"nos editais em que já temos esses dados"* still covers it. What changed is the size of the gap between the sentence and the experience, and **C3 is now load-bearing for this feature existing at all** rather than for it being good. **2026-10-02 — E22 narrows the gap this row watches, by an order of magnitude, without touching the sentence.** The screen no longer has one answer below the gate: measured 2026-10-01 over 600 open items after the awards backfill (priced corpus 5 408 → 23 448), **11.17%** have at least one past winner of the same product against **0.67%** that show a band, so the ladder says something true on roughly **17× as many items** as the band does. That does not make *"cada item"* true — 11.17% is not every item — so claim 1 of the three above **stands**; what changes is that a founder opening ten editais on 08/10 now has a real chance of seeing evidence on one or two rather than almost certainly none. Two further things this row should carry. **The band stays Essencial and is now enforced where it is computed**: Sci ruled on 2026-10-02 that above `MIN_SAMPLE` the individual prices are withheld too, because four sampled prices rebuild the band (the quartiles of five sorted values are `sorted[1..3]`), so `plans.essential.feature3` remains true as written — a non-subscriber sees the count and what was matched, never a winner's price. And **`radar.price.noDataHelp` is now shown only below five editais**, because it promises the faixa at five or more while `MAX_SPREAD` must also pass; see the new row below | **08/10** |
| *"10 análises completas por mês, com trechos citados do edital"* | `plans.essential.feature4` on `/` | `deep_analysis` has quota rows and a name in a constants map. **Nothing else reads it** — no route, no handler, no job | **E10** | **08/10** |
| *"avisamos por e-mail 30 dias antes"* of the price change | six copy sites, and the **terms** | job `promo_price_change` — not a registered kind, no scheduler entry, no mail sender. Its template's front matter: *"The value may **NEVER** change before this email is confirmed as sent"* — a gate on revenue recorded only in a template | **E11** | **~09/12/2026**, and it moved three months closer. The promo is now **3** months, not 6: someone subscribing on 08/10 is charged R$ 57 on 08/10, 08/11 and 08/12, so the first R$ 75 charge is 08/01/2027 and the 30-day notice is due on or before **09/12/2026**. **This is a planning marker, not the date** — `promo_ends_on` is per subscriber, so the real one is `promo_ends_on − 30 days` for each founder. The consequence that matters: **F3 has to be in production before 09/12/2026**, and the plan still schedules it at M5, which is after |

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
| *"Mostramos a faixa quando encontramos pelo menos 5 editais encerrados com o mesmo produto. Neste item encontramos N."* | `radar.price.evidenceHelp`, the thin rungs of the price screen (E22) | **Five editais is necessary and not sufficient, so the sentence is true only where it is now shown.** `priceBand` also requires `MAX_SPREAD` — the inter-quartile spread within half the median — so an item with six scattered editais clears the count and still gets no faixa. Rendered unconditionally, that reads *"Mostramos a faixa quando encontramos pelo menos 5 editais… Neste item encontramos 6"* directly above no faixa: the sentence contradicting the screen it sits on. It is reachable, not hypothetical — measured 2026-10-01, **0.83%** of open items reach five editais and **0.67%** show a band, so roughly **one in five of the items that reach the floor fails on spread**. **Mitigated in code, not in copy**: `price-view.tsx` renders it only where `editais < MIN_SAMPLE`, which is where it is true. What is left is a **silence**, not a false sentence — at six scattered editais the reader sees the count and the results with no explanation of why there is no faixa, and the honest version of that needs a sentence about the prices disagreeing with each other. **That wording is Sci's** (legal brief §5); nothing was invented in its place. Closes when he writes it, or stays a known silence | **E22** | — (silence, not a false claim) |

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
