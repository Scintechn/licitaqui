import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messages } from '@/lib/messages'
import type { TenderCard } from '@/lib/radar/contract'
import { TenderCardView } from './tender-card'

/**
 * The two things a real CNPJ showed about this card, neither of which the
 * board could have: almost every tender has no published value, and almost
 * every title arrives shouted with a portal name bolted on the front.
 */

const copy = messages.radar
const NOW = new Date('2026-09-17T15:00:00.000Z')

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

function render(over: Partial<TenderCard> = {}): string {
  return renderToStaticMarkup(<TenderCardView tender={{ ...TENDER, ...over }} now={NOW} />)
}

/** The 22px Archivo slot — the card's visual anchor. */
const ANCHOR = /text-\[22px\][^>]*>([^<]*)</

function anchor(html: string): string | null {
  return html.match(ANCHOR)?.[1].trim() ?? null
}

describe('the headline slot', () => {
  it('holds the value when the agency published one', () => {
    expect(anchor(render())).toBe('R$ 48.196')
  })

  it('holds the deadline when it did not, and names the absence quietly', () => {
    const out = render({ estimatedValue: null })
    expect(anchor(out)).toBe('13 dias')
    // Still stated — a reader does need to know the budget is withheld — but
    // in text-meta text-muted, not in 22px Archivo.
    expect(out).toContain(copy.card.noValue)
    expect(out).toMatch(new RegExp(`text-meta text-muted">${copy.card.noValue}<`))
  })

  it('does the same for a confidential budget, which is the normal case', () => {
    const out = render({ confidentialBudget: true })
    expect(anchor(out)).toBe('13 dias')
    expect(out).toContain(copy.card.confidential)
  })

  it('never prints the countdown twice when the deadline was promoted', () => {
    const out = render({ estimatedValue: null })
    expect(out.match(/13 dias/g)).toHaveLength(1)
  })

  it('keeps the countdown in its own corner while the value holds the slot', () => {
    const out = render()
    expect(anchor(out)).toBe('R$ 48.196')
    expect(out).toContain('13 dias')
  })

  it('never prints the item count twice when the items were promoted', () => {
    const out = render({ estimatedValue: null, proposalsCloseAt: null })
    expect(anchor(out)).toBe('7 itens')
    expect(out.match(/7 itens/g)).toHaveLength(1)
  })

  it('leaves no 22px slot at all rather than shouting an absence', () => {
    const out = render({
      estimatedValue: null,
      proposalsCloseAt: null,
      itemCount: null,
      meEppSummary: null,
      favoredTreatment: false,
      priceRegistration: false,
    })
    expect(anchor(out)).toBeNull()
    expect(out).toContain(copy.card.noValue)
  })
})

describe('the title', () => {
  it('drops the sourcing portal, the shouting and the full stop', () => {
    const out = render({ object: '[Portal de Compras Públicas] - AQUISIÇÃO DE DRONES.' })
    expect(out).toContain('Aquisição de drones')
    expect(out).not.toContain('Portal de Compras Públicas')
    expect(out).not.toContain('AQUISIÇÃO')
  })

  it('leaves a title that was already prose exactly as it came', () => {
    expect(render()).toContain('Registro de preços de baterias e pilhas')
  })
})
