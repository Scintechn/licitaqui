import { describe, expect, it } from 'vitest'
import type { TenderCard } from './contract'
import { cardHeadline, deadlineLabel } from './headline'
import { messages } from '../messages'

const copy = messages.radar
const NOW = new Date('2026-09-17T15:00:00.000Z')

/** The board's own card: Campinas, closes 30/09 08:30 Brasília, 7 items. */
const TENDER: TenderCard = {
  id: '51885242000140-1-000744/2026',
  object: 'Registro de preços de baterias e pilhas',
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
