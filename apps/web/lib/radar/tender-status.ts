import { format, messages } from '../messages'
import type { TenderCard } from './contract'
import { fullDate } from './format'

/**
 * The tender's status, and the one predicate that decides whether a screen may
 * call the reader to hurry.
 *
 * ## Why this file exists
 *
 * On 2026-09-22 the Opportunity screen rendered a real Pregão from HOSPITAL
 * UNIVERSITÁRIO PEDRO ERNESTO with **"último dia"** as its headline metric,
 * **"restantes"** under it, **"✓ Ainda dá tempo"** in the why-list — and, as
 * the *tenth row* of the Operação block in the same styling as every other
 * row, **Situação: Suspensa**. The agency had stopped the tender and the
 * product was telling the user to hurry.
 *
 * "Ainda dá tempo" is not a matter of tone. It is a factual claim about the
 * world, and on a suspended tender it is false. Legal brief §2.2 rule 6 exists
 * because of this defect: *"Status is a first-class state of the screen, not a
 * metadata row at the bottom."*
 *
 * ## Why a gate and not a condition at each call site
 *
 * The tenth row *is* the scattered-conditional failure mode. Status was on the
 * screen; every urgency element independently failed to consult it. Four
 * screens and a list card each carrying their own `if` is four-plus chances to
 * forget, and the next screen anybody adds starts at zero. So there is exactly
 * one predicate — `mayShowUrgency` — every urgency element asks, and it has
 * its own tests. That is also what makes rule 6 enforceable by CI rather than
 * by memory.
 *
 * ## The four values, and why we match on the name
 *
 * PNCP's `situacaoCompra` domain table has four entries, and `tenders.status`
 * holds `situacaoCompraNome` verbatim. Across 4 919 production rows there are
 * exactly four distinct values and **no nulls**:
 *
 * | id | `tenders.status`    | rows  | meaning                                  |
 * |----|---------------------|-------|------------------------------------------|
 * | 1  | `Divulgada no PNCP` | 4 708 | normal — the only state urgency is allowed in |
 * | 4  | `Suspensa`          |   179 | stopped, **may resume with new dates**   |
 * | 2  | `Revogada`          |    23 | the agency closed the process; final     |
 * | 3  | `Anulada`           |     9 | the agency annulled the process; final   |
 *
 * The numeric `situacaoCompraId` would be the sturdier key, and B9 does not
 * need it: the name is already stored, already reaches the client, and is
 * already the string the Operação row prints. Adding a column is its own PR
 * (CLAUDE.md) and B10's diff is what actually wants the id — which is in any
 * case already available in `tenders.raw->>'situacao_id'`, so even that needs
 * no migration.
 *
 * ## Unknown means "no urgency"
 *
 * `tenderStatusKind` returns `null` for a value outside the table, and the
 * gate treats `null` as forbidden. Rule 6 is written as an allow-list — *only*
 * 1 permits urgency — and the asymmetry of the mistakes settles it: suppressing
 * urgency on a tender we cannot classify costs a countdown, while showing
 * "último dia" on a suspended one is the defect this file was written for.
 *
 * Accent- and case-insensitive, because the value is agency-entered text that
 * reaches us through two different PNCP endpoints.
 */

export const TENDER_STATUS_KINDS = ['divulgada', 'suspensa', 'revogada', 'anulada'] as const
export type TenderStatusKind = (typeof TENDER_STATUS_KINDS)[number]

/**
 * The three halted names as `fold()` produces them, for SQL that has to ask
 * the same question this module answers.
 *
 * None of the four PNCP values carries a diacritic, so `lower(btrim(status))`
 * in Postgres and `fold()` here agree on all of them — which is what lets a
 * query use this list instead of reimplementing the folding.
 */
export const HALTED_FOLDED: readonly string[] = ['suspensa', 'revogada', 'anulada']

/** `Divulgada no PNCP`, folded. The one value that permits urgency. */
export const DIVULGADA_FOLDED = 'divulgada no pncp'

/** `tenders.status` for the normal state. The list's sort key compares to it. */
export const DIVULGADA = 'Divulgada no PNCP'

/** PNCP's own vocabulary, folded, so the lookup survives case and accents. */
const BY_NAME = new Map<string, TenderStatusKind>([
  ['divulgada no pncp', 'divulgada'],
  ['suspensa', 'suspensa'],
  ['revogada', 'revogada'],
  ['anulada', 'anulada'],
])

function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim()
    .toLowerCase()
}

/** The status as one of the four kinds, or `null` for anything else. */
export function tenderStatusKind(
  status: string | null | undefined,
): TenderStatusKind | null {
  if (!status) return null
  return BY_NAME.get(fold(status)) ?? null
}

/**
 * **The gate.** May this screen show urgency about this tender?
 *
 * Every countdown, every "último dia", every "restantes", every "ainda dá
 * tempo" and every other call to hurry asks this and nothing else. `false`
 * does not mean hide the tender or hide its dates — it means stop claiming the
 * clock is still running.
 *
 * ## It asks two things, because there are two ways the clock can stop
 *
 * The órgão can halt the tender — that is `status`, and it is why this file
 * exists. The hour can simply pass — that is `closed`, and it was missed.
 *
 * Until 2026-09-24 this predicate read `status` alone, so a tender that closed
 * at 08:00 went on rendering **"último dia"**, **"restantes"** and
 * **"✓ Ainda dá tempo"** for the rest of the day — directly above
 * `As propostas deste edital já encerraram`, which the same screen prints from
 * the same field. Two clocks on one page disagreeing, one of them a green tick.
 *
 * Found on 2026-09-24 by a persona walkthrough and reproduced on production
 * against `18114272000188-1-000054/2026`, closing that morning at 08:00.
 *
 * That is the same defect as the suspended tender in the header of this file,
 * reached by a different route. Rule 6's subject is not "is it suspended"; it
 * is **"may we claim the clock is still running"**, and a deadline in the past
 * is that claim just as falsely as a suspension is.
 *
 * ## Why the deadline and not `TenderDetail.closed`
 *
 * `closed` is the obvious input and it is the wrong one here: it exists on
 * `TenderDetail` and **not** on `TenderCard`, so a gate that took it could not
 * be asked by the list — which is one of the four callers, and the one a
 * person sees first. `proposalsCloseAt` is on both, and comparing it to `now`
 * gives the same answer the database gives (`proposals_close_at <= now()`)
 * without a contract change, a query change, or a second field that can drift
 * from the first.
 *
 * It also fixes the drift directly. The countdown beside this gate is
 * calendar-day (`daysUntil` rounds to midnight), so on the closing day it
 * reads `0` → "último dia" from 00:00 to 23:59 regardless of the hour. The
 * gate is to the second.
 *
 * `now` is a parameter rather than a call to `new Date()` because every caller
 * already carries one for exactly this reason — the countdown on every card is
 * assertable only because the clock is injected.
 *
 * A tender with **no** deadline is not closed; nothing can claim its clock is
 * running either, because every urgency element is downstream of a countdown
 * that needs a date. Status remains the only gate there.
 */
export function mayShowUrgency(
  tender: Pick<TenderCard, 'status' | 'proposalsCloseAt'>,
  now: Date = new Date(),
): boolean {
  if (!mayShowDeadline(tender)) return false
  if (!tender.proposalsCloseAt) return true
  return new Date(tender.proposalsCloseAt).getTime() > now.getTime()
}

/**
 * **The other question**, and it is not the same one.
 *
 * May this screen present the tender's deadline as a fact at all?
 *
 * Only the *agency* can make a deadline meaningless. When PNCP says the tender
 * was suspended, revoked or annulled, the dates stop describing anything and
 * the status banner speaks instead — so the headline slot takes the item count
 * and the closed notice does not render. But a deadline that has merely
 * **passed** is still a fact, and a useful one: the card promotes it and
 * renders *"Encerrado"*, which is exactly what someone scanning a list needs to
 * know.
 *
 * ## Why this exists as a second predicate
 *
 * Because on 2026-09-24 it did not, and `mayShowUrgency` was asked both
 * questions at once. Adding the deadline to the urgency gate — correctly — had
 * two silent consequences that its own tests caught: a closed tender stopped
 * promoting *"Encerrado"* into the headline (`headline.ts`), and the
 * *"As propostas deste edital já encerraram"* notice disappeared from the
 * screen at the precise moment it became true (`opportunity-view.tsx:640`,
 * whose condition `tender.closed && urgency` had been spelling "closed, and
 * not halted by the agency" in the only vocabulary available to it).
 *
 * Two questions, two names. The gate's own docstring already drew this line —
 * *"`false` does not mean hide the tender or hide its dates"* — and the code
 * had no way to say it.
 */
export function mayShowDeadline(tender: Pick<TenderCard, 'status'>): boolean {
  return tenderStatusKind(tender.status) === 'divulgada'
}

/**
 * Revogada and Anulada are final; Suspensa is not.
 *
 * The distinction has to survive into the copy: a suspended tender may resume
 * with new dates, so wording it as cancelled would be the same class of false
 * claim in the opposite direction. Nothing may call a suspension a
 * cancellation.
 */
export function isFinalStatus(kind: TenderStatusKind | null): boolean {
  return kind === 'revogada' || kind === 'anulada'
}

/* ------------------------------------------------------------ the banner */

const copy = messages.radar.status

/** A status kind the banner has wording for — i.e. anything but `divulgada`. */
export type HaltedKind = Exclude<TenderStatusKind, 'divulgada'>

export type StatusNotice = {
  kind: HaltedKind
  /** "Edital SUSPENSO pelo órgão em 21/09/2026". */
  title: string
  /** What the state means for the dates below it. */
  body: string
  /** Where the claim comes from, and why it may lag (§2 caveat). */
  source: string
  /** The label the deadline block wears instead of a countdown. */
  deadlineLabel: string
  /** Final — revogada/anulada — as opposed to a suspension, which may resume. */
  final: boolean
}

/**
 * The banner above the title, or `null` when the tender is Divulgada and the
 * screen is an ordinary one.
 *
 * The date is the **agency's** `dataAtualizacaoGlobal`, not our `updated_at`:
 * citing our own sweep would date the suspension to whenever our cron last ran
 * and quietly turn a fact about the órgão into a fact about us. When PNCP
 * carries no date the sentence drops the clause rather than inventing one —
 * `bannerNoDate` — because "em —" is worse than no date at all.
 *
 * The `source` line is §2's caveat made visible: agencies often publish a
 * suspension in the origin portal or the official gazette before the PNCP, so
 * the banner says where our claim comes from rather than implying we are
 * authoritative or instantaneous.
 */
export function statusNotice(
  tender: Pick<TenderCard, 'status' | 'pncpUpdatedAt'>,
): StatusNotice | null {
  const kind = tenderStatusKind(tender.status)
  if (kind === null || kind === 'divulgada') return null

  const date = fullDate(tender.pncpUpdatedAt)
  const title = date
    ? format(copy.banner[kind].title, { data: date })
    : copy.bannerNoDate[kind]

  return {
    kind,
    title,
    body: copy.banner[kind].body,
    source: copy.source,
    deadlineLabel: copy.deadlineHalted[kind],
    final: isFinalStatus(kind),
  }
}

/** The chip beside COMPATÍVEL. `null` on a Divulgada tender: that is the norm. */
export function statusChipLabel(tender: Pick<TenderCard, 'status'>): string | null {
  const kind = tenderStatusKind(tender.status)
  if (kind === null || kind === 'divulgada') return null
  return copy.chip[kind]
}
