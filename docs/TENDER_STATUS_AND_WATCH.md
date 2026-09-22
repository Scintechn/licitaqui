# Tender status and watching a tender

**v1.0 · 2026-09-22 · English.** Why the status of a tender is a first-class state of the product, what the PNCP API actually gives us, and the two pieces of work that follow (**B9**, now, and **B10**, v1).

Read this before touching the Radar list, the Opportunity screen, any AI result screen, or the collector's refresh cadence.

---

## 1. What happened — the evidence

On 2026-09-22 the live Opportunity screen rendered a real tender from HOSPITAL UNIVERSITÁRIO PEDRO ERNESTO (Rio de Janeiro/RJ, Pregão Eletrônico, proposals 04/09 → 22/09 09:59) like this:

- **"último dia"** as the headline metric, with "restantes" beneath it
- **"✓ Ainda dá tempo: último dia até o fim das propostas"** in the why-list
- **COMPATÍVEL** badge at the top
- and, as the tenth row of the "Operação" block, in the same styling as every other row: **Situação: Suspensa**

The product was telling the user to hurry on a tender the agency had stopped. "Ainda dá tempo" is not a matter of tone — it is a factual claim about the world, and on a suspended tender it is false. This is the class of defect brief §2.2 exists to prevent, which is why rule 6 was added there.

**The design error is one sentence:** status was treated as an attribute of the tender when it is a state of the screen. It governs what may be displayed above it.

## 2. What the PNCP API gives us

There is **no impugnação endpoint**. The PNCP publishes what the agency divulges; challenges, appeals and their answers are not structured data. What is available, and what we already collect:

**a) `situacaoCompraId` / `situacaoCompraNome`** — the domain table has four values:

| Code | Name | Meaning |
|---|---|---|
| 1 | Divulgada no PNCP | normal, the only state where urgency copy is allowed |
| 2 | Revogada | the agency closed the process; final |
| 3 | Anulada | the agency annulled the process; final |
| 4 | Suspensa | stopped, **may resume with new dates** — often the visible effect of an accepted impugnação |

Our 575 cached payloads carry `situacaoCompraId` on 95 compras and only ever value 1, because every POC query filtered for open tenders. The field was always there; we had simply never observed a transition. The live screen above proves the value 4 reaches us in production.

There is also item-level status (`situacaoCompraItemNome`: Homologado, Em andamento, Fracassado, Deserto — 8 861 rows in cache). Do not confuse the two: an item can be fracassado inside a perfectly normal tender.

**b) New or changed files.** Retificação, errata, aviso de suspensão and the answer to an impugnação arrive as documents on `/arquivos`. **`tipoDocumento` is useless for detecting them** — in our cache 446 of 700+ documents are classified "Outros Documentos". Detection has to use the file **title** (retificação, errata, suspensão, impugnação, adiamento, republicação, aviso) plus the fact that the file is new relative to the cached version.

**c) Dates moving.** `dataAberturaProposta` and `dataEncerramentoProposta` being pushed out, and `dataAtualizacaoGlobal` advancing. A postponement is the most common symptom of a retificação and the most expensive one for the user, who prepared for a date that no longer exists.

**Caveat that must reach the copy:** many agencies update the PNCP late or not at all — a suspension may live first in the origin portal (Comprasnet, BLL, BBMNet) or in the official gazette. We therefore say "quando o órgão publica no PNCP" and never "avisamos sempre que um edital é suspenso".

## 3. B9 — status as a first-class state (do this now)

Applies to the Radar list, the Opportunity screen and every AI result screen for the same tender.

1. **Banner, above the title,** whenever `situacaoCompraId != 1`, in the attention colour: *"Edital SUSPENSO pelo órgão em [data da última atualização]. Os prazos abaixo podem mudar."* For 2 and 3 use REVOGADO / ANULADO and say the agency closed the process — those are final; suspensão is not.
2. **Suppress every urgency element** while status != 1: no "último dia", no "restantes", no countdown, and the "ainda dá tempo" item drops out of the why-list. The deadline block's label becomes **"Prazo suspenso"**, keeping the original date visible but muted, labelled "data anterior".
3. **Status chip** beside COMPATÍVEL, in the badge row and in the Radar list item, so the state is visible before the tender is opened.
4. **Sorting:** tenders with status != 1 fall below Divulgada ones in the list. Never hide them — a user may be tracking exactly that one.
5. **AI screens carry the same banner.** Screening a suspended edital is still useful; it is just not urgent.
6. Store the status on `tenders` (`situacao_id`, `situacao_nome`, `situacao_changed_at`) so B10 can diff it and so the UI never has to re-fetch to know.

Copy comes to Sci before shipping — customer-facing wording, brief §5.

## 4. B10 — `watch_tender` (v1 Essencial, with the alerts)

The same field checked over time is what turns "this tender is suspended" into **"the tender you are preparing was just suspended"** — the alert nobody in this market sends today. Competitors announce *new* tenders; none announces *changes* to the one you are working on.

**Data:** `tender_watches (id, user_id, tender_id, created_at, muted_at)` — a tender is watched when the user saves it, runs an AI screening on it, or opens it more than once.

**Job:** `watch_tender`, daily, and **twice a day in the last 3 days before `dataEncerramentoProposta`** (the 6-hour header TTL from spec §3 is too loose for a watched tender near its deadline). It refreshes the watched tenders and diffs against the cached version:

| Change detected | Alert |
|---|---|
| `situacaoCompraId` 1 → 4 | "Edital suspenso pelo órgão" |
| `situacaoCompraId` 1 → 2 or 3 | "Edital revogado/anulado pelo órgão" |
| `situacaoCompraId` 4 → 1 | "Edital voltou a andar" — with the new dates |
| `dataEncerramentoProposta` changed | "A data de encerramento mudou: [antes] → [agora]" |
| New file whose title matches the retificação/errata/suspensão/adiamento pattern | "Saiu um novo documento: [título do arquivo]" |

**Rules:** idempotent per (watch, change signature) so a change is announced once; the alert always carries the source (what changed, and the date the agency published it); no alert claims anything about the tender's future; a muted watch stops alerts without deleting history.

**Test fixture:** the HUPE-RJ tender from §1 is a real suspended case. Capture its payload into the fixtures and use it for both B9's rendering and B10's diff.

## 5. Where this is written down

| Document | What it says |
|---|---|
| `legal/LEGAL_AND_BILLING_BRIEF.md` §2.2 rule 6 | No urgency copy when `situacaoCompraId != 1` |
| `TECHNICAL_SPEC.md` §7 | `watch_tender` job and the refresh cadence |
| `DEVELOPMENT_PLAN.md` §5 | Cards **B9** (now) and **B10** (v1) |
| this file | the evidence, the API facts and the reasoning behind both |
