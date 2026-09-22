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
 */
export function mayShowUrgency(tender: Pick<TenderCard, 'status'>): boolean {
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
