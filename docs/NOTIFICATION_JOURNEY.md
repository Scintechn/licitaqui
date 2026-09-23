# The notification journey — how a person knows where they stand

**v1.0 · 2026-09-23 · English.** Three journeys that end in a message — magic-link sign-in, Telegram linking, the weekly digest — mapped state by state, with what the user sees **in the app** and **in the channel** at each one. Written the afternoon before founders week, from four defects found in production on 2026-09-23.

Read this before touching `/conta/criar`, `/conta/alertas`, `apps/web/lib/auth/`, `apps/web/app/api/telegram/webhook/`, `worker/licitaqui/telegram_alerts.py` or `worker/templates/`.

Status: **reviewed by Sci on 2026-09-23**. Every decision he took is recorded in §10 and every string in §7 is marked approved — **do not re-open either**; if something here looks wrong, it changed after the review and the change is what needs the argument.

---

## 1. What happened — the evidence

Four defects, all verified in production on 2026-09-23, all being fixed in a parallel lane. They are listed here because they are not four bugs; they are one bug seen four times.

| # | What the system did | What the person experienced |
|---|---|---|
| 1 | The magic-link e-mail was sent; the redirect back was malformed | A screen with no confirmation on it. **It looked broken and it had worked.** |
| 2 | `telegram_links.chat_id` was written; the confirmation job died | The web page said *"Telegram conectado"*; the bot said nothing |
| 3 | The weekly digest skipped every magic-link user | No message, no explanation, anywhere |
| 4 | That skip was recorded as `no_company` | The company was fine — the field that was empty was `users.name` |

**Defect 1 is one `?` too many.** The sign-in page is also the verify-request page, and it is registered with a query string already on it (`apps/web/lib/auth/index.ts:86-89`):

```ts
verifyRequest: `${ACCOUNT_CREATE_PATH}?enviado=1`,   // '/conta/criar?enviado=1'
```

`@auth/core`'s `verifyRequest()` appends the incoming search string to that value without checking whether one is already there, so the browser is sent to `/conta/criar?enviado=1?provider=resend&type=email`. `enviado` then parses as `"1?provider=resend"`, `page.tsx:52` compares it to `'1'`, and `sent` is false: the person lands back on the bare sign-in form with **no "Link enviado" card at all** — identical to the request having silently failed. The e-mail was already on its way.

This is the sharpest instance of §2's rule in the codebase. The confirmation exists, is written, is translated, and renders on a condition that a stray `?` makes permanently false.

**Defect 2 is wider than linking.** It has an exact cause, and it explains defect 4 as well. The web route enqueues the reply in camelCase:

```ts
// apps/web/app/api/telegram/webhook/route.ts:190
return { template: 'start-linked', userId: outcome.userId }
```

and the worker reads it in snake_case:

```python
# worker/licitaqui/telegram_alerts.py:859-862
user_id = ctx.payload.get("user_id")
chat_id = ctx.payload.get("chat_id")
if user_id is None and chat_id is None:
    raise ValueError("send_telegram payload needs a 'user_id' or a 'chat_id'")
```

`template` matches on both sides, so the job passes the first check and dies on the second — four times, over forty minutes, then `failed`. And because it raises **before** `send()`, it writes no `telegram.skipped`, no `telegram.failed`, no event of any kind. The only trace of a person who linked and heard nothing is a row in `jobs`.

Two things make this worse than it looks. **The contract was written down and then contradicted in the same repository** — `apps/web/lib/jobs/index.ts:57-58` documents the payload as `{template, user_id | chat_id}`, snake_case, while the `Reply` type twelve files away is camelCase. And **every reply the bot owes anybody goes through this path**: `/start`, `/ajuda` and `/pausar` alike (`route.ts:143-157`). A user who types `/pausar` gets silence, and has no way to know the pause took effect — it did; `alerts.active` is set before the reply is enqueued.

The weekly digest is **not** affected: the worker enqueues its own jobs in snake_case (`telegram_alerts.py:842-846`). The break is only where the web hands work to the worker.

Defect 3 and 4 are one line:

```python
# worker/licitaqui/telegram_alerts.py:660-666
given = first_name(name)
if not given or not company_name:
    raise DigestSkipped(SKIP_NO_COMPANY)
```

A blank `users.name` raises the reason named after the *company*. `users.name` is nullable (`db/migrations/0001_initial.sql:156`), Google supplies one, the Resend provider does not, and there is no field anywhere in `/conta` that lets a person type one. So every magic-link account is permanently unsendable, filed under a reason that points at the wrong field.

**This is not confined to the digest.** Every Telegram template that greets somebody needs `{{nome}}`: `start-linked`, `start-already-linked`, `weekly-digest`, `weekly-digest-empty`. `build_reply_context` raises the same `no_company` for the *linking confirmation* (`telegram_alerts.py:686-689`). Fixing the payload in defect 2 does not deliver a confirmation to a nameless account; it just moves the silence one step later.

**One more thing this mapping turned up, not reported:** the magic-link e-mail is **Auth.js's built-in English template**. No `sendVerificationRequest` is overridden (`apps/web/lib/auth/index.ts:68`), so `@auth/core` sends subject `Sign in to ${host}` — *"Sign in to www.licitaquiapp.com.br"* — with an English body and no reply-to. Brief §1 requires a reply-to of `contato@`. The product's very first message to a Brazilian user is in English, from a sender they do not recognise, and the link lives **24 hours** (`maxAge: 24 * 60 * 60`), which no screen tells anyone. Sci's verdict: *"phishing-shaped"* — §10.3.

### 1.1 `TELEGRAM_DELIVERY` — not an item, a go/no-go

This one is separated from the defects above because it is not a defect and not a backlog entry. It is the switch that decides whether founders week happened.

Nothing reaches Telegram unless `TELEGRAM_DELIVERY=send`. Unset is `dry_run` (`worker/licitaqui/telegram.py:182-190`), and a dry run is deliberately counted as *completed* (`Delivery.completed`, `telegram_alerts.py:479-501`). Sci, on what that costs:

> *"If it is unset on Thursday, nobody receives anything, the system records success, it burns every user's weekly quota, and it writes `alert_deliveries` — so the tenders it did not send are excluded from the following week's digest. Week one is silent and week two is degraded, with nothing anywhere looking wrong."*

The second half is the part worth naming, because it puts this in a different category from the rest of the document. **A silent failure that also poisons the next cycle is not the same animal as one that merely loses a message.** Everything else here costs one notification; this one costs the notification, the quota that would have allowed a retry, and the three tenders that will now never be offered again — `alert_deliveries` is the ledger that stops the digest repeating itself, and a dry run writes to it in good faith. There is no recovery path in the product for a week that was recorded as delivered.

**Verified set on 2026-09-23** — `TELEGRAM_DELIVERY=send`, alongside `WHATSAPP_DELIVERY=send`. Founders week is go.

**And the rule that follows, which is Sci's:** *"a variable that decides whether a launch happened belongs on a screen."* The delivery mode goes on `/admin` (§9). Checking it by hand once is not a control; it is a thing someone remembered to do.

## 2. The rule that follows

The product has states a person cannot observe. That is the defect class; the four above are instances of it.

**A confirmation that exists only on a web page the user has already left is not a confirmation.** The two rules that follow are the whole of this document:

1. **Success is confirmed in the channel that was being set up.** When Telegram linking works, the place to say so is Telegram. When a magic link works, the proof is that the browser is signed in — so it must land somewhere that shows it, not on an error page.
2. **Failure is reported in the channel that still works.** When Telegram does not answer, the web page must say so, because Telegram is precisely what is not working. When an e-mail does not arrive, the page that sent it is the only place left to say what to do next.

A corollary, from defects 3 and 4: **a notification nobody can audit is a notification nobody can debug.** `telegram.skipped` with a stable reason string is exactly right, and it is why defect 3 was findable at all. The other two journeys have no equivalent — see §9.

And one prohibition, from defect 3: **never invent a name for a nameless user.** Not "prezado cliente", not "olá!", not the local part of the e-mail address, not the company name standing in for a person. Either the greeting carries a real name or the greeting has no name in it. The mechanism that gets a name onto an account is the fix lane's decision; the copy rule is not negotiable.

### 2.1 Which of these to fix first — time to discover, not severity

Sci's ruling on the order, and it is a better organising idea than the one this document was first written with, so it is recorded here to outlive the week:

> *"Severity is the wrong axis; time-to-discover is the right one. Magic link: the person retries in 30 seconds and recovers alone. Digest: the person believes it works for weeks and cannot find out. Same observability defect, costs three orders of magnitude apart."*

Severity asks how bad one occurrence is. Time-to-discover asks how long the user goes on being wrong about the state of the world — and that is the quantity this document is actually about, because an unobservable state is precisely one the user cannot end. A loud failure is self-limiting: the person sees it, retries, and either succeeds or gives up knowing they gave up. A silent one accumulates.

**The order, worst first:**

| Rank | State | How long before the user can know | Why it ranks here |
|---|---|---|---|
| 1 | **C10** — digest skipped for a missing name | **Never.** No message, no screen, no difference from a quiet week | The user has no way to distinguish "nothing matched" from "you have been unreachable since you signed up". C4 exists to answer that question and never fires for them |
| 2 | **C5** — the whole digest in dry run | **Never**, and it compounds (§1.1) | Same blindness, multiplied by every user at once, and it consumes the quota and the ledger on its way past |
| 3 | **B5 / B6** — the linking confirmation never arrives | Weeks — until the first digest that also does not arrive | The app actively asserts the opposite (*"Telegram conectado"*), so the user's belief is not merely unconfirmed, it is wrong and was put there by us |
| 4 | **A1** — no "Link enviado" card | **~30 seconds.** They submit again | Annoying, self-correcting, and the person stays in control the whole time |
| 5 | **The English e-mail** | Immediate | Ugly and trust-damaging on sight, which is exactly why it is not the worst: nothing about it is hidden |

Note what this reorders. The English e-mail and the broken confirmation card are the two a person would *notice first in a demo*, and they rank last. The digest skip is invisible in every demo that has ever been run and ranks first. **That inversion is the point:** a defect's visibility to us and its cost to the user run in opposite directions, and severity-ordering quietly optimises for the former.

The document keeps its journey-by-journey shape below, because that is how someone implementing or testing one flow needs to read it. This is the order to fix in, not the order to read in.

## 3. How to read the tables

Each journey below is a table of states. The four columns are:

- **In the system** — what is true in the database and the queue.
- **In the app** — what the person sees on a LicitaQui screen at that moment.
- **In the channel** — what the person sees in Telegram or in their inbox.
- **Recovery** — what they do if the state is wrong, without writing to support.

A cell that says **nothing** is a finding, not a description. Rows marked 🔴 are broken today, 🟡 are correct but unobservable, and unmarked rows work.

Every string named in a table is a `messages/pt-BR.json` key or a `worker/templates/` id that exists today. Strings that do not exist yet are drafted in §7 under a code (`MJ-`, `TG-`, `DG-`) and are **approved by Sci as of 2026-09-23** — §7 marks each one.

## 4. Journey A — Sign in by magic link

**Trigger:** `/conta/criar`, e-mail field, `account.signIn.emailSubmit` — *"Receber link de acesso"*.
**Parts:** Auth.js Resend provider, `verification_token`, `sessions`, `/conta/criar` as sign-in page, error page and verify-request page (`apps/web/lib/auth/index.ts:86-89`).

| State | In the system | In the app | In the channel | Recovery |
|---|---|---|---|---|
| **A1 · Link requested (defect 1)** 🔴 | `verification_token` row written, valid 24 h; Resend accepts | **Nothing.** The double `?` makes `enviado` parse as `"1?provider=resend"`, so `account.signIn.sentTitle` / `sentBody` — *"Link enviado / Abra o seu e-mail…"* — never renders. The bare form comes back | — | Submit again, and get a second link they also are not told about |
| **A2 · E-mail delivered** 🔴 | Resend has it; nothing records delivery | unchanged | **English**: *"Sign in to www.licitaquiapp.com.br"*, Auth.js's default body, no reply-to | Read it anyway, or give up |
| **A3 · Link clicked, same browser** | `verification_token` deleted, `sessions` row written | Lands signed in | — | — |
| **A4 · Link clicked in the mail app's browser** 🟡 | Sign-in **succeeds** — in that webview | The desktop browser is still signed out and says nothing about it | — | Open the link again on the device they want; the token is gone, so: ask for a new one |
| **A5 · Link expired (> 24 h)** 🔴 | Token past `expires`; Auth.js redirects to the error page | `?error=…` → `account.signIn.errorTitle` / `errorBody`: *"Não deu para entrar / Alguma coisa falhou no caminho de volta. Tente de novo."* | — | Ask for another link — but the screen never says that is what is wrong |
| **A6 · Link already used** 🔴 | Row deleted on first use; indistinguishable from expired | same generic error | — | same |
| **A7 · Resend refuses the address** 🔴 | `sendVerificationRequest` throws; no token survives | `?error=EmailSignin` → the same generic *"Não deu para entrar"* | — | Try again, with no idea the address was the problem |

**What this journey is missing, in one line:** one message for four different situations (A5, A6, A7 and a genuine server fault), and — at A1 — no message at all for the one situation that worked.

**The smallest thing that would have prevented defect 1:** the confirmation not depending on a query parameter that something else is free to append to. Whether that is a fixed `verifyRequest` path, a distinct route, or reading the flag differently is the fix lane's call; the requirement is that asking for a link always produces a screen that says a link was sent.

**Second smallest:** the sign-in page distinguishing *"your link is no longer valid"* (A5, A6 — ask for another) from *"something failed on our side"* (A7). Same screen, one more branch.

**Simple, and worth doing before Thursday:** a Portuguese magic-link e-mail (§7, `MJ-1`/`MJ-2`), the address and the 24-hour lifetime on the "link enviado" card (`MJ-3`), and a distinct expired/used message (`MJ-4`). Nothing else.

## 5. Journey B — Link Telegram

**Trigger:** `/conta/alertas`, `telegram.connect.cta` — *"Conectar o Telegram"*.
**Parts:** 15-minute signed token (`apps/web/lib/telegram/config.ts`, `TOKEN_TTL_SECONDS`), `t.me/<bot>?start=<token>`, `POST /api/telegram/webhook`, `telegram_links`, `send_telegram` job, `worker/templates/telegram/start-*.md`.

E3 already shipped the app-side waiting states (`telegram.handoff.*`, merged in #52). This table records what they cover and where the journey still goes quiet.

| State | In the system | In the app | In the channel | Recovery |
|---|---|---|---|---|
| **B1 · Invited** | nothing yet | `telegram.connect.*` — what it is and what it sends | — | — |
| **B2 · Token minted, waiting for Iniciar** | `telegram_links.start_token` set, `chat_id` null, 15 min | `telegram.handoff.waitingTitle` / `waitingBody`, `validFor`, and **`telegram.handoff.recheck`** — *"Já toquei em Iniciar, verificar"* | The bot chat opens with an Iniciar button | Tap Iniciar; or re-check |
| **B3 · Returning chat — Iniciar never appears** | token still unused | `telegram.handoff.manualTitle` / `manualBody`: the exact `/start <token>` message to paste | The chat opens on old history, nothing is sent | Paste the message the app gives them. **E3's symptom is covered; its cause is not proven** — `handoff.ts:21-28` records that nothing in the repo demonstrates the first-ever-conversation theory, so the hand-off screen is a recovery path, not a diagnosis |
| **B4 · Linked** | `chat_id` written, `alerts` row ensured, `telegram_linked` event, reply job enqueued | `telegram.connected.title` — *"Telegram conectado"* | should be `start-linked` | — |
| **B5 · Confirmation dies (defect 2)** 🔴 | job raises `ValueError` ×4 → `failed`; **no event of any kind** | still says *"Telegram conectado"* — it has no idea | **nothing** | none. This is the state Sci described |
| **B6 · Confirmation skipped, no name** 🔴 | `build_reply_context` raises `DigestSkipped("no_company")`; `telegram.skipped` written | still says *"Telegram conectado"* | **nothing** | none — and it repeats every week in Journey C |
| **B7 · Token expired or already used** | `verifyToken` fails | `telegram.handoff.failedTitle` / `failedBody` + `newLink` | `start-token-invalid` — *"Esse link de conexão não vale mais."* | Generate another; **this branch is correct today** |
| **B8 · Already linked** | `userForChat` finds the chat | *"Telegram conectado"* | `start-already-linked` | — |
| **B9 · Chat belongs to another account** 🟡 | `telegram_links.chat_id` is **unique** (`0001_initial.sql:253`); the link cannot be written | the generic `telegram.errors.generic` | `start-token-invalid`, which is not the reason | Unlink on the other account — which they may not know they have |
| **B10 · Paused by `/pausar`** 🔴 | `alerts.active = false` — **the pause works**; the `stop.md` reply dies in the same `ValueError` as B5 | `telegram.screen.paused`, if they go and look | **nothing** — the bot appears to ignore the command it obeyed | none; typing `/pausar` again changes nothing and says nothing |
| **B11 · Unlinked from the app, or the bot blocked** | `unlinkChat()` deletes the row; a blocked send calls `pause()` | `telegram.screen.paused` / the connect card — **`TG-3` adds the reason for the blocked case (§10.7)** | nothing, in both cases | `telegram.screen.resume`, or reconnect |

**The rule this journey breaks:** B5 and B6 are the app claiming success in one channel for something that only happened in the other. `"Telegram conectado"` is true about `telegram_links` and false about the thing the person cares about, which is whether the bot talks to them.

**The smallest fix that closes both:** the app must not call it connected until the confirmation was actually delivered — and must say so plainly when it was not (§7, `TG-2`; **ruled and approved, §10.4**). The delivery is already recorded: `telegram.sent` with `template = start-linked`. The page has something to read; it just does not read it.

**And B6 needs the greeting to stop requiring a name** (§7, `TG-1`; **decided, §10.1 — the placeholder comes out permanently**). What the greeting must never do is invent one.

## 6. Journey C — The weekly digest

**Trigger:** the `weekly_digest` sweep, Monday 07:00 BRT (spec §7.1 `weekly_alerts`). The sweep enqueues one `send_telegram` per eligible account and sends nothing itself (`telegram_alerts.py:875-889`).
**Eligibility** is a join, not a check: linked chat + active weekly Telegram alert + a CNPJ on the account (`ELIGIBLE_SQL`, `telegram_alerts.py:314-330`). A person who fails it is never enqueued, so **no skip is recorded for them at all**.

| State | In the system | In the app | In the channel | Recovery |
|---|---|---|---|---|
| **C1 · Not eligible** 🟡 | not swept; **no event** | `/conta/alertas` shows the connect card, or `telegram.screen.needsCnpj` | — | Connect, or add the CNPJ |
| **C2 · Swept** | `jobs` row, key `digest:<user>:<ISO week>` | nothing | — | — |
| **C3 · Sent** | `telegram.sent` + `alert_sent`; `alert_deliveries` rows | nothing | `weekly-digest` — up to 3 tenders | — |
| **C4 · Sent, empty week** | same, template `weekly-digest-empty` | nothing | *"Esta semana não apareceu nenhum edital aberto…"* — **correct: the bot proves it is alive** | — |
| **C5 · Dry run** 🔴 | `telegram.dry_run`; **quota consumed and `alert_deliveries` written** | nothing | **nothing** | none. Indistinguishable from C3 to everyone except an admin reading event names. **Ranked 2nd in §2.1; go/no-go in §1.1** |
| **C6 · `no_recipient`** 🟡 | `RECIPIENT_SQL` returns no row | nothing | nothing | none |
| **C7 · `not_linked`** 🟡 | no `chat_id` at send time — unlinked between sweep and send | `telegram.connect.*` | nothing | Reconnect |
| **C8 · `paused`** 🟡 | `alerts.active` false at send time | `telegram.screen.paused` — **this one the app does show** | nothing | `telegram.screen.resume` |
| **C9 · `no_company`, real** 🟡 | no CNPJ on the account | `telegram.screen.needsCnpj` | nothing | Add the CNPJ |
| **C10 · `no_company`, actually no name (defects 3 + 4)** 🔴 | `users.name` null → same reason string | **nothing — the app says everything is fine** | nothing, **every week, forever** | none. **The worst state in this document — §2.1 ranks it 1st, and §10.1 decides it** |
| **C11 · `quota_reached`** 🟡 | Básico is 1/week from `plan_limits` | nothing | nothing | — (correct behaviour, invisible) |
| **C12 · `not_in_plan`** 🟡 | an explicit `alert` row of 0 | nothing | nothing | Upgrade — if they knew |
| **C13 · Failed send** 🟡 | `telegram.failed` with the API reason; retried if retryable; **blocked → `pause()`** | `telegram.screen.paused`, with no reason — **§10.7 rules it must say why (`TG-3`)** | nothing, correctly: the channel is what failed | Reconnect from the site |

**What is right here and should be copied:** every one of C5–C13 writes an `events` row with a stable reason string (`telegram_alerts.py:903-919`). That is the only reason defect 3 was diagnosable. Journeys A and B have nothing like it.

**What is wrong:** ten of the thirteen states are invisible to the person they happen to. The digest is the one journey where a user has genuinely no way to tell "nothing matched this week" from "we have been failing to send to you since you signed up" — and C4 exists precisely to answer that question, so the machinery is already half built.

**The smallest thing that closes it:** `/conta/alertas` says when the last digest went out, or says why it did not (§7, `DG-1`). One query against `events`, four sentences, no new table.

**And `no_company` must stop naming the wrong field.** That is the fix lane's change, not this document's, but the registry note is: the reason string reaches `events.props` and a dashboard groups by it, so a new reason is additive — add it, leave the history alone.

## 7. Strings — **approved by Sci on 2026-09-23**

Every string below is approved as written and may ship. They are product copy, not legal wording (brief §5), and the framing rules in brief §2.2 bind every one: no promise of delivery we cannot keep — agencies publish late, PNCP flaps, Telegram can block a bot. The precedent for the shape is `TENDER_STATUS_AND_WATCH.md` §2: *"quando o órgão publica no PNCP"*, never *"avisamos sempre que…"*.

Where a choice was offered, the approved option is marked **✅ approved** and the rejected one is kept so nobody re-proposes it. **Do not re-open these.**

### The magic-link e-mail (new — today it is Auth.js's English default)

**`MJ-1` — subject.** Option **a** approved.

| Option | String | Verdict |
|---|---|---|
| a | `Seu link de acesso à LicitaQui` | **✅ approved 2026-09-23** — says what is inside |
| b | `Entrar na LicitaQui` | Not taken: more phishing-shaped out of context, which is the exact failure mode being fixed |

**`MJ-2` — body.** Plain text, no images, and it must name the site that sent it:

> **Entrar na LicitaQui**
>
> Você pediu um link de acesso em licitaquiapp.com.br. É só clicar no botão abaixo — não precisa de senha.
>
> [Entrar na LicitaQui]
>
> O link vale por 24 horas e funciona uma vez só. Ele entra na sua conta no aparelho em que você abrir.
>
> Se não foi você que pediu, pode ignorar este e-mail: nada acontece.
>
> Dúvida ou problema: contato@licitaquiapp.com.br

**✅ approved 2026-09-23, as drafted.** Reply-to must be `contato@` (brief §1) — not set today, and part of the same change. **Ships before Thursday**: Sci's reason is that *"the first message the product ever sends is currently in English, from an unknown sender, phishing-shaped"* (§10.3).

**`MJ-3` — `account.signIn.sentBody`, revised** so the card answers the three questions the current one leaves open (where, how long, which device):

> Enviamos um link de acesso para {email}. Ele vale por 24 horas e entra na sua conta no aparelho em que você abrir. Se não chegar em alguns minutos, olhe o spam.

**✅ approved 2026-09-23.**

**`MJ-4` — expired or already used** (new keys; today both land on the generic error):

> **`account.signIn.expiredTitle`** · Este link não vale mais
> **`account.signIn.expiredBody`** · Links de acesso valem por 24 horas e funcionam uma vez só. Peça outro aqui embaixo — leva alguns segundos.

**✅ approved 2026-09-23.**

**`MJ-5` — `account.signIn.resend`** · `Enviar outro link` — **✅ approved 2026-09-23.**

### Telegram

**`TG-1` — the greeting without a name.** The rule is §2's prohibition; the copy question is what replaces `{{nome}}`. Two options:

| Option | Opening line of `start-linked` | Verdict |
|---|---|---|
| a | `Pronto! Sua conta da LicitaQui está ligada a esta conversa.` | **✅ approved 2026-09-23 — permanently, not just for this week** |
| b | Keep `Pronto, {{nome}}.` and ask for the name once, on first sign-in | **Rejected.** A name field at sign-in is friction at the highest-drop-off moment in the product. See §10.1 — and note option b is *moot*, not merely declined: the name arrives by another route |

**No `{{nome}}` in any template, and no name field at sign-in.** The same applies to `weekly-digest`, `weekly-digest-empty` and `start-already-linked`, which carry the same `{{nome}}`. Note `{{nome_empresa}}` already has a fallback that cannot be blank — `company_label()` falls back to the formatted CNPJ (`telegram_alerts.py:245-263`). The name has no such fallback, and must not be given a fabricated one.

**`TG-2` — the app admitting the confirmation did not arrive.** New keys on `/conta/alertas`:

> **`telegram.connected.confirmPending`** · Conectamos a sua conta. Estamos mandando uma mensagem de confirmação na conversa com o {bot}.
> **`telegram.connected.confirmDone`** · Tudo certo: a confirmação chegou na sua conversa com o {bot}.
> **`telegram.connected.confirmFailed`** · A conexão está feita, mas a mensagem de confirmação não chegou ao Telegram. Os avisos podem não chegar também. Toque em "{recheck}" ou fale com a gente em contato@licitaquiapp.com.br.

**✅ approved 2026-09-23, as drafted — and shipping even on launch eve.** Sci: *"Claiming success in the channel that is not the one being set up is the defect this whole document is about."* `confirmFailed` is the rule of §2 in one string: Telegram is what is broken, so the web page is where it gets said.

**`TG-3` — the bot was blocked or the chat deleted.** Sci ruled (§10.7) that the auto-pause must say why, **on `/conta/alertas`, reusing `confirmFailed`'s shape, and with no e-mail about it**. The wording follows TG-2's approved pattern:

> **`telegram.screen.pausedBlocked`** · Paramos os avisos porque o robô não consegue mais falar com você no Telegram — normalmente é porque a conversa foi apagada ou o robô foi bloqueado. Reabra a conversa e conecte de novo aqui.

*The shape, the channel and the no-e-mail rule are Sci's ruling; this exact sentence is the one string in §7 he has not read. It follows an approved pattern, so it is not a re-open — but if one string here gets a second look, it is this one.*

### The digest

**`DG-1` — the last digest, on `/conta/alertas`.** One line, read from `events`:

> **`telegram.screen.lastSent`** · Último aviso enviado em {data}.
> **`telegram.screen.lastNone`** · Ainda não enviamos nenhum aviso por aqui.
> **`telegram.screen.lastQuota`** · Você já recebeu o aviso desta semana. No plano gratuito é 1 por semana.
> **`telegram.screen.lastBlocked`** · Não conseguimos montar o seu aviso desta semana. Fale com a gente em contato@licitaquiapp.com.br e a gente resolve.

**✅ approved 2026-09-23, all four lines as drafted.** `lastBlocked` is deliberately vague about the cause: the causes it covers (`no_recipient`, a missing name) are ours, not the user's, and telling them to fix something they cannot fix is worse than telling them to write to us. `needsCnpj` and `paused` already exist for the two causes they *can* fix.

### `telegram.connect.body` — changed, and the reasoning was overruled

**✅ approved 2026-09-23.** The new string:

> Toda segunda de manhã o robô manda aqui até 3 editais abertos que combinam com o que a sua empresa faz.

replacing *"Uma vez por semana, o robô da LicitaQui manda até 3 editais abertos…"*.

This document originally offered the variant as the *more cautious* option under §2.2. **Sci overruled that reasoning, and his is better:**

> Naming the day is better for the user, not less cautious, because **a concrete expectation is what lets someone notice that something broke.** "Uma vez por semana" is vague enough for silence to pass unnoticed for a month.

That is the whole document's argument turned on its own copy, and it is right. An expectation a person can check — *Monday morning* — converts a silent failure into one they can report; a vague one is indistinguishable from an unlucky week, which is exactly the trap C10 sets. Where §2.2 bites is a promise about **the world** we do not control ("avisamos sempre que um edital é suspenso" — the agency decides when it publishes). Monday morning is a claim about **our own schedule**, which we do control, so the caution was misapplied. No remaining objection.

## 8. What we would not build before Thursday

A simple journey that ships tomorrow beats a complete one that does not. Everything here is deliberately **later**, with the reason:

| Not building | Why, and when it comes back |
|---|---|
| Resend webhooks for bounces and complaints | A new endpoint, a new table and a new failure mode, the week of the launch. Until then a bounce is invisible — accepted. Revisit when e-mail carries billing (F4, M5), where silence is a contractual problem |
| Open tracking on the magic-link e-mail | Pixel tracking is a privacy-policy change (privacy §9 processor list). Not worth it to learn something the sign-in event already tells us. Note the contrast with §10.6: a **URL parameter** on a digest link triggers none of that, which is why that one is being built and this one is not |
| A notification preferences centre | `/conta/alertas` already pauses and resumes. A centre is a screen for settings that do not exist yet |
| WhatsApp as a confirmation channel | E2 exists, but the Evolution API risks a number ban and needs opt-in consent (spec §9). A second unreliable channel does not make the first one observable |
| An in-app notification inbox | Solves a problem nobody has: these journeys each end in exactly one message |
| Renaming `no_company` in existing `events` rows | A data migration of history to fix a label. Add the correct reason going forward; leave what happened alone |
| Retry-the-digest button in `/admin` | The sweep is idempotent per ISO week, so a retry needs a deliberate override. Worth having; not worth designing tomorrow |
| Per-state e-mail templates for Telegram failures | The web page is the right place to report a Telegram failure (§2). An e-mail about a Telegram problem is a third channel to keep honest |

## 9. Auditing it — what `/admin` needs

Sci's test is: *"12 people asked for a link this week, 11 signed in"*, without opening a database client. Today that question **cannot be answered**, and it is worth being precise about why.

**What already exists.** `events (user_id, visitor_id, name, props, created_at)` with an index on `(name, created_at)` (`0001_initial.sql:341-350`); a closed catalogue in `apps/web/lib/events/index.ts`; `/admin` with the six Gate 0 cards (`apps/web/lib/admin/gates.ts`). The digest already writes `telegram.sent`, `telegram.dry_run`, `telegram.skipped` (with `reason`), `telegram.failed` and `alert_sent`. The webhook writes `telegram_linked`.

One caveat about that catalogue, worth knowing before anyone builds a card on it: **it binds only the web.** `lib/events/index.ts` exists because "one misspelled `name` and a gate reads zero forever", but the worker inserts into `events` with raw SQL (`telegram_alerts.py:892-900`) and is not checked against it. Hence two naming conventions in one table — `telegram_linked` from the web, `telegram.skipped` from the worker. Not worth fixing this week; worth knowing when writing the `group by`.

**What is missing, by journey:**

| Journey | Question | Answerable today | What it needs |
|---|---|---|---|
| Magic link | how many asked for a link | **no** | one event on submit — `magic_link_requested` |
| Magic link | how many signed in | **partly** | `account_created` fires only on the **first** sign-in, and `lib/auth/index.ts:116-119` says so on purpose. A return sign-in writes nothing, so the funnel has no denominator after week one |
| Magic link | how many links were never opened | **no** | requested − signed in, over the same 24-hour window |
| Telegram | how many started linking | **no** | an event when a token is minted; `telegram_linked` is only the success |
| Telegram | how many got their confirmation | **yes, unused** | `telegram.sent` where `props->>'template' = 'start-linked'`. Nobody renders it |
| Telegram | how many confirmations died before `send()` | **no** | defect 2 wrote nothing. A `jobs` failure count by kind would have caught it |
| Digest | why the sweep skipped people | **yes, unused** | `select props->>'reason', count(*) from events where name='telegram.skipped'` — the data is there; `/admin` does not show it |
| Digest | did anything actually go out | **yes, unused** | `telegram.sent` vs `telegram.dry_run`. Without this on screen, a dry-run week looks like a delivered week |
| Digest | open rate — **Gate 0, ≥ 50%** | **no** | `gates.ts:141-148` reads `alert_deliveries.opened_at`, and **nothing in the codebase ever writes it**. The gate reads 0 forever |

**The minimum, in the order it pays off:**

1. **One card, "Avisos da semana"**, grouping `telegram.*` events by name and `telegram.skipped` by `reason`. Zero new writes — it is a `group by` over rows that already exist, and it would have shown defect 3 on the first Monday.
2. **The delivery mode on screen — Sci's rule, not a suggestion:** *"a variable that decides whether a launch happened belongs on a screen."* It is currently correct (§1.1, verified 2026-09-23), which is exactly when to put it on `/admin` — a value nobody can see is one nobody notices changing.
3. **Two magic-link events** — `magic_link_requested` on submit, and a sign-in event that fires on every sign-in, not only the first — which is exactly the counter Sci asked for. Adding names to the catalogue is an edit to a file task O1 owns; coordinate rather than collide.
4. **A tagged link in the digest** (`?de=digest`) that stamps `alert_deliveries.opened_at`, so the Gate 0 open rate stops being unmeasurable. **Decided 2026-09-23 (§10.6):** a URL parameter is not a tracking pixel, so this needs no privacy-policy change — which is what had made the alternative (open tracking on e-mail, §8) not worth it.

## 10. Decisions — taken by Sci on 2026-09-23

These were open questions when this document was written. They are not open now. **Recorded so the next reader does not re-ask**, which is Sci's explicit instruction; the fix lane is building against the same rulings.

**10.1 · Where a name comes from — option (a), permanently.**
**No `{{nome}}` in any template, and no name field at sign-in.** A name field at account creation is friction at the highest-drop-off moment in the product, and the greeting is not worth it. The `{{nome}}` placeholder comes out of `start-linked`, `start-already-linked`, `weekly-digest` and `weekly-digest-empty`; `{{nome_empresa}}` stays, because it already has a fallback that cannot be blank (`company_label()` → formatted CNPJ).

A correction to this document's own framing, from Sci and verified: **`founders_list` already carries names from the Offer form** — so the name need not be asked for at all. But **that table is empty today (0 rows)**, so a one-off backfill would do nothing. The right shape is **a link at account creation, matched on e-mail**: when an account is created, if the address is on the founders list, take the name from there. That makes option (b) — asking at sign-in — *moot rather than rejected on taste*, which is the stronger reason and the one to remember.

Until that link exists, the templates must render without a name, and §2's prohibition stands regardless: **never invent one.**

**10.2 · `TELEGRAM_DELIVERY` — go/no-go, and it is go.** Verified set to `send` on 2026-09-23 alongside `WHATSAPP_DELIVERY=send`. Promoted out of the findings list into §1.1, because a switch that decides whether a launch happened is not a backlog item. The compounding second-week cost is recorded there. The mode goes on `/admin` (§9).

**10.3 · The magic-link e-mail — ship before Thursday.** `MJ-1` option (a), `MJ-2` as drafted, reply-to `contato@` per brief §1. Sci: *"the first message the product ever sends is currently in English, from an unknown sender, phishing-shaped."*

**10.4 · "Telegram conectado" before the bot has answered — change it.** `TG-2` as drafted, on launch eve, accepting the risk of a visible change late. Sci: *"Claiming success in the channel that is not the one being set up is the defect this whole document is about."*

**10.5 · `telegram.connect.body` — changed, and this document's reasoning overruled.** Naming the day is *better* for the user, not more cautious: a concrete expectation is what lets someone notice that something broke. Full argument and this document's concession in §7.

**10.6 · Open rate — build the tagged digest link (`?de=digest`).** A URL parameter is not a tracking pixel, so no privacy-policy change is triggered. Gate 0's ≥ 50% becomes measurable instead of reading 0 forever.

**10.7 · Blocked-bot auto-pause — the app says why.** On `/conta/alertas`, reusing `confirmFailed`'s shape (`TG-3` in §7). **No e-mail** — an e-mail about a Telegram problem is a third channel to keep honest (§8), and the person is already coming back to the site to reconnect.

### Still genuinely open

Nothing that blocks Thursday. Two things this document deliberately does not decide, both because they belong to code and not to copy:

- **The new skip reason that replaces `no_company` for a missing name.** The fix lane owns the name; §6 records only that it must be additive — the string reaches `events.props` and a dashboard groups by it, so add the new reason and leave history alone.
- **How the `founders_list` → account name link is implemented** (§10.1) — matched on e-mail at account creation, but when and where is the fix lane's.

## 11. Where this is written down

| Document | What it says |
|---|---|
| `legal/LEGAL_AND_BILLING_BRIEF.md` §2.2 | The framing rules every drafted string here obeys |
| `legal/LEGAL_AND_BILLING_BRIEF.md` §5 | Product copy is draftable for approval; legal wording is not ours |
| `TECHNICAL_SPEC.md` §7.1 | `weekly_alerts` Monday 07:00 BRT, and the job table |
| `TECHNICAL_SPEC.md` §9 | Resend, Telegram Bot API and their cautions |
| `TECHNICAL_SPEC.md` §14 | The `events` catalogue and the `/admin` gate queries |
| `DEVELOPMENT_PLAN.md` §5 | Cards **U2** (magic link on), **E1** (Telegram + digest), **E3** (the linking journey), **E0** (the texts), **O1/O2** (`/admin`) |
| `TENDER_STATUS_AND_WATCH.md` §2 | The precedent for how a delivery promise is phrased |
| this file | the four defects, the three journeys, and the strings waiting on Sci |
