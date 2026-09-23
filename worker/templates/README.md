# Message templates (Telegram, WhatsApp, email)

Owner: task **E0** (gap **G10**). Status of every file here: **draft — awaiting Sci's approval.**

These are the *outbound* message bodies sent by the worker. UI-facing copy does **not**
live here — it lives in `apps/web/messages/pt-BR.json`.

---

## 1. File layout

```
worker/templates/
  email/      one file per email    (subject + body)
  whatsapp/   one file per message  (body only, plain text)
  telegram/   one file per message  (body only, light formatting)
```

File names are English kebab-case; the copy inside is Brazilian Portuguese.
Files whose name starts with `partial-` are fragments used inside another template
(a repeated block, a shared footer) and are never sent on their own.

## 2. File format

A template is a UTF-8 Markdown file: a small **front matter** block delimited by `---`,
then the **body** after a blank line. Everything after the closing `---` is the body,
byte for byte — blank lines and line breaks are significant (WhatsApp especially).

```
---
id: founders-welcome
channel: whatsapp
status: draft
placeholders: [nome, numero_vaga, data_abertura]
---

Oi, {{nome}}! ...
```

Front matter keys:

| Key | Channels | Meaning |
|---|---|---|
| `id` | all | Unique id used by the worker to load the template. Matches the file name. |
| `channel` | all | `email`, `whatsapp` or `telegram`. |
| `subject` | email | Subject line. May contain placeholders. |
| `preheader` | email | Short line shown next to the subject in the inbox. Optional. |
| `status` | all | `draft` until Sci approves, then `approved`. |
| `placeholders` | all | Every placeholder the template expects, subject included. Inline list. |
| `partials` | all | Other template ids this one renders inside it. Optional. |
| `flags` | all | Boolean context keys used by `[[se: ...]]` blocks. Optional. |
| `notes` | all | One line for the reviewer. Optional. |

The front matter is a strict subset of YAML (flat `key: value` scalars plus one inline
list), so it parses with `yaml.safe_load` or with a ~20-line hand-rolled reader.

## 3. Placeholders

* Syntax: `{{nome}}` — double braces, no spaces inside.
* Names are **Portuguese snake_case**, to read naturally inside Portuguese copy
  (`{{numero_vaga}}`, `{{data_mudanca}}`). This is the one deliberate exception to the
  "identifiers in English" rule in `CLAUDE.md`; the worker maps them to English field
  names when it builds the context dict. Flip this if Sci prefers.
* Rendering is literal substitution. **A missing placeholder must raise**, never render
  an empty string or the raw `{{...}}` — a half-rendered price notice is a legal problem.
* Money placeholders arrive already formatted (`R$ 26,00`). Dates arrive already
  formatted in full Portuguese (`8 de outubro de 2026`) unless the template says otherwise.

### Optional blocks

One conditional construct only:

```
[[se: plano_promocional]]
...text shown only when the flag is true...
[[/se]]
```

The flag is a boolean in the render context. No loops, no `else`, no nesting — if a
message needs more than that, it becomes a separate template file.

### Repeated blocks

Lists (the tenders in a digest) are **not** looped in the template. The worker renders
the matching `partial-…-item` template once per tender, joins the results, and passes the
whole string as a single placeholder (e.g. `{{lista_editais}}`).

## 4. Channel rules

**WhatsApp** (Evolution API, spec §9 · plan G9/E2)
* Opt-in only. Every message that starts a conversation ends with the opt-out line:
  `Para não receber mais mensagens, responda SAIR.`
* Short. No tables, no headings, no Markdown. `•` bullets and line breaks only.
* Roughly one message every 20–30 s, no bulk blasts.

**Telegram** (spec §9 · plan E1)
* Light formatting allowed: `*negrito*`, `_itálico_`, links. No tables.
* Commands offered to users: `/ajuda`, `/pausar`. Nothing else is implemented — do not
  advertise commands the bot does not answer.

**Email** (Resend, spec §9 · gap G2)
* Subject + plain-text body. The worker wraps the body in the shared HTML layout; keep
  the body readable as plain text on its own.
* Every email ends with `partial-footer`.

## 5. Inventory

| File | Channel | Sent when | Milestone |
|---|---|---|---|
| `whatsapp/founders-welcome.md` | WhatsApp | right after a founder signs up and gets a seat | M1 |
| `email/founders-welcome.md` | email | idem, for founders who gave an email | M1 |
| `whatsapp/founders-waitlist.md` | WhatsApp | signup after seat 48 is gone | M1 |
| `email/founders-waitlist.md` | email | idem | M1 |
| `whatsapp/founders-opening.md` | WhatsApp | opening broadcast, 08/10 at 19:00 | M3 |
| `email/founders-opening.md` | email | idem | M3 |
| `whatsapp/optout-confirmation.md` | WhatsApp | reply to `SAIR` | M1 |
| `telegram/start-linked.md` | Telegram | `/start <token>` with a valid token | M3 |
| `telegram/start-no-token.md` | Telegram | bare `/start` | M3 |
| `telegram/start-token-invalid.md` | Telegram | expired or unknown token | M3 |
| `telegram/start-already-linked.md` | Telegram | chat already linked to that account | M3 |
| `telegram/help.md` | Telegram | `/ajuda` | M3 |
| `telegram/stop.md` | Telegram | `/pausar` | M3 |
| `telegram/weekly-digest.md` | Telegram | weekly digest job, 1+ tenders | M3 |
| `telegram/partial-digest-item.md` | Telegram | one tender inside the digest | M3 |
| `telegram/weekly-digest-empty.md` | Telegram | weekly digest job, no tenders | M3 |
| `email/weekly-digest.md` | email | weekly digest for users without Telegram | M3 |
| `email/partial-digest-item.md` | email | one tender inside the digest | M3 |
| `email/price-change-30-days.md` | email | `promo_price_change` job, 30 days before `promo_ends_on` | M5 |
| `whatsapp/price-change-30-days.md` | WhatsApp | same day, **courtesy copy only** | M5 |
| `email/payment-confirmation.md` | email | Asaas `PAYMENT_CONFIRMED` / `PAYMENT_RECEIVED` webhook | M5 |
| `email/partial-footer.md` | email | end of every email | — |

## 6. Facts the copy is allowed to state

Everything below comes from `docs/TECHNICAL_SPEC.md` §10 and `docs/DEVELOPMENT_PLAN.md`.
Nothing else may be promised.

* Plans: **Básico R$ 0** · **Promocional R$ 26/mês nos 6 primeiros meses, depois R$ 57**
  (fundadores, 48 vagas) · **Essencial R$ 57** · **Pro R$ 98**. Monthly, no lock-in.
* Básico: 5 triagens por mês, 1 alerta por semana no Telegram (1 palavra-chave, 1 estado).
* Visitor without an account: 2 triagens, editais e anexos bloqueados.
* The price change R$ 26 → R$ 57 happens on `promo_ends_on` and **only after** the
  30-day notice was sent.
* AI output always carries the "confira no edital" disclaimer.

Never state: delivery/refund promises, nota fiscal (undecided — gap **G13**), any
guarantee of winning a tender, testimonials, or numbers not in the docs above.

## 7. Open decisions left for Sci

Search the templates for `TODO(Sci):`. Every one of them is a decision this task refused
to invent (legal wording, links and addresses that do not exist yet — gaps **G3** and
**G13**). They must all be resolved before a single message goes to a real user.

## 8. Optional rows

A row that is absent for most records — the ME/EPP marker, an estimated value PNCP is
entitled to withhold — is a `[[se: …]]` block, never a placeholder the caller sets to
`""`. A blank value is a `MissingPlaceholder` by design (§3), so the empty-string shape
raises on the first record that lacks the row.

Conditionals resolve **before** substitution, so a placeholder inside a block that is
off is removed and the caller passes nothing for it. Write the block inline so it does
not leave a blank line behind:

```
Propostas até {{prazo_proposta}}
[[se: tem_meepp]]{{marcador_meepp}}
[[/se]]Ler o edital: {{link_edital}}
```

The flag guards the row; it is not a licence to pass an empty string. With the flag on,
a blank value still raises.

## 9. Optional greetings — a name we may not have

`users.name` is populated by Google sign-in and **is not collected by the e-mail
magic link**. So a real and growing share of accounts have no name at all, and
on 2026-09-23 every one of them was silently dropped from the weekly digest
*and* from the `/start` confirmation, because the worker required `{{nome}}`
before it would render either.

A name is therefore an **optional row** in the sense of §8, and takes the same
shape — with one difference worth stating, because it is easy to get wrong: the
guard wraps only the vocative, not the whole greeting.

```
Bom dia[[se: tem_nome]], {{nome}}[[/se]]. Estes são os editais…
```

renders `Bom dia, Sci.` or `Bom dia.` — both correct Portuguese, and the
sentence is unchanged in either case. Wrapping the whole line instead would
mean writing a second greeting for the nameless case, which is new copy, which
is Sci's.

**Never fill the gap with a derived name.** Not from the e-mail local part, not
from the company. Legal brief §2.2 is that the product describes itself
accurately; greeting somebody by a string we invented is the smallest version
of the thing that rule exists to stop, and the address route additionally puts
an e-mail address inside a message body, which §12 forbids.

Templates carrying this today: `telegram/weekly-digest`,
`telegram/weekly-digest-empty`, `telegram/start-linked`,
`telegram/start-already-linked`.
