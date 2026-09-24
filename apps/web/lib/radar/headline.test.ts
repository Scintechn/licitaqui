import { describe, expect, it } from 'vitest'
import type { TenderCard } from './contract'
import { cardHeadline, deadlineLabel, tenderBudget } from './headline'
import { messages } from '../messages'

const copy = messages.radar
const NOW = new Date('2026-09-17T15:00:00.000Z')

/** The board's own card: Campinas, closes 30/09 08:30 Brasília, 7 items. */
const TENDER: TenderCard = {
  id: '51885242000140-1-000744/2026',
  object: 'Registro de preços de baterias e pilhas',
  shortTitle: null,
  agencyName: 'Prefeitura de Campinas',
  city: 'Campinas',
  state: 'SP',
  modalityName: 'Pregão eletrônico',
  proposalsCloseAt: '2026-09-30T11:30:00.000Z',
  estimatedValue: '48196.00',
  confidentialBudget: false,
  priceRegistration: true,
  meEppSummary: 'exclusive',
  favoredTreatment: true,
  itemCount: 7,
  segments: ['Gráfico / Escritório'],
  status: 'Divulgada no PNCP',
  pncpUpdatedAt: '2026-09-16T10:00:00.000Z',
  matchedSegments: [],
  group: 'compatible',
}

const card = (over: Partial<TenderCard>): TenderCard => ({ ...TENDER, ...over })

describe('deadlineLabel', () => {
  it('counts Brasília calendar days, not 24-hour blocks', () => {
    expect(deadlineLabel(TENDER.proposalsCloseAt, NOW)).toBe('13 dias')
  })

  it('names the two edges and the absence', () => {
    expect(deadlineLabel('2026-09-17T11:30:00.000Z', NOW)).toBe('último dia')
    expect(deadlineLabel('2026-09-10T11:30:00.000Z', NOW)).toBe(copy.card.closed)
    expect(deadlineLabel(null, NOW)).toBe(copy.card.noDeadline)
  })
})

describe('cardHeadline', () => {
  it('gives the slot to the value whenever there is one', () => {
    const out = cardHeadline(TENDER, NOW)
    expect(out.anchor).toEqual({ fact: 'value', text: 'R$ 48.196' })
    // Nothing quiet to add: the anchor already says it.
    expect(out.note).toBeNull()
  })

  it('promotes the deadline when the agency published no value', () => {
    const out = cardHeadline(card({ estimatedValue: null }), NOW)
    expect(out.anchor).toEqual({ fact: 'deadline', text: '13 dias' })
    expect(out.note).toBe(copy.card.noValue)
  })

  it('promotes the deadline when the budget is confidential, and says so', () => {
    // The normal case on real data: PNCP withholds budgets routinely, so this
    // is the branch 19 of 20 cards take.
    const out = cardHeadline(card({ confidentialBudget: true }), NOW)
    expect(out.anchor).toEqual({ fact: 'deadline', text: '13 dias' })
    expect(out.note).toBe(copy.card.confidential)
  })

  it('never shows a figure the agency declared secret', () => {
    // `confidential_budget` wins even when `estimated_value` holds something.
    const out = cardHeadline(card({ confidentialBudget: true, estimatedValue: '48196.00' }), NOW)
    expect(out.anchor?.fact).toBe('deadline')
    expect(JSON.stringify(out)).not.toContain('48.196')
  })

  it('falls back to the item count only when there is no date at all', () => {
    const out = cardHeadline(card({ estimatedValue: null, proposalsCloseAt: null }), NOW)
    expect(out.anchor).toEqual({ fact: 'items', text: '7 itens' })
  })

  it('falls back to the ME/EPP regime when there is neither date nor items', () => {
    const out = cardHeadline(
      card({ estimatedValue: null, proposalsCloseAt: null, itemCount: null }),
      NOW,
    )
    expect(out.anchor).toEqual({ fact: 'regime', text: copy.tags.exclusive })
  })

  it('leaves the slot empty rather than inventing a fact', () => {
    const out = cardHeadline(
      card({
        estimatedValue: null,
        proposalsCloseAt: null,
        itemCount: null,
        meEppSummary: null,
      }),
      NOW,
    )
    expect(out.anchor).toBeNull()
    expect(out.note).toBe(copy.card.noValue)
  })

  it('still promotes a closed deadline, because "encerrado" is the fact', () => {
    const out = cardHeadline(
      card({ estimatedValue: null, proposalsCloseAt: '2026-09-10T11:30:00.000Z' }),
      NOW,
    )
    expect(out.anchor).toEqual({ fact: 'deadline', text: copy.card.closed })
  })

  it('treats a zero exactly as it treats a missing value', () => {
    // PNCP's *published* figure for a withheld budget is 0, on 108 tenders.
    // It is an absence, so it takes the absence's path: the deadline is
    // promoted and the quiet line says we were not told the value.
    const out = cardHeadline(card({ estimatedValue: '0.00' }), NOW)

    expect(out.anchor).toEqual({ fact: 'deadline', text: '13 dias' })
    expect(out.note).toBe(copy.card.noValue)
  })

  it('the anchor is never the absence itself', () => {
    // The whole point: "Valor não informado" and "Valor sigiloso" may appear
    // in `note`, never in `anchor`, whatever the shape of the row.
    for (const over of [
      { estimatedValue: null },
      { confidentialBudget: true },
      { estimatedValue: null, proposalsCloseAt: null },
      { estimatedValue: null, proposalsCloseAt: null, itemCount: null },
      { estimatedValue: '', itemCount: null, meEppSummary: null },
    ] as Partial<TenderCard>[]) {
      const { anchor } = cardHeadline(card(over), NOW)
      expect(anchor?.text).not.toBe(copy.card.noValue)
      expect(anchor?.text).not.toBe(copy.card.confidential)
    }
  })
})

/**
 * The three states, and the line between two of them.
 *
 * The worker's consulta upgrade (PR #65) is what will start setting
 * `confidential_budget`, and PNCP's 503s mean no row on production carries it
 * today. So the `true` branch cannot be exercised against live data: these
 * tests are what hold it correct until it can be.
 */
describe('tenderBudget', () => {
  const budget = (over: Partial<TenderCard>) => tenderBudget({ ...TENDER, ...over })

  it('says "sigiloso" when, and only when, PNCP declared it', () => {
    expect(budget({ confidentialBudget: true })).toEqual({
      value: null,
      note: copy.card.confidential,
    })
  })

  it('lets the flag beat any figure sitting on the row', () => {
    // `orcamentoSigilosoCodigo` 2 or 3 and a `valorTotalEstimado` in the same
    // payload: the declaration wins, whatever the number says.
    expect(budget({ confidentialBudget: true, estimatedValue: '48196.00' })).toEqual({
      value: null,
      note: copy.card.confidential,
    })
  })

  it('prints a figure the órgão actually published', () => {
    expect(budget({ estimatedValue: '48196.00' })).toEqual({
      value: 'R$ 48.196',
      note: null,
    })
  })

  it('never infers "sigiloso" from a zero — that would be guessing', () => {
    // The heart of it. On Sci's two tenders the zero *is* a withheld budget,
    // and we still may not say so: "o órgão declarou o orçamento sigiloso" is
    // a claim about the edital, and PNCP publishes zero for merely incomplete
    // tenders as readily as for secret ones. Zero means "no price we can
    // show". Only the code means "secret".
    for (const zero of ['0', '0.00', '0.0000', '-0']) {
      const out = budget({ estimatedValue: zero, confidentialBudget: false })
      expect(out.value).toBeNull()
      expect(out.note).toBe(copy.card.noValue)
      expect(out.note).not.toBe(copy.card.confidential)
    }
  })

  it('says the same thing for a NULL estimate', () => {
    expect(budget({ estimatedValue: null })).toEqual({ value: null, note: copy.card.noValue })
  })

  it('always names exactly one of the two: a figure or an absence', () => {
    for (const over of [
      {},
      { estimatedValue: null },
      { estimatedValue: '0.00' },
      { estimatedValue: '' },
      { confidentialBudget: true },
      { confidentialBudget: true, estimatedValue: '0.00' },
    ] as Partial<TenderCard>[]) {
      const out = budget(over)
      expect(out.value === null).toBe(out.note !== null)
    }
  })
})
