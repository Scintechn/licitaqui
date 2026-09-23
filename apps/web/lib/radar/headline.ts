import type { TenderCard } from './contract'
import { daysUntil, meEppSummary, money } from './format'
import { mayShowUrgency } from './tender-status'
import { format, messages } from '../messages'

/**
 * Which fact a tender card puts in its biggest slot.
 *
 * ## The problem this exists to solve
 *
 * The card gives the estimated value a 22px Archivo semibold slot — the thing
 * the eye lands on first. On a real CNPJ, **19 of 20 cards render an absence
 * there**: PNCP withholds budgets routinely (`tenders.confidential_budget`),
 * so "Valor não informado" is not the edge case, it is the normal case. A list
 * whose visual anchor is, twenty times over, the word for *we don't know* tells
 * a reader nothing and looks broken.
 *
 * ## The rule
 *
 * The anchor is the value **when there is one**. When there is not, the slot is
 * given to the next fact that changes what the reader does, and the absence
 * drops to a quiet `text-meta text-muted` line — still stated, because the
 * reader does need to know the budget is withheld, just no longer shouted.
 *
 * The order of the fallbacks is not arbitrary:
 *
 * 1. **The deadline.** It is the only remaining fact that decides whether to
 *    act *today* rather than next week, and the product's whole promise is
 *    "antes do prazo". It is also the one fact PNCP never withholds: an open
 *    tender always has a proposal window, where it may well have no budget.
 * 2. **The item count.** An inventory fact, not a decision fact — "7 itens"
 *    does not tell a MEI whether to open the edital — so it only gets the slot
 *    when there is no date at all.
 * 3. **The ME/EPP regime.** Last, and only as a rescue, because it is already
 *    on the card as a tag with its own colour, and a binary is a poor use of a
 *    slot built for a number.
 *
 * Nothing invented and nothing promoted that is not already true of the row:
 * every branch prints a fact the tender carries.
 */

const copy = messages.radar

/** The countdown: "13 dias", "último dia", "encerrado", "sem data de proposta". */
export function deadlineLabel(iso: string | null, now: Date): string {
  const days = daysUntil(iso, now)
  if (days === null) return copy.card.noDeadline
  if (days < 0) return copy.card.closed
  return format(copy.card.daysLeft, { count: days })
}

/** Which fact won the slot. `value` is the normal case the board designed for. */
export type HeadlineFact = 'value' | 'deadline' | 'items' | 'regime'

export type CardHeadline = {
  /** The 22px anchor. `null` when the tender carries no fact worth the slot. */
  anchor: { fact: HeadlineFact; text: string } | null
  /**
   * The absence, named, for the quiet line under the anchor — "Valor sigiloso"
   * or "Valor não informado". `null` when the value itself is the anchor.
   */
  note: string | null
}

/** The ME/EPP regime as the one-word tag the card already shows. */
function regimeLabel(tender: TenderCard): string | null {
  const regime = meEppSummary(tender.meEppSummary)
  if (regime === 'exclusive') return copy.tags.exclusive
  if (regime === 'quota') return copy.tags.quota
  if (regime === 'mixed') return copy.tags.mixed
  if (regime === 'none') return copy.tags.none
  return null
}

/** The fallback chain, in the order argued above. */
function promoted(tender: TenderCard, now: Date): CardHeadline['anchor'] {
  // The deadline is promoted into the 22px slot on roughly 19 of 20 cards, so
  // on a stopped tender this — not the small print — is what shouts "último
  // dia" at the reader. §2.2 rule 6 through the one gate: it steps out of the
  // chain entirely and the item count takes the slot instead.
  if (mayShowUrgency(tender) && daysUntil(tender.proposalsCloseAt, now) !== null) {
    return { fact: 'deadline', text: deadlineLabel(tender.proposalsCloseAt, now) }
  }
  if (tender.itemCount !== null) {
    return { fact: 'items', text: format(copy.card.items, { count: tender.itemCount }) }
  }
  const regime = regimeLabel(tender)
  return regime ? { fact: 'regime', text: regime } : null
}

/** What a screen may say about a tender's budget: a figure, or a named absence. */
export type TenderBudget = {
  /** The figure, when there is one we are entitled to print. */
  value: string | null
  /** The absence, named. `null` exactly when `value` is a figure. */
  note: string | null
}

/**
 * The budget has **three** states, and telling them apart is the whole point.
 *
 * | state | what we know | what we say |
 * |---|---|---|
 * | `confidentialBudget` | PNCP declared the budget secret | "Valor sigiloso" |
 * | a figure, non-zero | the órgão published it | the figure |
 * | anything else | we do not know | "Valor não informado" |
 *
 * The third row swallows two very different rows of the database — a `NULL`
 * estimate and a zero one — and that is correct: both mean *no price we can
 * show*, and neither is evidence of anything else.
 *
 * **A zero is never promoted to "sigiloso".** It is tempting, because on the
 * two tenders Sci found the zero really is a withheld budget. But the reader
 * would be reading a claim about the edital — *the órgão declared this secret*
 * — that we would be guessing at, and PNCP publishes zero for tenders that are
 * merely incomplete as readily as for secret ones. Only
 * `orcamentoSigilosoCodigo` ∈ {2, 3} means secret, and it arrives on the row
 * as `confidential_budget`. Keeping the two apart is what makes "Valor
 * sigiloso" safe to print the moment the worker's consulta upgrade starts
 * setting the flag.
 *
 * Shared by the Radar card and the Opportunity screen so the two cannot drift:
 * before this, each decided the same three states in its own `if`.
 */
export function tenderBudget(
  tender: Pick<TenderCard, 'confidentialBudget' | 'estimatedValue'>,
): TenderBudget {
  // `confidential_budget` wins over any figure on the row: the agency declared
  // the budget secret, so whatever `estimated_value` holds is not ours to show.
  if (tender.confidentialBudget) return { value: null, note: copy.card.confidential }

  const value = money(tender.estimatedValue)
  if (value !== null) return { value, note: null }

  return { value: null, note: copy.card.noValue }
}

export function cardHeadline(tender: TenderCard, now: Date = new Date()): CardHeadline {
  const budget = tenderBudget(tender)
  if (budget.value !== null) {
    return { anchor: { fact: 'value', text: budget.value }, note: null }
  }
  return { anchor: promoted(tender, now), note: budget.note }
}
