import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { format, messages } from '@/lib/messages'
import type { TenderItemView } from '@/lib/radar/contract'
import { TENDER_ITEMS_FIXTURE, TENDER_ITEMS_FIXTURE_TOTAL } from '@/lib/radar/items-fixture'
import { ITEMS_PAGE, TenderItems, sumItems } from './tender-items'

/**
 * The Itens tab, against the production rows it was verified on.
 *
 * The fixture is not typed by hand: `lib/radar/items-fixture.ts` holds the
 * fifteen rows of `12342663000173-1-000017/2026` as the database has them, so
 * "400 × R$ 816,67 = R$ 326.668,00" below is the same arithmetic a reader will
 * check against PNCP's table.
 */

const copy = messages.radar.opportunity.items

function render(props: Parameters<typeof TenderItems>[0]): string {
  return renderToStaticMarkup(<TenderItems {...props} />)
}

/** A row with everything filled in, for the cases the fixture does not cover. */
function item(over: Partial<TenderItemView> = {}): TenderItemView {
  return {
    number: 1,
    description: 'Caneta esferográfica azul',
    kind: 'M',
    quantity: '10.0',
    unit: 'Unidade',
    unitEstimatedValue: '2.5000',
    totalValue: '25.00',
    ncm: null,
    judgmentCriterion: null,
    benefitId: null,
    benefitName: null,
    segment: null,
    relevance: null,
    hasAward: null,
    ...over,
  }
}

describe('sumItems', () => {
  it('adds the fifteen real rows to the centavo PNCP publishes', () => {
    expect(sumItems(TENDER_ITEMS_FIXTURE)).toBe(TENDER_ITEMS_FIXTURE_TOTAL)
    expect(TENDER_ITEMS_FIXTURE_TOTAL).toBe('2988571.02')
  })

  it('refuses to add a list with a hole in it rather than under-reporting', () => {
    expect(sumItems([item(), item({ number: 2, totalValue: null })])).toBeNull()
    expect(sumItems([item(), item({ number: 2, totalValue: 'n/a' })])).toBeNull()
  })

  it('has nothing to add for a tender with no items', () => {
    expect(sumItems([])).toBeNull()
  })
})

describe('the Itens tab · the figures', () => {
  const out = render({ items: TENDER_ITEMS_FIXTURE, visible: 15 })

  it('prints the five columns in PNCP’s own vocabulary', () => {
    for (const label of [
      copy.number,
      copy.description,
      copy.quantity,
      copy.unitValue,
      copy.totalValue,
    ]) {
      expect(out).toContain(label)
    }
  })

  it('renders item 1 exactly as PNCP does: 400 Hora × R$ 816,67 = R$ 326.668,00', () => {
    expect(out).toContain('FILMAGEM COM CAMÊRA')
    expect(out).toContain('R$ 816,67')
    expect(out).toContain('R$ 326.668,00')
    expect(out).toContain('Hora')
  })

  it('drops the numeric(…) trailing zero on a whole quantity', () => {
    // `400.0` off the wire; "400,0 Hora" is noise on every row of every tender.
    expect(out).toContain('>400<')
    expect(out).not.toContain('400,0')
  })

  it('keeps the centavos, because the point is checking us line by line', () => {
    // `money()` would scale this to "R$ 833,33 mil"; nothing here may.
    expect(out).toContain('R$ 833.333,00')
    expect(out).not.toMatch(/R\$ [\d.,]+ (mil|mi|bi)/)
  })

  it('shows the sum of the items, named as that and never as the tender’s value', () => {
    expect(out).toContain('R$ 2.988.571,02')
    expect(out).toContain(format(copy.sum, { count: 15 }))
    // Legal brief §2.2 rule 3: the arithmetic is visible and the figure is not
    // allowed to pass for the agency's declared total.
    expect(out).toContain(copy.sumNote)
    expect(out).toMatch(/Não é o valor total da compra declarado pelo órgão/)
  })

  it('shows no sum at all when one row cannot be added', () => {
    const holed = [...TENDER_ITEMS_FIXTURE.slice(0, 3), item({ number: 99, totalValue: null })]
    const html = render({ items: holed, visible: 99 })
    expect(html).not.toContain(copy.sumNote)
    expect(html).not.toContain('R$ 2.988.571,02')
    // …but the rows it does hold are still shown.
    expect(html).toContain('R$ 326.668,00')
  })

  it('names an absent figure rather than leaving an empty cell', () => {
    const html = render({ items: [item({ unitEstimatedValue: null, quantity: null })] })
    expect(html).toContain('—')
  })
})

describe('the Itens tab · 390px', () => {
  const out = render({ items: TENDER_ITEMS_FIXTURE, visible: 15 })

  it('renders cards below md and a real table from md up, never both at once', () => {
    // `hidden` is display:none, so exactly one of the two trees is in the
    // accessibility tree at any width.
    expect(out).toContain('md:hidden')
    expect(out).toContain('hidden overflow-x-auto md:block')
  })

  it('gives the table real column headers rather than styled divs', () => {
    expect(out).toContain('<table')
    expect(out.match(/scope="col"/g)).toHaveLength(5)
    expect(out).toContain('<caption')
  })

  it('labels every figure on the narrow layout, where there is no header row', () => {
    const cards = out.slice(0, out.indexOf('<div class="hidden overflow-x-auto'))
    expect(cards).toContain('<dt')
    expect(cards).toContain(copy.quantity)
    expect(cards).toContain(copy.totalValue)
  })

  it('never lets a figure wrap mid-number', () => {
    expect(out).toContain('whitespace-nowrap')
    expect(out).toContain('tabular-nums')
  })
})

describe('the Itens tab · long descriptions', () => {
  // A real shape: 700 characters of specification with the agency's own blank
  // lines listing sub-quantities.
  const LONG =
    'O serviço contratado consiste na reprodução e acabamento de documentos através de ' +
    'impressão preta e branca em modo frente e verso, utilizando papel sulfite padrão ' +
    'formato A5, com acabamento em encadernação tipo espiral plástico flexível e inclusão ' +
    'de capa frontal transparente e capa traseira opaca texturizada.\n\n' +
    'OBS: O CONTEÚDO DAS CADERNETAS SERÁ DISPONIBILIZADO APÓS ASSINATURA DO TERMO DE ' +
    'CONTRATO, MEDIANTE TERMO DE CONFIDENCIALIDADE.\n\n' +
    '1. Impressão de caderneta formato A5, frente e verso, com 22 páginas. QM 1055 — 38 UND;\n' +
    '2. Impressão de caderneta formato A5, frente e verso, com 12 páginas. QM 0946 — 02 UND.'

  const out = render({ items: [item({ description: LONG })] })

  it('collapses it behind a disclosure rather than printing a wall', () => {
    expect(out).toContain('<details')
    expect(out).not.toContain('<details open')
    expect(out).toContain(copy.more)
  })

  it('still holds every character, so the whole thing can be read in place', () => {
    expect(out).toContain('TERMO DE CONFIDENCIALIDADE')
    expect(out).toContain('QM 0946')
  })

  it('keeps the agency’s line breaks, the way the Objeto block does', () => {
    expect(out).toContain('whitespace-pre-line')
  })

  it('never de-shouts a specification: the column has to match PNCP’s cell', () => {
    // `cleanTitle()` lowercases shouted words, which is right for a title and
    // wrong for a spec full of catalogue codes and formats.
    expect(out).toContain('OBS: O CONTEÚDO DAS CADERNETAS')
    expect(out).not.toContain('Obs: o conteúdo das cadernetas')
  })

  it('renders no control at all on a description that already fits', () => {
    const short = render({ items: [item()] })
    expect(short).not.toContain('<details')
    expect(short).not.toContain(copy.more)
  })

  it('gives the toggle a 44px target', () => {
    expect(out).toMatch(/min-h-touch/)
  })
})

describe('the Itens tab · paging', () => {
  /** The real shape of the problem: production holds a 1 124-item tender. */
  function many(count: number): TenderItemView[] {
    return Array.from({ length: count }, (_, i) =>
      item({ number: i + 1, description: `Item número ${i + 1}`, totalValue: '1.00' }),
    )
  }

  it('renders one page and not the whole list', () => {
    const out = render({ items: many(1124) })
    expect(out).toContain('Item número 20')
    expect(out).not.toContain('Item número 21')
    expect(ITEMS_PAGE).toBe(20)
  })

  it('offers more, and says how far in the reader is', () => {
    const out = render({ items: many(1124) })
    expect(out).toContain(copy.showMore)
    expect(out).toContain(format(copy.showing, { shown: 20, total: 1124 }))
  })

  it('grows by a page at a time', () => {
    const out = render({ items: many(1124), visible: 40 })
    expect(out).toContain('Item número 40')
    expect(out).not.toContain('Item número 41')
  })

  it('stops offering more once the whole list is on screen', () => {
    const out = render({ items: many(15), visible: 20 })
    expect(out).not.toContain(copy.showMore)
    expect(out).toContain('Item número 15')
  })

  it('keeps the total honest: it is every item, not the page', () => {
    // 1 124 rows at R$ 1,00. A sum over the visible page would say R$ 20,00.
    const out = render({ items: many(1124) })
    expect(out).toContain('R$ 1.124,00')
    expect(out).toContain(format(copy.sum, { count: 1124 }))
  })

  it('pages a tender of 1 124 items into markup a phone can hold', () => {
    const page = render({ items: many(1124) })
    const whole = render({ items: many(1124), visible: 1124 })
    // Measured, not assumed: the whole list is more than twenty times the page.
    expect(whole.length / page.length).toBeGreaterThan(20)
    expect(page.length).toBeLessThan(40_000)
  })
})

describe('the Itens tab · a tender with no items', () => {
  it('says so, and does not draw an empty table', () => {
    const out = render({ items: [] })
    expect(out).toContain(copy.emptyTitle)
    expect(out).toContain(copy.emptyBody)
    expect(out).not.toContain('<table')
    expect(out).not.toContain(copy.sumNote)
  })

  it('never claims the agency published nothing when it may not have synced', () => {
    // The two are different facts and we cannot tell them apart here, so the
    // sentence has to cover both rather than pick one.
    expect(copy.emptyBody).toMatch(/ainda não chegaram até nós/)
  })
})
