import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PLAN_HREF } from '@/lib/routes'
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

/** A real search, so every outbound link in these views is asserted to carry it. */
const SEARCH = { cnpj: '51885242000140', state: 'SP', q: 'papel', group: 'check' } as const

function render(overrides: Partial<PriceViewProps> = {}): string {
  const props: PriceViewProps = {
    tenderId: TENDER.id,
    tender: TENDER,
    item: null,
    status: { kind: 'ready' },
    backHref: `/radar/edital/${TENDER.id}/triagem`,
    search: SEARCH,
    ...overrides,
  }
  return renderToStaticMarkup(<PriceView {...props} />)
}

describe('unitPrice', () => {
  // An ordinary space, not the non-breaking one `Intl` emits: this is now the
  // Itens tab's `moneyExact`, which normalises it, and the two screens print
  // the same `unit_estimated_value` the same way on purpose.
  it('keeps the centavos a tender total drops', () => {
    expect(unitPrice('3.74')).toBe('R$ 3,74')
  })

  it('answers nothing for a value the agency did not publish', () => {
    expect(unitPrice(null)).toBeNull()
    expect(unitPrice('')).toBeNull()
    expect(unitPrice('sigiloso')).toBeNull()
  })

  // The fifth place a zero reached the screen, and the one not in the brief:
  // this screen had its own `Intl.NumberFormat` and would have kept printing
  // "Edital paga (estimado) R$ 0,00" after the items table was fixed.
  it('refuses a zero, so the row falls back to "não informado"', () => {
    expect(unitPrice('0')).toBeNull()
    expect(unitPrice('0.0000')).toBeNull()
  })
})

describe('a secret budget on the price screen', () => {
  it('prints "não informado", never R$ 0,00, for a priceless item', () => {
    const priceless = ITEMS.map((item) => ({
      ...item,
      unitEstimatedValue: '0.0000',
      totalValue: '0.00',
    }))
    const out = render({
      tender: { ...TENDER, items: priceless } as unknown as TenderDetail,
    })
    expect(out).toContain(page.noEstimate)
    expect(out).not.toMatch(/R\$\s*0[,.]?0*\b/)
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

  it('says there is no band yet, rather than masking one that does not exist', () => {
    // **This assertion was inverted by E9, deliberately.** It used to require
    // a locked bar where the band goes. A locked value tells a person a number
    // exists and is being withheld from them; for an item with no comparable
    // awards, no number exists at all, and the honest screen says so.
    //
    // What it still guards is the original property, and the more important
    // one: nothing here invents a figure.
    expect(html).toContain(page.noData)
    expect(html).toContain(page.noDataHelp)
    expect(html).not.toContain('20,34</strong>')
    // The `won` row is gone with the band it belonged to; `market` stays
    // locked, because a market price genuinely is an Essencial feature we hold
    // and do not show, which is what a locked bar is for.
    expect(html).toContain(page.market)
    expect(html).not.toContain(page.ceilingLabel)
  })

  it('names what is hidden for a screen reader', () => {
    // Still true of the one bar that remains — see above.
    expect(html).toContain(page.lockedValue)
  })

  describe('when the gate allowed a band', () => {
    // The numbers a real gated band carries: five comparables, quartiles
    // inside the spread limit. `price-band.test.ts` owns whether the gate
    // would *produce* this; here it has, and the question is what renders.
    const BAND = { low: 18, median: 20.34, high: 24, sampleSize: 7 }
    const withBand = render({ band: BAND })

    it('prints the range winners actually closed at', () => {
      expect(withBand).toContain('18,00')
      expect(withBand).toContain('24,00')
      expect(withBand).toContain(page.won)
    })

    it('stops saying there is no data, and stops locking the ceiling', () => {
      expect(withBand).not.toContain(page.noData)
      // The headline ceiling is a real figure now: 20% off the median.
      expect(withBand).toContain('16,27')
    })

    it('labels the ceiling and shows what it was calculated from', () => {
      // Framing rule 3, legal brief §2.2. Both strings were approved copy
      // that rendered nowhere at all until this card.
      expect(withBand).toContain(page.ceilingLabel)
      expect(withBand).toContain(page.inputsLabel)
      expect(withBand).toContain(page.bandEstimate)
      expect(withBand).toContain('7 editais encerrados')
    })

    it('offers the margin as an input, because the copy promises one', () => {
      // `maxNote` has said "a margem que você escolher" since before there was
      // a control to choose with.
      expect(withBand).toContain(page.marginLabel)
      expect(withBand).toContain('type="number"')
      expect(withBand).toContain(page.maxNote)
    })
  })

  it('leads to the plan as a real link, never a disabled button', () => {
    // The constant, not the literal: `/conta/plano` is F2's and does not exist
    // until M5, so R2 points every plan control at the offer. Asserting the
    // address would pin the dead end this project just removed, and would fail
    // again the day F2 flips it back.
    expect(html).toContain(PLAN_HREF)
    expect(html).toContain(page.cta)
    expect(html).not.toContain('disabled=""')
  })

  it('lets the reader move between the tender’s items', () => {
    expect(html).toContain(`/radar/edital/${TENDER.id}/preco?`)
    expect(html).toContain('item=2')
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

describe('PriceView · the AI notice (legal brief §2.2 rule 5)', () => {
  const notice = `${messages.ai.disclaimer} ${messages.ai.notLegalAdvice}`

  it('carries the notice, because this screen shows money', () => {
    // Rule 5 says every result screen, not only the screening. This one prints
    // an estimate read out of the edital and a ceiling derived from it, which
    // makes it the screen where a number is most likely to be read as advice.
    expect(render()).toContain(notice)
  })

  it('does not claim to be legal or accounting advice', () => {
    expect(render()).toContain(messages.ai.notLegalAdvice)
  })

  it('keeps the notice off the states that show no result at all', () => {
    expect(render({ status: { kind: 'analyzing' }, tender: null })).not.toContain(notice)
    expect(render({ status: { kind: 'notFound' }, tender: null })).not.toContain(notice)
  })
})

/** The item chips are links too, and were the last ones still dropping it. */
describe('the item chips carry the search', () => {
  it('keeps the search alongside the item, not instead of it', () => {
    const html = render({ item: 1 })
    expect(html).toContain('cnpj=51885242000140')
    expect(html).toContain('item=2')
    expect(html).not.toContain(`href="/radar/edital/${TENDER.id}/preco?item=`)
  })
})
