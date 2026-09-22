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
  status: 'Divulgada no PNCP',
  pncpUpdatedAt: '2026-09-16T10:00:00.000Z',
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

/**
 * "Objeto completo" is gone from the card.
 *
 * It was added because reading the tail of a 200-character object otherwise
 * cost a click, and Sci has now taken it back out: *"I don't think it's
 * needed, because we will have the whole description inside the item."* The
 * Opportunity screen prints the whole Objeto expanded, directly above the
 * Itens tab, so the tail is one tap away on the screen that also has the
 * items, the files and the deadline — and the list goes back to being a list.
 *
 * These tests pin the removal rather than delete the old ones, because a
 * `<details>` on the card is also what forced the card to stop being a single
 * link, and that regression must not come back by accident.
 */
const LONG =
  'AQUISICAO DE MATERIAIS TERAPEUTICOS PARA AS UNIDADES DO NUCLEO DE INTEGRACAO DE ' +
  'DESENVOLVIMENTO INFANTIL NIDI  CENTRO DE ATENCAO PSICOSSOCIAL INFANTIL CAPSI E ' +
  'POLICLINICA DA CRIANCA  por meio de Dispensa Eletronica de Licitacao com fundamento ' +
  'no art. 75  inc. II da Lei n  14.133 21  visando atender as necessidades da ' +
  'Secretaria de Saude do Municipio de Olinda'

describe('the card is a list row again, not an expander', () => {
  it('carries no disclosure, however long the object is', () => {
    const out = render({ object: LONG })
    expect(out).not.toContain('<details')
    expect(out).not.toContain('<summary')
    expect(out).not.toContain('Objeto completo')
  })

  it('still shows the object, trimmed, as the headline it always was', () => {
    const out = render({ object: LONG })
    expect(out).toContain('materiais terapeuticos')
    // …and not the tail, which is the Opportunity screen’s job now.
    expect(out).not.toContain('Secretaria de Saude do Municipio de Olinda')
  })

  it('is one link and therefore one keyboard stop for the whole tender', () => {
    const out = render({ object: LONG })
    expect(out.match(/<a /g)).toHaveLength(1)
    expect(out).toMatch(/^<a /)
  })

  it('renders as a plain surface, and no link at all, for the Landing example', () => {
    const out = renderToStaticMarkup(
      <TenderCardView tender={{ ...TENDER, object: LONG }} now={NOW} href={null} />,
    )
    expect(out).not.toContain('<a ')
    expect(out).toContain('materiais terapeuticos')
  })
})
