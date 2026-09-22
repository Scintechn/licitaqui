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
 * Item 2 of the three UX failures. Sci: *"Like we have in PNCP I just need one
 * click to see the brief description in 'Objeto'. In our application we need at
 * least 2 or 3 clicks, or to request the AI — for something that is already
 * there, free."*
 *
 * The full object ships in the list payload, so the only question these tests
 * ask is whether the card lets him read it: yes when there is more to read, no
 * control at all when there is not.
 */
const LONG =
  'AQUISICAO DE MATERIAIS TERAPEUTICOS PARA AS UNIDADES DO NUCLEO DE INTEGRACAO DE ' +
  'DESENVOLVIMENTO INFANTIL NIDI  CENTRO DE ATENCAO PSICOSSOCIAL INFANTIL CAPSI E ' +
  'POLICLINICA DA CRIANCA  por meio de Dispensa Eletronica de Licitacao com fundamento ' +
  'no art. 75  inc. II da Lei n  14.133 21  visando atender as necessidades da ' +
  'Secretaria de Saude do Municipio de Olinda'

describe('the object, readable from the list', () => {
  it('puts the whole text on the card, collapsed, behind one control', () => {
    const out = render({ object: LONG })
    expect(out).toContain('<details')
    expect(out).not.toContain('<details open')
    expect(out).toContain(copy.list.object.label)
    // The tail of the object — the part the 120-character title cuts off.
    expect(out).toContain('Secretaria de Saude do Municipio de Olinda')
  })

  it('costs no request and no screening: it is the string the list already sent', () => {
    // Nothing in this component fetches; the assertion that matters is that
    // the text rendered is the tender's own `object` and not a summary.
    const out = render({ object: LONG })
    expect(out).toContain('materiais terapeuticos')
  })

  it('renders no control at all when the title is already the whole object', () => {
    const out = render({ object: 'Registro de preços de baterias e pilhas' })
    expect(out).not.toContain('<details')
    expect(out).not.toContain(copy.list.object.label)
  })

  it('is a real disclosure, so it is a keyboard stop and works unhydrated', () => {
    const out = render({ object: LONG })
    expect(out).toContain('<summary')
    // 44px: the board's minimum touch target, on the whole row.
    expect(out).toMatch(/<summary[^>]*min-h-touch/)
  })

  it('does not put interactive content inside the card’s link', () => {
    // `<details>` inside an `<a>` is invalid HTML and would swallow the click.
    const out = render({ object: LONG })
    const link = out.slice(out.indexOf('<a '), out.indexOf('</a>'))
    expect(link).not.toContain('<details')
  })
})
