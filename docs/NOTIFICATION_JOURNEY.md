# The notification journey — how a person knows where they stand

**v0.1 · 2026-09-23 · English.** Three journeys that end in a message — magic-link sign-in, Telegram linking, the weekly digest — mapped state by state, with what the user sees **in the app** and **in the channel** at each one. Written the afternoon before founders week, from four defects found in production on 2026-09-23.

Read this before touching `/conta/criar`, `/conta/alertas`, `apps/web/lib/auth/`, `apps/web/app/api/telegram/webhook/`, `worker/licitaqui/telegram_alerts.py` or `worker/templates/`.

Status: **draft**. Every Portuguese string in §7 needs Sci's approval before it ships (legal brief §5).

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

**Two more things this mapping turned up, neither of them reported:**

- **The magic-link e-mail is Auth.js's built-in English template.** No `sendVerificationRequest` is overridden (`apps/web/lib/auth/index.ts:68`), so `@auth/core` sends subject `Sign in to ${host}` — *"Sign in to www.licitaquiapp.com.br"* — with an English body and no reply-to. Brief §1 requires a reply-to of `contato@`. The product's very first message to a Brazilian user is in English and unbranded, and the link lives **24 hours** (`maxAge: 24 * 60 * 60`), which no screen tells anyone.
- **Nothing sends a Telegram message unless `TELEGRAM_DELIVERY=send`.** Unset is `dry_run` (`worker/licitaqui/telegram.py:182-190`), and a dry run is deliberately counted as *completed*: it consumes the weekly quota and writes `alert_deliveries` rows, so the tenders it did not send are excluded from next week's digest. A dry-run founders week and a delivered founders week look identical in every number except `telegram.sent` vs `telegram.dry_run`. **Confirm the variable before Thursday.**

## 2. The rule that follows

The product has states a person cannot observe. That is the defect class; the four above are instances of it.

**A confirmation that exists only on a web page the user has already left is not a confirmation.** The two rules that follow are the whole of this document:

1. **Success is confirmed in the channel that was being set up.** When Telegram linking works, the place to say so is Telegram. When a magic link works, the proof is that the browser is signed in — so it must land somewhere that shows it, not on an error page.
2. **Failure is reported in the channel that still works.** When Telegram does not answer, the web page must say so, because Telegram is precisely what is not working. When an e-mail does not arrive, the page that sent it is the only place left to say what to do next.

A corollary, from defects 3 and 4: **a notification nobody can audit is a notification nobody can debug.** `telegram.skipped` with a stable reason string is exactly right, and it is why defect 3 was findable at all. The other two journeys have no equivalent — see §9.

And one prohibition, from defect 3: **never invent a name for a nameless user.** Not "prezado cliente", not "olá!", not the local part of the e-mail address, not the company name standing in for a person. Either the greeting carries a real name or the greeting has no name in it. The mechanism that gets a name onto an account is the fix lane's decision; the copy rule is not negotiable.

## 3. How to read the tables

Each journey below is a table of states. The four columns are:

- **In the system** — what is true in the database and the queue.
- **In the app** — what the person sees on a LicitaQui screen at that moment.
- **In the channel** — what the person sees in Telegram or in their inbox.
- **Recovery** — what they do if the state is wrong, without writing to support.

A cell that says **nothing** is a finding, not a description. Rows marked 🔴 are broken today, 🟡 are correct but unobservable, and unmarked rows work.

Every string named in a table is a `messages/pt-BR.json` key or a `worker/templates/` id that exists today. Strings that do not exist yet are drafted in §7 under a code (`MJ-`, `TG-`, `DG-`) and **all of them wait on Sci**.

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
| **B11 · Unlinked from the app, or the bot blocked** | `unlinkChat()` deletes the row; a blocked send calls `pause()` | `telegram.screen.paused` / the connect card | nothing, in both cases | `telegram.screen.resume`, or reconnect |

**The rule this journey breaks:** B5 and B6 are the app claiming success in one channel for something that only happened in the other. `"Telegram conectado"` is true about `telegram_links` and false about the thing the person cares about, which is whether the bot talks to them.

**The smallest fix that closes both:** the app must not call it connected until the confirmation was actually delivered — and must say so plainly when it was not (§7, `TG-2`). The delivery is already recorded: `telegram.sent` with `template = start-linked`. The page has something to read; it just does not read it.

**And B6 needs the greeting to stop requiring a name** (§7, `TG-1`). Which mechanism supplies the name is the fix lane's call; what the greeting must not do is invent one.

## 6. Journey C — The weekly digest

**Trigger:** the `weekly_digest` sweep, Monday 07:00 BRT (spec §7.1 `weekly_alerts`). The sweep enqueues one `send_telegram` per eligible account and sends nothing itself (`telegram_alerts.py:875-889`).
**Eligibility** is a join, not a check: linked chat + active weekly Telegram alert + a CNPJ on the account (`ELIGIBLE_SQL`, `telegram_alerts.py:314-330`). A person who fails it is never enqueued, so **no skip is recorded for them at all**.

| State | In the system | In the app | In the channel | Recovery |
|---|---|---|---|---|
| **C1 · Not eligible** 🟡 | not swept; **no event** | `/conta/alertas` shows the connect card, or `telegram.screen.needsCnpj` | — | Connect, or add the CNPJ |
| **C2 · Swept** | `jobs` row, key `digest:<user>:<ISO week>` | nothing | — | — |
| **C3 · Sent** | `telegram.sent` + `alert_sent`; `alert_deliveries` rows | nothing | `weekly-digest` — up to 3 tenders | — |
| **C4 · Sent, empty week** | same, template `weekly-digest-empty` | nothing | *"Esta semana não apareceu nenhum edital aberto…"* — **correct: the bot proves it is alive** | — |
| **C5 · Dry run** 🔴 | `telegram.dry_run`; **quota consumed and `alert_deliveries` written** | nothing | **nothing** | none. Indistinguishable from C3 to everyone except an admin reading event names |
| **C6 · `no_recipient`** 🟡 | `RECIPIENT_SQL` returns no row | nothing | nothing | none |
| **C7 · `not_linked`** 🟡 | no `chat_id` at send time — unlinked between sweep and send | `telegram.connect.*` | nothing | Reconnect |
| **C8 · `paused`** 🟡 | `alerts.active` false at send time | `telegram.screen.paused` — **this one the app does show** | nothing | `telegram.screen.resume` |
| **C9 · `no_company`, real** 🟡 | no CNPJ on the account | `telegram.screen.needsCnpj` | nothing | Add the CNPJ |
| **C10 · `no_company`, actually no name (defects 3 + 4)** 🔴 | `users.name` null → same reason string | **nothing — the app says everything is fine** | nothing, **every week, forever** | none |
| **C11 · `quota_reached`** 🟡 | Básico is 1/week from `plan_limits` | nothing | nothing | — (correct behaviour, invisible) |
| **C12 · `not_in_plan`** 🟡 | an explicit `alert` row of 0 | nothing | nothing | Upgrade — if they knew |
| **C13 · Failed send** 🟡 | `telegram.failed` with the API reason; retried if retryable; **blocked → `pause()`** | `telegram.screen.paused`, with no reason | nothing | Reconnect from the site |

**What is right here and should be copied:** every one of C5–C13 writes an `events` row with a stable reason string (`telegram_alerts.py:903-919`). That is the only reason defect 3 was diagnosable. Journeys A and B have nothing like it.

**What is wrong:** ten of the thirteen states are invisible to the person they happen to. The digest is the one journey where a user has genuinely no way to tell "nothing matched this week" from "we have been failing to send to you since you signed up" — and C4 exists precisely to answer that question, so the machinery is already half built.

**The smallest thing that closes it:** `/conta/alertas` says when the last digest went out, or says why it did not (§7, `DG-1`). One query against `events`, four sentences, no new table.

**And `no_company` must stop naming the wrong field.** That is the fix lane's change, not this document's, but the registry note is: the reason string reaches `events.props` and a dashboard groups by it, so a new reason is additive — add it, leave the history alone.

## 7. Strings — drafts for Sci

**All of these need Sci's approval (legal brief §5).** They are product copy, not legal wording. The framing rules in brief §2.2 bind every one: no promise of delivery we cannot keep — agencies publish late, PNCP flaps, Telegram can block a bot. The precedent for the shape is `TENDER_STATUS_AND_WATCH.md` §2: *"quando o órgão publica no PNCP"*, never *"avisamos sempre que…"*.

### The magic-link e-mail (new — today it is Auth.js's English default)

**`MJ-1` — subject.** Two options, because the choice is genuinely open:

| Option | String | Trade-off |
|---|---|---|
| a | `Seu link de acesso à LicitaQui` | Says what is inside. Reads like every other transactional e-mail, which is good for trust and bad for the inbox list |
| b | `Entrar na LicitaQui` | Shorter, matches the button they just pressed. Slightly more phishing-shaped out of context |

Recommendation: **a**.

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

Reply-to must be `contato@` (brief §1). It is not set today.

**`MJ-3` — `account.signIn.sentBody`, revised** so the card answers the three questions the current one leaves open (where, how long, which device):

> Enviamos um link de acesso para {email}. Ele vale por 24 horas e entra na sua conta no aparelho em que você abrir. Se não chegar em alguns minutos, olhe o spam.

**`MJ-4` — expired or already used** (new keys; today both land on the generic error):

> **`account.signIn.expiredTitle`** · Este link não vale mais
> **`account.signIn.expiredBody`** · Links de acesso valem por 24 horas e funcionam uma vez só. Peça outro aqui embaixo — leva alguns segundos.

**`MJ-5` — `account.signIn.resend`** · `Enviar outro link`

### Telegram

**`TG-1` — the greeting without a name.** The rule is §2's prohibition; the copy question is what replaces `{{nome}}`. Two options:

| Option | Opening line of `start-linked` | Trade-off |
|---|---|---|
| a | `Pronto! Sua conta da LicitaQui está ligada a esta conversa.` | Works for everybody, ships today, loses the personal touch E0 wrote for |
| b | Keep `Pronto, {{nome}}.` and ask for the name once, on first sign-in | Keeps the warmth; adds a screen and a decision to founders week |

Recommendation: **a for tomorrow, b later if Sci wants it.** The same applies to `weekly-digest`, `weekly-digest-empty` and `start-already-linked`, which carry the same `{{nome}}`. Note `{{nome_empresa}}` already has a fallback that cannot be blank — `company_label()` falls back to the formatted CNPJ (`telegram_alerts.py:245-263`). The name has no such fallback, and must not be given a fabricated one.

**`TG-2` — the app admitting the confirmation did not arrive.** New keys on `/conta/alertas`:

> **`telegram.connected.confirmPending`** · Conectamos a sua conta. Estamos mandando uma mensagem de confirmação na conversa com o {bot}.
> **`telegram.connected.confirmDone`** · Tudo certo: a confirmação chegou na sua conversa com o {bot}.
> **`telegram.connected.confirmFailed`** · A conexão está feita, mas a mensagem de confirmação não chegou ao Telegram. Os avisos podem não chegar também. Toque em "{recheck}" ou fale com a gente em contato@licitaquiapp.com.br.

`confirmFailed` is the rule of §2 in one string: Telegram is what is broken, so the web page is where it gets said.

### The digest

**`DG-1` — the last digest, on `/conta/alertas`.** One line, read from `events`:

> **`telegram.screen.lastSent`** · Último aviso enviado em {data}.
> **`telegram.screen.lastNone`** · Ainda não enviamos nenhum aviso por aqui.
> **`telegram.screen.lastQuota`** · Você já recebeu o aviso desta semana. No plano gratuito é 1 por semana.
> **`telegram.screen.lastBlocked`** · Não conseguimos montar o seu aviso desta semana. Fale com a gente em contato@licitaquiapp.com.br e a gente resolve.

`lastBlocked` is deliberately vague about the cause: the causes it covers (`no_recipient`, a missing name) are ours, not the user's, and telling them to fix something they cannot fix is worse than telling them to write to us. `needsCnpj` and `paused` already exist for the two causes they *can* fix.

### One existing string to review under §2.2

`telegram.connect.body` — *"Uma vez por semana, o robô da LicitaQui manda até 3 editais abertos que combinam com o que a sua empresa faz."* This is a schedule promise, and `weekly-digest-empty` does make it broadly true. It still reads as a guarantee of delivery through a channel a third party controls. A softer variant, if Sci wants one:

> Toda segunda de manhã o robô manda aqui até 3 editais abertos que combinam com o que a sua empresa faz.

Naming the day is a fact about our schedule; "uma vez por semana" sounds like a commitment about their inbox. Sci's call — this is a flag, not a change.

## 8. What we would not build before Thursday

A simple journey that ships tomorrow beats a complete one that does not. Everything here is deliberately **later**, with the reason:

| Not building | Why, and when it comes back |
|---|---|
| Resend webhooks for bounces and complaints | A new endpoint, a new table and a new failure mode, the week of the launch. Until then a bounce is invisible — accepted. Revisit when e-mail carries billing (F4, M5), where silence is a contractual problem |
| Open tracking on the magic-link e-mail | Pixel tracking is a privacy-policy change (privacy §9 processor list). Not worth it to learn something the sign-in event already tells us |
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
2. **The delivery mode on screen.** `TELEGRAM_DELIVERY` is the difference between a launch and a silent launch.
3. **Two magic-link events** — `magic_link_requested` on submit, and a sign-in event that fires on every sign-in, not only the first — which is exactly the counter Sci asked for. Adding names to the catalogue is an edit to a file task O1 owns; coordinate rather than collide.
4. **A tagged link in the digest** (`?de=digest`) that stamps `alert_deliveries.opened_at`, so the Gate 0 open rate stops being unmeasurable. Cheapest of the four, and the one a gate depends on.

## 10. Open questions — Sci's, recorded rather than waited on

1. **Where does a name come from?** Google supplies one; the Resend provider does not; `/conta` has no field for it. Ask once at sign-in, or drop `{{nome}}` from the templates (§7 `TG-1`)? The fix lane owns the mechanism; this document only rules out inventing one.
2. **Is `TELEGRAM_DELIVERY=send` set in the production worker?** If not, founders week sends nothing and burns every user's weekly quota doing it.
3. **Magic-link e-mail:** approve `MJ-1`/`MJ-2`, and confirm reply-to `contato@` (brief §1) — neither exists today.
4. **Should the app say "Telegram conectado" before the bot has answered?** §2 says no; changing it is a visible product change on launch eve, so it is Sci's call.
5. **`telegram.connect.body`** under §2.2 — flag, with a variant offered in §7.
6. **Open rate:** accept a tagged digest link to make Gate 0 measurable, or accept the gate is unmeasurable for now?
7. **Does a blocked-bot auto-pause need to tell the user anything?** Today `pause()` is silent and the only surviving channel is e-mail, which we do not use for this. Probably fine; worth a decision rather than a default.

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
