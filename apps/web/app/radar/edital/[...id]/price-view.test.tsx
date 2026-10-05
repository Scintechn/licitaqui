import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PLAN_HREF } from '@/lib/routes'
import { priceHref, tenderHref } from '@/lib/radar/client'
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
describe('PriceView — the evidence ladder', () => {
  const sample = (tenderId: string, value: number, description: string | null) => ({
    tenderId,
    value,
    description,
  })

  const thin = (count: number) => ({
    editais: count,
    samples: Array.from({ length: Math.min(count, 4) }, (_unused, i) =>
      sample(`9900000000000${i}-1-000001/2026`, 204 - i, `PERFURADOR DE PAPEL ${i} FUROS`),
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
      evidence: { editais: 4, samples: scattered.samples },
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
