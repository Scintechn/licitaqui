import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PLAN_HREF } from '@/lib/routes'
import { priceHref, tenderHref } from '@/lib/radar/client'
import { format, messages } from '@/lib/messages'
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

  /**
   * Sci opened a two-item edital and landed on item 2, which has no awards —
   * *"Ainda sem dados de vencedores para este item"* on a screen called **Até
   * quanto ofertar**. The default now prefers an item a band can exist for.
   */
  it('prefers an item with a published winner when none was asked for', () => {
    const items = [
      { ...ITEMS[0], number: 1, hasAward: false },
      { ...ITEMS[0], number: 2, hasAward: true },
    ]
    expect(chooseItem(items, null)?.number).toBe(2)
  })

  it('still honours ?item=, even onto an item with no winner', () => {
    const items = [
      { ...ITEMS[0], number: 1, hasAward: false },
      { ...ITEMS[0], number: 2, hasAward: true },
    ]
    expect(chooseItem(items, 1)?.number).toBe(1)
  })

  it('falls back to the first when no item has one, rather than showing nothing', () => {
    const items = [
      { ...ITEMS[0], number: 1, hasAward: false },
      { ...ITEMS[0], number: 2, hasAward: null },
    ]
    expect(chooseItem(items, null)?.number).toBe(1)
  })

  it('honours ?item= when the tender has that one', () => {
    expect(chooseItem(ITEMS, 2)?.number).toBe(2)
  })

  it('falls back rather than showing nothing for an item that is not there', () => {
    expect(chooseItem(ITEMS, 99)?.number).toBe(1)
    expect(chooseItem([], 1)).toBeNull()
  })
})

describe('the contract between the entry link and the screen', () => {
  // **This is the defect this branch shipped and had to fix**, pinned as two
  // facts rather than as a screen test: `environment: 'node'` means effects do
  // not run, so the fetch itself cannot be exercised here.
  //
  // What can be pinned is *why* the screen must resolve its own item. If both
  // of these hold and `price-screen.tsx` returns early on a null item, the
  // band is never requested — and on a single-item tender there is no chip to
  // set `?item=`, so it is unreachable forever.

  it('the only link into this screen carries no item', () => {
    expect(priceHref(TENDER.id, SEARCH)).not.toContain('item=')
  })

  it('so the item on screen is the first one, and that is what must be priced', () => {
    expect(chooseItem(TENDER.items, null)?.number).toBe(TENDER.items[0].number)
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
    // **This assertion is inverted, not deleted** — a deleted guard on this
    // component is how the Objeto block's position was silently reverted once
    // already (`cc4b766`), and the reasoning it carried was the defect.
    //
    // It used to read `toContain(page.market)`, justified by *"a market price
    // genuinely is an Essencial feature we hold and do not show, which is what
    // a locked bar is for."* **Every clause of that is false.** Nothing in the
    // repository computes a market price — no job, no column, no API field —
    // so there was nothing held; and `0002_plan_limits` grants `market_price`
    // to `pro` alone, so it was not an Essencial feature either. Sci saw it
    // from the screen on 2026-10-05 and read it exactly as it was built to be
    // read: *"this rectangle makes me feel the price will be revealed."*
    // A literal, because `radar.price.market` is deleted from the catalogue
    // too — an approved string rendering nowhere is itself one of the five
    // instances CLAUDE.md names (`radar.list.changeCompany`). The words are
    // written out here so this guard keeps working with no key to point at,
    // and so the row cannot return unnoticed.
    expect(html).not.toContain('Preço de mercado')
    expect(html).not.toContain(page.ceilingLabel)
  })

  it('shows no locked bar at all when no number is being withheld', () => {
    // The screen-reader assertion that used to live here named `lockedValue`
    // on "the one bar that remains". There is no such bar in this state now:
    // the `won` row is gone with its band, and `market` is deleted. A lock
    // announces that a number exists and this plan does not include it, so
    // announcing one here would be the false half of E9's own complaint.
    expect(html).not.toContain(page.lockedValue)
  })

  describe('the plan offer', () => {
    it('is shown to someone who does not have the plan', () => {
      expect(render({ item: 1, showPlanCta: true })).toContain(page.cta)
    })

    it('is not shown to someone who already has it', () => {
      // Gating the band made this visible: the button reads "Ver plano
      // Essencial" and rendered unconditionally, including beside a band the
      // subscriber had just been shown.
      const band = { low: 18, median: 20.34, high: 24, sampleSize: 7 }
      expect(render({ item: 1, band, showPlanCta: false })).not.toContain(page.cta)
    })

    it('is shown to an unentitled visitor even when the item has no band', () => {
      // **The regression the first version of this fix introduced.** Driving
      // the CTA off `bandLocked` alone hid the upsell from exactly the people
      // it is for: an unentitled visitor on an item with no band gets `ready`
      // with `band: null`, indistinguishable from a subscriber's empty item
      // unless somebody says which. The server does, before this renders:
      // `readPriceBandEntitlement` in the page, passed down as `showPlanCta`.
      const out = render({ item: 1, bandLocked: false, showPlanCta: true })
      expect(out).toContain(page.noData)
      expect(out).toContain(page.cta)
    })
  })

  describe('when the plan does not include the band', () => {
    const locked = render({ item: 1, bandLocked: true })

    it('locks it, rather than saying the data is missing', () => {
      // A visitor told "ainda sem dados de vencedores" would conclude the
      // product has nothing, when in fact it has something they have not
      // bought. This is the honest use of a locked value, and the reason the
      // three states exist.
      expect(locked).toContain(page.lockedValue)
      expect(locked).not.toContain(page.noData)
    })

    it('still leads to the plan', () => {
      expect(locked).toContain(PLAN_HREF)
      expect(locked).toContain(page.cta)
    })

    it('shows no band and no margin control', () => {
      expect(locked).not.toContain(page.marginLabel)
      expect(locked).not.toContain(page.ceilingLabel)
    })
  })

  describe('when the gate allowed a band', () => {
    // The numbers a real gated band carries: five comparables, quartiles
    // inside the spread limit. `price-band.test.ts` owns whether the gate
    // would *produce* this; here it has, and the question is what renders.
    const BAND = { low: 18, median: 20.34, high: 24, sampleSize: 7 }
    // `item: 1`, not the default `item: null`. The first version of this block
    // rendered a band on top of `item: null` — a combination the client cannot
    // produce, because `price-screen.tsx` only asks for a band once it has
    // resolved an item. It passed *because* of the defect it should have
    // caught: the screen was asking for nothing, and the test was asserting a
    // state production could never reach.
    const withBand = render({ item: 1, band: BAND })

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
      expect(withBand).toContain('7 compras públicas')
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

  /**
   * **D34, and it is a reachability test rather than a second copy of
   * `item-picker.test.tsx`.** §4b's recurring defect is a test that exercises
   * the unit and never asks whether anything can reach it — a menu whose own
   * test rendered the component while nothing rendered the trigger. The picker
   * has its own file; what this asserts is that *this screen* draws it on a
   * long edital, and still draws the plain list on a short one.
   */
  it('collapses the item list once the edital is long enough to scroll', () => {
    const long = {
      ...TENDER,
      items: Array.from({ length: 31 }, (_, index) => ({
        ...ITEMS[0],
        number: index + 1,
        description: `Item de teste ${index + 1}`,
      })),
    } as unknown as TenderDetail
    const out = render({ tender: long })
    /**
     * **Scoped to the picker's own markup, not to the page.** `toContain(
     * '<summary')` was the first version and it is the #190/D30 defect — a
     * substring relation wearing an ancestor relation's clothes: this screen
     * has three other `<details>` producers (`LongText` for the item,
     * `MatchedList`, `EvidenceRow`), so swapping the picker back for a flat
     * list and leaving one long description anywhere would have passed.
     */
    expect(out).toContain('<details class="group rounded-card')
    expect(out).toContain(copy.opportunity.items.showMore)
    expect(out).toContain(format(copy.opportunity.items.showing, { shown: 1, total: 31 }))
    expect(out).toContain('type="search"')
  })

  it('leaves a two-item edital the plain list it has always had', () => {
    // The other half of the boundary, asserted about its own render rather
    // than about the long one's: `html` is the two-item fixture.
    expect(html).not.toContain('<details class="group rounded-card')
    expect(html).not.toContain('type="search"')
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

describe('the price screen after Sci\'s journey (D25 part 5)', () => {
  const html = render()

  it('no longer tells the A4 story', () => {
    // Sci: *"The Exemplo real must be removed."* The keys went with it —
    // a string rendered nowhere is this repo's named defect.
    expect(html).not.toContain('papel A4')
    expect(html).not.toContain('35,87')
  })

  it('lists the other items by name, not as numbered chips', () => {
    // The chips were `min-h-8` — 32px, under the 44px `--spacing-touch` — and
    // a bare ordinal says nothing about what the reader would be pricing.
    expect(html).toContain('min-h-touch')
    expect(html).not.toContain('font-mono text-label no-underline')
  })
})

/**
 * D25 (3) — the action bar on the preço screen, which is the end of the
 * journey.
 *
 * The only thing ahead of a reader here is the plan that unlocks the band, so
 * the bar exists exactly where that button does and nowhere else. An entitled
 * reader has no next action, and a bar proposing one would be inventing it —
 * the same defect as the plan CTA that rendered to Essencial subscribers until
 * `showPlanCta` was passed from the server.
 */
describe('the action bar', () => {
  function bar(html: string): string | null {
    const at = html.indexOf('sticky bottom-0')
    return at === -1 ? null : html.slice(html.lastIndexOf('<div', at))
  }

  it('offers the plan once, in the bar, and not twice', () => {
    const page = render({ showPlanCta: true })
    const block = bar(page)
    expect(block).not.toBeNull()
    expect(block).toContain(messages.radar.price.cta)
    expect(block).toContain(PLAN_HREF)
    // The in-page full-width button is gone, not hidden: it used to offer the
    // same action under the same accessible name, and below `lg` both were on
    // screen at once.
    expect(page.split(`href="${PLAN_HREF}"`), 'one link to the plan').toHaveLength(2)
    expect(block).toContain(messages.common.tender)
    expect(block).toContain('z-40')
    // **The slot says "Edital" and has to go to the edital.** `backHref` on
    // this screen is `screeningHref` — the triagem — so the first version sent
    // a reader somewhere its own label did not name, and the test that only
    // checked the words was green.
    expect(block).toContain(tenderHref(TENDER.id, SEARCH).replaceAll('&', '&amp;'))
    expect(block).not.toContain('/triagem')
    const html = render({ showPlanCta: true })
    expect(html.indexOf('sticky bottom-0')).toBeGreaterThan(html.indexOf('</main>'))
  })

  it('offers nothing to a reader who already has the plan', () => {
    // `showPlanCta` is the server's answer, read once in the page. The screen
    // must not draw a second, more prominent "Ver plano Essencial" for someone
    // looking at the band they already paid for.
    expect(bar(render({ showPlanCta: false }))).toBeNull()
  })
})

/**
 * The evidence ladder (E22).
 *
 * These assert the **rungs**, not the arithmetic — `price-band.test.ts` owns
 * that. What matters here is that each rung says something different, because
 * one state saying "ainda sem dados de vencedores" to every item below the gate
 * was the defect: measured 2026-10-01, it was wrong for ten items in every
 * eleven it appeared on.
 */
/**
 * The markup of each evidence row, bounded by the next row — so an assertion
 * about "this row" cannot reach the rest of the document.
 */
function evidenceRows(html: string): string[] {
  return html.split('data-testid="evidence-row-layout"').slice(1)
}

describe('PriceView — the evidence ladder', () => {
  const sample = (tenderId: string, value: number, description: string | null) => ({
    tenderId,
    value,
    description,
  })

  /**
   * **The ids are Compras.gov.br purchase keys, not PNCP control numbers.**
   * They used to be `9900000000000i-1-000001/2026` here, which was already
   * wrong when B35 moved the evidence to the catalogue: `PriceSample.tenderId`
   * now carries `catalog_prices.id_compra`. The shape matters to this file
   * since D37, because the screen prints it — a fixture in the old shape would
   * render no citation and the assertions below would pass on an empty row.
   *
   * `929909 · 06 · 0000(i+1) · 2026`, built from the one real row we hold
   * (`test_catalog_prices.py`'s `RAW_ROW`).
   *
   * **`i + 1` because no real purchase number is `00000`** — 0 of the 31
   * measured ids have one. (A guard refusing that shape briefly existed in
   * `compra.ts` and was removed as an unmeasured constraint whose justifying
   * case was unreachable; this helper keeps counting from 1 because that is
   * what the data looks like, not because anything forces it.)
   */
  const compraId = (i: number) => `92990906${String(i + 1).padStart(5, '0')}2026`


  /**
   * The **catalogue** rung, which is what every assertion below is about: its
   * wording is the identity wording, and it is earned by an exact code match.
   * D40 added `source`, and spelling it out here turns these from fixtures into
   * regression guards — a change that gave the catalogue rung the fallback's
   * heading or dropped `evidenceHelp` from it fails in this block.
   */
  const thin = (count: number) => ({
    editais: count,
    source: 'catalog' as const,
    samples: Array.from({ length: Math.min(count, 4) }, (_unused, i) =>
      sample(compraId(i), 204 - i, `PERFURADOR DE PAPEL ${i} FUROS`),
    ),
  })

  it('still says nothing was found when nothing was', () => {
    // The rung that was always correct, and must stay reachable: no band and no
    // evidence is genuinely "no number exists for anybody".
    const html = render({ item: 1, bandLocked: false, evidence: null })
    expect(html).toContain(page.noData)
    expect(html).toContain(page.noDataHelp)
  })

  it('shows a single result as a result, and says why there is no faixa', () => {
    const html = render({ item: 1, bandLocked: false, evidence: thin(1) })
    expect(html).toContain('Encontramos 1 resultado parecido')
    // The price, and the words it closed under — neither is evidence alone.
    expect(html).toContain('R$ 204,00')
    expect(html).toContain('PERFURADOR DE PAPEL 0 FUROS')
    // The sentence that explains the absent faixa without promising one.
    expect(html).toContain('Mostramos a faixa quando encontramos pelo menos 5 editais')
    expect(html).toContain('Neste item encontramos 1')
    // **The rung is not a weaker band.**
    expect(html).not.toContain(page.noData)
  })

  it('pluralises the thin rung and prints every result behind the count', () => {
    const html = render({ item: 1, bandLocked: false, evidence: thin(3) })
    expect(html).toContain('Encontramos 3 resultados parecidos')
    expect(html).toContain('Neste item encontramos 3')
    for (const i of [0, 1, 2]) {
      expect(html).toContain(`PERFURADOR DE PAPEL ${i} FUROS`)
    }
  })

  /**
   * D37 — the citation.
   *
   * **What these can prove**: that the identifier is on the wire *and in the
   * markup*, that it is not a React key any more, and that an unreadable id
   * degrades to the row as it was. **What they cannot**: that a reader can
   * click it, that the clipboard receives it, or that the row is drawn
   * correctly in a 720px column — `environment: 'node'` has no events and no
   * boxes (§4c). `e2e/journeys/price-evidence-ladder.spec.ts` carries those.
   */
  it('prints the purchase each result came from, beside its price', () => {
    const html = render({ item: 1, bandLocked: false, evidence: thin(3) })

    /**
     * **Per row, because "beside its price" is a structural claim.** Asserting
     * `toContain(id)` three times over the whole document passes just as
     * happily when all three ids land in one row, or when row 0's id is drawn
     * next to row 1's price — which is the defect the title names. The id also
     * appears **twice per row** (the visible span and the button's accessible
     * name), so a document-wide count cannot separate those either.
     */
    // **Split on the row's own marker, not on `<li`.** `html.split('<li')` is
    // document-wide — `MatchedList` emits `<li>`s on the top rung — and its
    // final chunk runs to the end of the page, so the "no other row's id" and
    // "has its price" checks on the last row were being made over the footer
    // and the action bar as well.
    const rows = evidenceRows(html)
    expect(rows).toHaveLength(3)
    rows.forEach((row, i) => {
      expect(row, `row ${i} lost its identifier`).toContain(compraId(i))
      expect(row, `row ${i} lost its price`).toContain(`R$ ${204 - i},00`)
      // …and carries no other row's identifier.
      for (const other of [0, 1, 2].filter((n) => n !== i)) {
        expect(row, `row ${i} carried row ${other}'s identifier`).not.toContain(compraId(other))
      }
    })

    // The control that carries it off the page, with the copy already approved.
    expect(html).toContain(messages.common.copy)
    expect((html.match(/data-testid="copy-compra"/g) ?? []).length).toBe(3)
  })

  it('names no false provenance for the identifier', () => {
    // **The defect this card could most easily have shipped.** The id is a
    // Compras.gov.br purchase key, so reusing the opportunity screen's approved
    // "o Id PNCP" would have put an authoritative sentence on screen saying the
    // wrong thing about where a number came from.
    const html = render({ item: 1, bandLocked: false, evidence: thin(2) })
    expect(html).not.toContain(messages.radar.opportunity.copyIdContext)
    expect(html).not.toContain('PNCP')
  })

  it('renders the result unchanged when the identifier cannot be read', () => {
    // A stored value we cannot parse is shown as no identifier at all, never a
    // half-repaired one — `pncp.ts`'s contract, for `pncp.ts`'s reason.
    const html = render({
      item: 1,
      bandLocked: false,
      evidence: {
        editais: 1,
        // `source` is D40's, and `'catalog'` is the right value here rather
        // than a cast: the citation D37 added is drawn on the catalogue rung,
        // so an unparseable id is a *catalogue* row we cannot name. tsc found
        // this fixture during the rebase — the field is required, and that is
        // the point of it being required.
        source: 'catalog' as const,
        samples: [sample('not-an-id', 204, 'PERFURADOR DE PAPEL 2 FUROS')],
      },
    })
    expect(html).toContain('R$ 204,00')
    expect(html).toContain('PERFURADOR DE PAPEL 2 FUROS')
    expect(html).not.toContain('data-testid="copy-compra"')
    expect(html).not.toContain('not-an-id')
  })

  /**
   * The breakpoint is pinned as a string because the numbers *are* the fix, the
   * way `radar-view.test.tsx` pins D30's. A later `@min-[900px]:` added here
   * would be D29 again — a question about the window asked by a block that
   * lives in a 720px column — and this assertion is what would fail.
   */
  it('asks the container about its width, never the viewport', () => {
    const html = render({ item: 1, bandLocked: false, evidence: thin(2) })
    expect(html).toContain('@container')
    expect(html).toContain('@min-[520px]:flex-row')
    const breakpoints = html.match(/@min-\[\d+px\]:/g) ?? []
    expect(new Set(breakpoints), 'one breakpoint, and it is below 720').toEqual(
      new Set(['@min-[520px]:']),
    )
    /**
     * **The spelling, not the utility.** Listing `md:flex-row` and friends
     * guards one property and waves through `lg:grid-cols-2` or
     * `md:justify-between` — and a named breakpoint on an unrelated utility is
     * exactly what the D30 sweep missed in `tender-items.tsx`, which is D32.
     * So: no Tailwind viewport prefix anywhere in this row, in any spelling.
     */
    const rows = evidenceRows(html)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      // **The whole row, not up to the first `</span>`.** Slicing there covered
      // the `<li>` and the layout `<div>` only, so a `md:` on the right-hand
      // group, the identifier, the price or inside `CopyCompra` sailed through
      // the check whose comment promised "anywhere in this row".
      expect(row, 'a viewport breakpoint inside the app shell').not.toMatch(
        /\b(sm|md|lg|xl|2xl):/,
      )
    }
  })

  it('draws no faixa, median or preço-alvo on a thin rung', () => {
    // A figure drawn through one or two prices is a confident-looking number
    // with nothing behind it. `MIN_SAMPLE` and `MAX_SPREAD` are what earn one.
    const html = render({ item: 1, bandLocked: false, evidence: thin(2) })
    expect(html).not.toContain('–') // the en dash `bandRange` joins a band with
    expect(html).not.toContain(page.ceilingLabel)
    expect(html).not.toContain(page.marginLabel)
  })

  it('shows the count and what was matched at a lock, and no price at all', () => {
    // **Sci, 2026-10-02.** The top rung withholds the values because four
    // sampled prices rebuild the band. What stays is the count and the matched
    // descriptions — the one thing the reader cannot otherwise check.
    const html = render({
      item: 1,
      bandLocked: true,
      evidence: { editais: 6, matched: ['PERFURADOR DE PAPEL 2 FUROS', 'PERFURADOR 2 FUROS AÇO'] },
    })
    expect(html).toContain('Encontramos 6 compras públicas do mesmo item')
    expect(html).toContain('PERFURADOR DE PAPEL 2 FUROS')
    expect(html).toContain(page.lockedValue)
    // **No winner price rendered**, asserted as the absence of the element that
    // would carry one rather than as a money regex over the page. A regex was
    // written first and failed on a correct render: "R$ 3,74" is the *edital's
    // own* estimated value, which this screen has always shown and should. The
    // question is whether a past winner's price appears, and the only thing
    // that prints one is `EvidenceRow`.
    expect(html).not.toContain('tabular-nums">R$')
    expect(html).not.toContain(page.noData)
  })

  it('renders a lock with no evidence without inventing a count', () => {
    // The in-flight case: `bandLocked` defaults to true before the answer
    // lands, so this pair is reachable on every first paint.
    const html = render({ item: 1, bandLocked: true, evidence: null })
    expect(html).toContain(page.lockedValue)
    expect(html).not.toContain('Encontramos')
  })
})

describe('PriceView — the sentence that would contradict itself', () => {
  /**
   * Six editais, four results — the shape `priceEvidence` actually returns
   * above the cap. The first fixture here carried `editais: 6` with **two**
   * samples, which that function cannot produce, and it was the reason this
   * block exercised the suppression without ever exercising the cap.
   */
  const scattered = {
    editais: 6,
    // D40: the catalogue rung, so this block keeps pinning the identity copy.
    source: 'catalog' as const,
    samples: [
      { tenderId: 'a-1-000001/2026', value: 204, description: 'PERFURADOR DE PAPEL' },
      { tenderId: 'b-1-000001/2026', value: 9.5, description: 'CADERNO BROCHURA' },
      { tenderId: 'c-1-000001/2026', value: 188, description: 'PERFURADOR 2 FUROS' },
      { tenderId: 'd-1-000001/2026', value: 12, description: 'CADERNO CAPA DURA' },
    ],
  }

  it('never states a count larger than the results it draws', () => {
    // **The defect this replaced.** `priceEvidence` caps `samples` at four and
    // leaves `editais` uncapped, so the count was `editais` over at most four
    // rows: at six editais the screen read "Encontramos 6 resultados
    // parecidos" above four results — and `evidenceHelp`, the only string that
    // would have reconciled them, is suppressed at exactly this rung because
    // above the floor it is false. Reachable for an entitled reader too, since
    // a spread failure sends everyone down this branch.
    const html = render({
      item: 1,
      bandLocked: false,
      evidence: {
        source: 'catalog',
        editais: 6,
        samples: [1, 2, 3, 4].map((n) => ({
          tenderId: `t${n}-1-000001/2026`,
          value: 100 + n,
          description: `PERFURADOR ${n}`,
        })),
      },
    })
    expect(html).toContain('Encontramos 4 resultados parecidos')
    expect(html).not.toContain('Encontramos 6')
    // And it is four because four rows are drawn, not by coincidence.
    expect(html.match(/PERFURADOR \d/g)).toHaveLength(4)
  })

  it('counts only the results it can draw as money', () => {
    // `moneyExactNonZero` refuses below half a centavo while `priceEvidence`
    // filters on `> 0`, so a row could print a description with no price —
    // against `EvidenceRow`'s own rule that neither half is evidence alone.
    // Not live (the corpus minimum is R$ 0,0300) and cheap to close.
    const html = render({
      item: 1,
      bandLocked: false,
      evidence: {
        source: 'catalog',
        editais: 2,
        samples: [
          { tenderId: 'a-1-000001/2026', value: 204, description: 'PERFURADOR DE PAPEL' },
          { tenderId: 'b-1-000001/2026', value: 0.004, description: 'PARAFUSO M3' },
        ],
      },
    })
    expect(html).toContain('Encontramos 1 resultado parecido')
    expect(html).not.toContain('PARAFUSO M3')
  })

  it('falls back to the empty card when no result can be drawn', () => {
    // A count of zero would print "1": `Intl.PluralRules('pt-BR').select(0)`
    // is `one`, and none of these strings carries a `=0` branch.
    const html = render({
      item: 1,
      bandLocked: false,
      evidence: {
        source: 'catalog',
        editais: 1,
        samples: [{ tenderId: 'a-1-000001/2026', value: 0.004, description: 'PARAFUSO M3' }],
      },
    })
    expect(html).toContain(page.noData)
    expect(html).not.toContain('Encontramos')
  })

  it('does not promise a faixa at six editais while showing none', () => {
    // `MIN_SAMPLE` is necessary, not sufficient: `MAX_SPREAD` must pass too. So
    // `evidenceHelp` — "Mostramos a faixa quando encontramos pelo menos 5
    // editais… Neste item encontramos 6" — would sit directly above no faixa.
    // Reachable: ~1 in 5 of the items that reach five editais fails on spread.
    const html = render({ item: 1, bandLocked: false, evidence: scattered })
    expect(html).not.toContain('Mostramos a faixa quando encontramos pelo menos 5 editais')
    // The count states the rows drawn, never `editais` — see the cap test above.
    expect(html).toContain('Encontramos 4 resultados parecidos')
    // The results themselves still render: suppressing the explanation must not
    // suppress the evidence.
    expect(html).toContain('PERFURADOR DE PAPEL')
    expect(html).toContain('CADERNO BROCHURA')
  })

  it('still explains itself below the floor, where the sentence is true', () => {
    // Below the floor `priceEvidence` returns one sample per edital, so the
    // count, the rows and `editais` are all the same number by construction.
    const html = render({
      item: 1,
      bandLocked: false,
      evidence: { editais: 4, source: 'catalog', samples: scattered.samples },
    })
    expect(html).toContain('Mostramos a faixa quando encontramos pelo menos 5 editais')
    expect(html).toContain('Neste item encontramos 4')
  })
})

/**
 * D38 — the whole description is reachable.
 *
 * These pin the **mechanism** only: that the markup contains the full text and
 * a real `<details>` rather than a clamp. Whether a reader can actually open it
 * is a *result*, and `environment: 'node'` has no boxes and runs no effects, so
 * that half is `price-description.spec.ts` in `e2e/`. §4c — the unit test pins
 * the mechanism, the journey pins the result, and saying which is which is the
 * point.
 */
describe('PriceView — the full description (D38)', () => {
  /** 19× apart, the spread that prompted the card. */
  const LONG =
    'Cessão Temporária de Direitos Sobre Programas de Computador Locação de Software ' +
    'Cessão de direito de uso de solução integrada de gestão com suporte técnico, ' +
    'treinamento presencial e atualizações legais por 12 meses'

  const longItem: TenderItemView = { ...ITEMS[0], description: LONG }

  it('puts the entire description in the markup, not only the trimmed head', () => {
    const html = render({ item: 1, tender: { ...TENDER, items: [longItem] } })
    // The tail is the half a reader needs to judge comparability, and it is the
    // half truncation removed.
    expect(html).toContain('atualizações legais por 12 meses')
  })

  it('uses a real disclosure, never a clamp', () => {
    const html = render({ item: 1, tender: { ...TENDER, items: [longItem] } })
    expect(html).toContain('<details')
    // `format.ts` and D25(1): a clamp hides that there is more and leaves the
    // whole string in the accessibility tree, so a screen-reader user hears
    // everything while a sighted one sees two lines.
    expect(html).not.toContain('line-clamp')
  })

  it('offers the control in words a reader can act on', () => {
    const html = render({ item: 1, tender: { ...TENDER, items: [longItem] } })
    expect(html).toContain(copy.opportunity.items.more)
    expect(html).toContain(copy.opportunity.items.less)
  })

  it('does not wrap a short description in a disclosure', () => {
    // `ITEMS[0]` is "Pilha alcalina AA, embalagem com 2" — nothing to open, so
    // offering the gesture would be noise on the common case.
    const html = render({ item: 1 })
    expect(html).toContain('Pilha alcalina AA, embalagem com 2')
    expect(html).not.toContain('<details')
  })

  it('keeps the item number beside the description it belongs to', () => {
    // The prefix rides inside the summary. Rendered outside it, "Item 1 ·"
    // would be stranded above a block that opens away from it.
    const html = render({ item: 1, tender: { ...TENDER, items: [longItem] } })
    const summary = html.slice(html.indexOf('<details'), html.indexOf('</summary>'))
    expect(summary).toContain('Item 1 ·')
  })
})

/**
 * **D40 — the fallback rung's words**, pinned as the *mechanism* (§4c).
 *
 * `renderToStaticMarkup` can say which strings are in the markup and nothing
 * about whether a reader reaches them, so the *result* half is
 * `e2e/journeys/service-evidence.spec.ts`. What this block owns is the join
 * that produced the defect: the rung's wording is decided by
 * `PriceEvidence.source` and by the item's `kind`, and those two come from
 * different files.
 *
 * Every assertion here has a positive and a negative half on purpose. "The
 * identity sentence is gone" passes for free on an empty render, so each test
 * also proves the rung itself drew.
 */
describe('PriceView — the awards fallback rung (D40)', () => {
  const SERVICE_ITEM: TenderItemView = {
    ...ITEMS[0],
    number: 1,
    description: 'Licença de uso de software de gestão, por 12 meses',
    kind: 'S',
  }

  const MATERIAL_ITEM: TenderItemView = { ...ITEMS[0], number: 1, kind: 'M' }

  function screen(item: TenderItemView, overrides: Partial<PriceViewProps> = {}): string {
    return renderToStaticMarkup(
      <PriceView
        tenderId={TENDER.id}
        tender={{ ...TENDER, items: [item] } as unknown as TenderDetail}
        item={1}
        status={{ kind: 'ready' }}
        backHref={`/radar/edital/${TENDER.id}/triagem`}
        search={SEARCH}
        bandLocked={false}
        {...overrides}
      />,
    )
  }

  /**
   * Sci's own screen, 2026-10-05: four past results on a software-licence
   * item, R$ 339,99 to R$ 6.363,00. A 19× spread is exactly why no band may be
   * drawn over it and exactly why the full description has to be reachable.
   */
  const AWARDS_RUNG = {
    editais: 4,
    source: 'awards' as const,
    samples: [
      { tenderId: 'a-1-000001/2026', value: 6363, description: 'LICENCA ANUAL ERP CORPORATIVO' },
      { tenderId: 'b-1-000001/2026', value: 2400, description: 'CESSAO DE USO DE SISTEMA WEB' },
      { tenderId: 'c-1-000001/2026', value: 890.5, description: 'LOCACAO DE SOFTWARE DE GESTAO' },
      { tenderId: 'd-1-000001/2026', value: 339.99, description: 'LICENCA DE USO ANTIVIRUS' },
    ],
  }

  it('draws the results and drops the preço-máximo heading, on a service', () => {
    const html = screen(SERVICE_ITEM, { band: null, evidence: AWARDS_RUNG })

    // It drew: the rung is here, so the negatives below mean something.
    expect(html).toContain('Encontramos 4 resultados parecidos')
    expect(html).toContain('R$ 6.363,00')
    expect(html).toContain('R$ 339,99')
    expect(html).toContain('LICENCA ANUAL ERP CORPORATIVO')

    // The heading Sci approved for this rung, and the one it replaces.
    expect(html).toContain(page.fallbackTitle)
    expect(html).not.toContain(page.maxTitle)
  })

  it('says "da mesma área" and never "o mesmo produto", on a service', () => {
    const html = screen(SERVICE_ITEM, { band: null, evidence: AWARDS_RUNG })

    expect(html).toContain(page.fallbackHelp)
    // `evidenceHelp` promises the faixa at five editais. The fallback never
    // draws one at any count, so the sentence is false here regardless.
    expect(html).not.toContain('Mostramos a faixa quando encontramos pelo menos 5 editais')
    expect(html).not.toContain('o mesmo produto')
    // The locked rung's identity sentence is unreachable without a band, and
    // this asserts it rather than assuming it.
    expect(html).not.toContain('do mesmo item')
  })

  it('draws no band, no range and no margin control on the fallback rung', () => {
    const html = screen(SERVICE_ITEM, { band: null, evidence: AWARDS_RUNG })

    expect(html).not.toContain(page.ceilingLabel)
    expect(html).not.toContain(page.marginLabel)
    // **The rendered form, not the ICU source.** `page.lockedEvidence` begins
    // `{count, plural, one {` — a literal no markup can contain, so asserting
    // a slice of the raw string could not fail and would read as coverage
    // (§4b). This is the sentence `format` would actually produce.
    expect(html).not.toContain('compras públicas do mesmo item')
    // `bandRange` joins a band with an en dash; nothing else on this rung
    // prints one.
    expect(html).not.toContain(' – ')
  })

  it('shows the same heading to a material the catalogue could not match, and no sentence', () => {
    // The scope widened on 2026-10-05: the open materials the catalogue cannot
    // match take this rung too (counts in `docs/PRICE_BAND.md` §0.2, kept in
    // one place on purpose)
    // open materials take this rung too. `fallbackHelp` names serviços, so it
    // must NOT appear here — and no sentence is written in its place, because
    // the words are Sci's. Tracked in docs/CLAIMS.md.
    const html = screen(MATERIAL_ITEM, { band: null, evidence: AWARDS_RUNG })

    expect(html).toContain('Encontramos 4 resultados parecidos')
    expect(html).toContain(page.fallbackTitle)
    expect(html).not.toContain(page.maxTitle)
    expect(html).not.toContain(page.fallbackHelp)
    expect(html).not.toContain('Serviços raramente')
    expect(html).not.toContain('Mostramos a faixa quando encontramos pelo menos 5 editais')
  })

  it('keeps the catalogue rung exactly as B35 left it', () => {
    // The regression guard. Same four results, same item, `source: 'catalog'`
    // — the identity wording and the preço-máximo heading are earned there by
    // an exact code match, and D40 must not have taken them away.
    const html = screen(MATERIAL_ITEM, {
      band: null,
      evidence: { ...AWARDS_RUNG, source: 'catalog' as const },
    })

    expect(html).toContain('Encontramos 4 resultados parecidos')
    expect(html).toContain(page.maxTitle)
    expect(html).toContain('Mostramos a faixa quando encontramos pelo menos 5 editais')
    expect(html).not.toContain(page.fallbackTitle)
    expect(html).not.toContain(page.fallbackHelp)
  })

  it('does not promise a faixa to a service that has nothing', () => {
    // `noDataHelp` — "A faixa aparece quando já houver compras públicas
    // suficientes do mesmo item" — is two promises a service cannot keep:
    // `catalog_prices` holds no `kind = 'S'` row and the comparison available
    // is same-area, not same-item.
    const html = screen(SERVICE_ITEM, { band: null, evidence: null })

    expect(html).toContain(page.noData)
    expect(html).not.toContain(page.noDataHelp)
    // **And no heading at all.** `fallbackTitle` announces a list of similar
    // contracts; over "Ainda sem dados de vencedores" it would announce one
    // that is not there, and that is the common state — 92% of open service
    // items return no comparable. `maxTitle` is equally wrong, for the reason
    // this whole block exists.
    expect(html).not.toContain(page.fallbackTitle)
    expect(html).not.toContain(page.maxTitle)
  })

  it('refuses to draw a band over fallback evidence, even when handed both', () => {
    /**
     * **The forbidden pair, which the types permit and the route prevents.**
     *
     * `route.ts` makes a band and the fallback rung mutually exclusive on one
     * line. But `BandState`'s unlocked variant is
     * `{ band: PriceBand | null; evidence: PriceEvidence | null }` and
     * `PriceView` takes the two as independent props, so this combination
     * **compiles** — and before the `drawable` guard this component rendered
     * it: *"Venceu em compras do mesmo item"* with a `bandRange`, plus the
     * margin control, over a same-area comparison. That is the one failure the
     * card says a reader could not possibly detect.
     *
     * **This test exists because a mutation proved it was missing.** Reverting
     * `drawable` to `band` left the whole suite green; the guard was
     * defence-in-depth with nothing pinning it, which is the shape CLAUDE.md
     * calls a "later" in a comment.
     */
    const html = screen(SERVICE_ITEM, {
      band: { low: 100, median: 110, high: 120, sampleSize: 6 },
      evidence: AWARDS_RUNG,
    })

    // The band is refused in all three of the places it is drawn from.
    expect(html).not.toContain(page.won)
    expect(html).not.toContain(' – ') // the en dash `bandRange` joins with
    expect(html).not.toContain(page.marginLabel)
    expect(html).not.toContain(page.ceilingLabel)
    // And the rung it was handed alongside still draws, so this is not an
    // assertion about an empty page.
    expect(html).toContain(page.fallbackTitle)
    expect(html).toContain('Encontramos 4 resultados parecidos')
    expect(html).toContain('R$ 6.363,00')
  })

  it('still draws a band over CATALOGUE evidence, which is the whole point', () => {
    // The other half, so `drawable` cannot be a blanket refusal: the same band,
    // the same four results, `source: 'catalog'` — and the band must appear.
    const html = screen(MATERIAL_ITEM, {
      band: { low: 100, median: 110, high: 120, sampleSize: 6 },
      evidence: { ...AWARDS_RUNG, source: 'catalog' as const },
    })

    expect(html).toContain(page.won)
    expect(html).toContain(page.marginLabel)
  })

  it('never draws a service locked, not even while the request is in flight', () => {
    /**
     * **The in-flight state, which is every first paint.**
     *
     * `price-screen.tsx` sets `bandLocked = current === null || current.locked`,
     * so `true` is what this view is handed for the whole round trip — and D40
     * makes that round trip longer by adding a trigram query to it. Before the
     * fix this render drew *"Venceu em compras do mesmo item"* as a locked row
     * and *"Seu preço máximo de compra"* over a locked value, on an item where
     * no band can exist for anybody: `price-band.ts`'s own words, *"a locked
     * value tells a person a number exists and is being withheld from them."*
     *
     * Found by probing this exact prop combination, not by the tests that
     * existed — every D40 fixture above passes `bandLocked: false`.
     */
    const html = screen(SERVICE_ITEM, { bandLocked: true, band: null, evidence: null })

    expect(html).not.toContain(page.won)
    expect(html).not.toContain(page.maxTitle)
    // It rendered the honest card instead, so this is not an empty page: the
    // screen is up, the item is named, and the card says nothing was found —
    // with no heading over it, since there is no list to announce.
    expect(html).toContain(page.noData)
    expect(html).toContain('Licença de uso de software de gestão')
    expect(html).not.toContain(page.fallbackTitle)
  })

  it('still draws a MATERIAL locked in flight, which is the deliberate choice', () => {
    // The default is argued in `price-screen.tsx`: a locked bar replaced by a
    // band is an upgrade the reader watches happen. That argument needs a band
    // to be possible, which it is for a material — so D40 must not have
    // changed this.
    const html = screen(MATERIAL_ITEM, { bandLocked: true, band: null, evidence: null })

    expect(html).toContain(page.won)
    expect(html).toContain(page.maxTitle)
  })

  it('still explains itself to a material that has nothing, where the sentence is true', () => {
    // An unmapped material may yet be matched to an exact code and get a real
    // band, so `noDataHelp` and the preço-máximo heading both still describe
    // something that can happen.
    const html = screen(MATERIAL_ITEM, { band: null, evidence: null })

    expect(html).toContain(page.noData)
    expect(html).toContain(page.noDataHelp)
    expect(html).toContain(page.maxTitle)
  })
})
