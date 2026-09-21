import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messages } from '@/lib/messages'
import type { TenderDetail, TenderItemView } from '@/lib/radar/contract'
import { PriceView, chooseItem, unitPrice, type PriceViewProps } from './price-view'

/**
 * Canvas 05. Almost everything on it is masked, so the test is mostly about
 * *what is not there*: no invented price band, no disabled control, and the one
 * real number — the agency's own estimate — printed to the centavo.
 */

const copy = messages.radar
const page = copy.price

const ITEMS: TenderItemView[] = [
  {
    number: 1,
    description: 'Pilha alcalina AA, embalagem com 2',
    kind: 'M',
    quantity: '500',
    unit: 'CARTELA',
    unitEstimatedValue: '3.74',
    totalValue: '1870.00',
    ncm: null,
    judgmentCriterion: 'Menor preço',
    benefitId: 1,
    benefitName: 'Exclusivo ME/EPP',
    segment: null,
    relevance: null,
    hasAward: false,
  },
  {
    number: 2,
    description: 'Bateria 9V alcalina',
    kind: 'M',
    quantity: '80',
    unit: 'UN',
    unitEstimatedValue: '12.50',
    totalValue: '1000.00',
    ncm: null,
    judgmentCriterion: 'Menor preço',
    benefitId: 1,
    benefitName: 'Exclusivo ME/EPP',
    segment: null,
    relevance: null,
    hasAward: false,
  },
]

const TENDER = {
  id: '51885242000140-1-000744/2026',
  object: 'Registro de preços de baterias e pilhas',
  items: ITEMS,
} as unknown as TenderDetail

function render(overrides: Partial<PriceViewProps> = {}): string {
  const props: PriceViewProps = {
    tenderId: TENDER.id,
    tender: TENDER,
    item: null,
    status: { kind: 'ready' },
    backHref: `/radar/edital/${TENDER.id}/triagem`,
    ...overrides,
  }
  return renderToStaticMarkup(<PriceView {...props} />)
}

describe('unitPrice', () => {
  it('keeps the centavos a tender total drops', () => {
    expect(unitPrice('3.74')).toBe('R$ 3,74')
  })

  it('answers nothing for a value the agency did not publish', () => {
    expect(unitPrice(null)).toBeNull()
    expect(unitPrice('')).toBeNull()
    expect(unitPrice('sigiloso')).toBeNull()
  })
})

describe('chooseItem', () => {
  it('defaults to the first item', () => {
    expect(chooseItem(ITEMS, null)?.number).toBe(1)
  })

  it('honours ?item= when the tender has that one', () => {
    expect(chooseItem(ITEMS, 2)?.number).toBe(2)
  })

  it('falls back rather than showing nothing for an item that is not there', () => {
    expect(chooseItem(ITEMS, 99)?.number).toBe(1)
    expect(chooseItem([], 1)).toBeNull()
  })
})

describe('PriceView', () => {
  const html = render()

  it('prints the one price we actually hold', () => {
    expect(html).toContain(page.estimated)
    expect(html).toContain('3,74')
  })

  it('masks the two we do not, rather than inventing a band', () => {
    expect(html).toContain(page.won)
    expect(html).toContain(page.market)
    expect(html).not.toContain('20,34</strong>')
    // Two table bars plus the headline figure.
    expect(html.split('bg-line-strong').length - 1).toBe(3)
  })

  it('names what is hidden for a screen reader', () => {
    expect(html).toContain(page.lockedValue)
  })

  it('leads to the plan as a real link, never a disabled button', () => {
    expect(html).toContain('/conta/plano')
    expect(html).toContain(page.cta)
    expect(html).not.toContain('disabled=""')
  })

  it('lets the reader move between the tender’s items', () => {
    expect(html).toContain(`/radar/edital/${TENDER.id}/preco?item=2`)
    expect(html).toContain('aria-current="page"')
  })

  it('says so when the items have not been synced yet', () => {
    const empty = render({ tender: { ...TENDER, items: [] } as unknown as TenderDetail })
    expect(empty).toContain(page.noItems)
  })

  it('shows the tender still loading, and the one that is not there', () => {
    expect(render({ status: { kind: 'analyzing' }, tender: null })).toContain(
      copy.states.analyzingTenderTitle,
    )
    expect(render({ status: { kind: 'notFound' }, tender: null })).toContain(
      copy.opportunity.notFoundTitle,
    )
  })

  it('goes back to the screening it came from', () => {
    expect(html).toContain(`href="/radar/edital/${TENDER.id}/triagem"`)
  })
})
