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

## Open

| Claim, verbatim | Renders in | What would make it true | Card | Due |
|---|---|---|---|---|
| *"No dia 8 de outubro de 2026 eu mando aqui o link de acesso."* | the founders **WhatsApp welcome**, already delivered to a real recipient; `founders.confirmation.nextOpening` on `/fundadores`; the terms | **2026-09-25, reviewed:** a sender now exists — `whatsapp.founders_opening_broadcast` fans out one `send_whatsapp` per **seated** founder, rendering `founders-opening`, verified per recipient by `whatsapp.sent`/`whatsapp.dry_run` (real DB tests, not unit stubs). A dated run is queueable via `worker/scripts/schedule_founders_opening.py --commit`, deliberately a manual step nothing runs automatically. What still stands between here and 08/10: (1) **somebody must actually run that script** before 19:00 BRT on the day, or nothing fires; (2) `WHATSAPP_DELIVERY` is still unset everywhere — this PR ships it off, on purpose; (3) `worker/templates/whatsapp/founders-opening.md` is `status: draft` but carries **no** `TODO(Sci):` marker, so — unlike the e-mail (E6) — nothing in the code actually blocks it from rendering and sending exactly as written the moment the switch flips; the "draft" label is documentation only in this codebase (confirmed against `templates.py`'s own gate and `test_no_whatsapp_template_is_approved_yet`'s own docstring, "a tripwire, not a requirement"), so Sci has not technically approved the words that would ship; (4) the decision on what a **waitlisted** person receives that day is still open, no template covers it; (5) **new gap found reviewing this card:** the matching opening *e-mail* (`email/founders-opening.md`, whose own front matter says "Pairs with whatsapp/founders-opening") has no caller at all — the broadcast sweep is WhatsApp-only. Tracked as **E7** | **E5** | **08/10** |
| *"Sem fidelidade. Você cancela quando quiser, em um clique."* · *"aviso 3 dias antes de cada cobrança"* | the comparison table on `/fundadores`; the **founders welcome e-mail** (approved 2026-09-25) | a cancel flow under `app/conta` and a billing-reminder job. Neither exists. Escalated when the e-mail was approved: a page can be corrected after the fact, a delivered e-mail cannot | **D8** | **08/10** |
| *"receber por e-mail e WhatsApp o aviso de abertura das vagas"* — the consent box a founder **must tick to sign up** | `consent.founders`, `consent.foundersRequired`; Annex B of the terms | **2026-09-25, reviewed:** the caller now exists — `worker/licitaqui/email.py`'s `send_email` job, enqueued in the **same transaction** as the WhatsApp job (`apps/web/lib/founders/signup.ts`'s `queued_email` CTE), re-checking `contact_consent` independently before it renders anything, verified per recipient by `email.sent`/`email.dry_run` against the real database. What still stands: (1) `worker/templates/email/partial-footer.md` — appended to every founders e-mail — is still `status: draft` with two literal `TODO(Sci):` lines in its body, so `founders-welcome`, `founders-waitlist` and `founders-opening` all raise `TemplateNotApproved` and **cannot render at all** today (proven by a test that pins this exact fact and is meant to fail the day it stops being true); the approved version of this footer is in PR #117, not yet merged into this work; (2) `email/founders-opening.md` carries a *second*, independent `TODO(Sci):` about the 08/10 price, so it stays blocked even once the footer lands; (3) `EMAIL_DELIVERY` is still unset everywhere — off on purpose; (4) nothing enqueues the opening e-mail on 08/10 at all — see **E7**, found while reviewing this card. Once the footer is approved and the switch is on, a founder who ticks the box today *would* receive `founders-welcome`/`founders-waitlist` by e-mail; the 08/10 opening e-mail is the one channel with no trigger yet | **E6** | **08/10** |
| *"Saiba quanto pagar para manter sua margem."* | `foundersPage.timeline.steps[3]`, from 2026-09-25 | enough awarded items for a band to mean anything. `price-view.tsx` **deliberately masks** the winner band today: *"an invented range would be a lie about a real purchase"*. `sync_awards` is collecting and is in the live scheduler — this is a **data-depth** question, not a UI one. See the query below | **B8** | **08/10** |
| The Landing example names three editais that closed on 30/09 | `radar.landing.alerts.items`, `radar.landing.opportunity.*` | real PNCP rows for three current editais, and Sci's approval for the three strings that name them. The example's *clock* was fixed separately (D11); *which* editais it shows was not | **D11b** | before the example reads as stale |

### The query that settles B8

Neither an agent nor CI has production credentials. Run this in the Neon SQL
editor against **`neondb`** — not one of the `licitaqui_test_*` databases,
which is a mistake that has already cost an evening:

```sql
-- How many editais have enough awarded items for a band to mean anything?
select count(*) filter (where awarded_items >= 3)  as com_banda,
       count(*)                                    as com_algum_award,
       sum(awarded_items)                          as itens_premiados
  from (
    select tender_id, count(*) as awarded_items
      from awards
     group by tender_id
  ) t;
```

`>= 3` is the floor a median needs before it describes anything; raise it
rather than lower it. If `com_banda` is small, the honest move on 08/10 is to
change the sentence, not to show a band built from two data points.

---

## Closed

Kept, because the evidence that closed them is the standard for closing a row.

| Claim | How it was closed |
|---|---|
| *"Mandamos uma mensagem no seu WhatsApp confirmando a vaga."* | **E4**, 2026-09-24. Not by setting `WHATSAPP_DELIVERY=send` — configuration is not proof. By job `84044` writing **`whatsapp.sent`** with `status: 201` and `message_id 3EB008D19200C77C23A850`, and the message arriving on Sci's handset at 21:51 BRT |
| *"toda semana no Básico, todo dia no Essencial"* | **D6**. No daily job existed and `plan_limits` entitled no paid plan to alerts at all. Migration `0006_alert_limits` gave every paid plan `alert · week · 1`, and the copy was changed to the cadence that runs. A guard in `lib/messages.test.ts` fails the build if any string promises faster |
| *"Você usa o Radar antes da abertura pública."* | **D7**. The Radar is public now — no account, two free triagens. The benefit was replaced with the price range, which is what the founder price actually unlocks, in the price screen's own approved wording |

---

## What this file is not

It is **not** a bug list. A defect belongs in `docs/DEVELOPMENT_PLAN.md` §5. A
row belongs here only when the product has already told somebody something.

It is **not** a copy review. The wording is Sci's under legal brief §5. This
records what a sentence commits us to and by when — never what it should say.
