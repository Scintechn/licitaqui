import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messages, format } from '@/lib/messages'
import type { TenderItemView } from '@/lib/radar/contract'
import {
  COLLAPSE_FROM,
  ItemPicker,
  LIST_CAP,
  isPriceable,
  matchesQuery,
  priceableFirst,
} from './item-picker'

/**
 * D34, the arrangement half.
 *
 * **These tests pin the mechanism; `e2e/journeys/price-item-list.spec.ts` pins
 * the result** (CLAUDE.md §4c). `vitest.config.mts` has no jsdom, so this file
 * renders to a string: it can prove the whole list is in the markup, that the
 * chosen item is inside the `<summary>`, that the field is a search field and
 * that no viewport breakpoint governs the block — and it can prove the two pure
 * functions behave. It **cannot** tell a disclosure that opens from one that
 * renders and never opens, it cannot type into the box, and it has no boxes to
 * measure, which is the whole reason the browser file exists.
 */

const page = messages.radar.price
const itemCopy = messages.radar.opportunity.items
const SEARCH = { cnpj: '51885242000140', state: 'SP', q: 'papel', group: 'check' } as const
const TENDER_ID = '77817476000144-1-000034/2026'

function make(number: number, overrides: Partial<TenderItemView> = {}): TenderItemView {
  return {
    number,
    description: `Resma de papel A4 75 g/m², pacote com 500 folhas`,
    kind: 'M',
    quantity: '400.0',
    unit: 'Resma',
    unitEstimatedValue: '36.5000',
    totalValue: '14600.00',
    ncm: '48025590',
    judgmentCriterion: 'Menor preço',
    benefitId: 1,
    benefitName: 'Exclusivo ME/EPP',
    segment: null,
    relevance: null,
    hasAward: false,
    ...overrides,
  }
}

function run(count: number, overrides: Record<number, Partial<TenderItemView>> = {}) {
  return Array.from({ length: count }, (_, index) => make(index + 1, overrides[index + 1] ?? {}))
}

function render(list: TenderItemView[], chosen = list[0]): string {
  return renderToStaticMarkup(
    <ItemPicker tenderId={TENDER_ID} search={SEARCH} list={list} chosen={chosen} />,
  )
}

/** The markup inside the one `<summary>`, so a claim about it is about it. */
function summary(html: string): string {
  const found = html.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)
  expect(found, 'the collapsed list must have a summary').not.toBeNull()
  return (found as RegExpMatchArray)[1]
}

describe('matchesQuery', () => {
  it('folds the accent and the case, because the edital shouts in capitals', () => {
    const item = make(7, { description: 'CAFÉ TORRADO E MOÍDO, pacote 500 g' })
    expect(matchesQuery(item, 'cafe')).toBe(true)
    expect(matchesQuery(item, 'CAFÉ')).toBe(true)
    expect(matchesQuery(item, 'moido')).toBe(true)
  })

  it('narrows on every token rather than widening on any', () => {
    const papel = make(1, { description: 'Resma de papel A4 75 g/m²' })
    const caneta = make(2, { description: 'Caneta esferográfica azul' })
    expect(matchesQuery(papel, 'papel a4')).toBe(true)
    // "papel" matches and "azul" does not: an OR would have let this through.
    expect(matchesQuery(papel, 'papel azul')).toBe(false)
    expect(matchesQuery(caneta, 'caneta azul')).toBe(true)
  })

  it('searches the item number, which is often all the reader has', () => {
    // On a 251-item edital the number comes off the edital PDF and the
    // description has been cut at 70 characters.
    expect(matchesQuery(make(137), '137')).toBe(true)
    expect(matchesQuery(make(137), '999')).toBe(false)
  })

  it('keeps punctuation searchable', () => {
    // `product-key.ts`'s fold drops it; this one must not, or "75 g/m²" — which
    // is what a reader sees and would retype — finds nothing.
    expect(matchesQuery(make(1), 'g/m²')).toBe(true)
  })

  it('matches everything while the box is empty', () => {
    expect(matchesQuery(make(1), '')).toBe(true)
    expect(matchesQuery(make(1), '   ')).toBe(true)
  })
})

/**
 * **The ordering hook: present, and inert rather than wrong.**
 *
 * D34 ships the arrangement and leaves the priority half to D33. The risk this
 * block exists for is not that the hook does nothing — it is that somebody
 * wires it to `hasAward`, which is the item's *own* award and is `false` on
 * every open edital, and then reports an ordering that orders nothing. D25 (5)
 * and D33 both record that mistake.
 */
describe('priceableFirst · the D33 hook', () => {
  it('is the identity today, even where hasAward is set', () => {
    // The exact shape of the mistake: an item carrying `hasAward` must not move.
    const list = run(5, { 3: { hasAward: true }, 4: { hasAward: true } })
    expect(priceableFirst(list).map((item) => item.number)).toEqual([1, 2, 3, 4, 5])
  })

  it('answers false for every item, including one with an award of its own', () => {
    expect(isPriceable(make(1))).toBe(false)
    expect(isPriceable(make(2, { hasAward: true }))).toBe(false)
  })

  it('partitions stably once a flag exists, so the hook is inert and not broken', () => {
    // D33 supplies the predicate; this proves what it will do when it does.
    // Without this the hook would be untestable, which is not "inert" — it is
    // "unknown", and an unknown that ships is the same defect one card later.
    const list = run(6)
    const marked = (item: TenderItemView) => item.number === 2 || item.number === 5
    expect(priceableFirst(list, marked).map((item) => item.number)).toEqual([2, 5, 1, 3, 4, 6])
  })

  it('leaves a list with no flagged item exactly as it arrived', () => {
    const list = run(4)
    expect(priceableFirst(list, () => false)).toEqual(list)
  })
})

describe('ItemPicker · a short list is still a list', () => {
  const html = render(run(COLLAPSE_FROM))

  it('does not collapse what a reader can already see', () => {
    // `LongText`'s rule for a short description, applied to a short list: the
    // disclosure would cost a tap and buy nothing.
    expect(html).not.toContain('<details')
    expect(html).toContain(`aria-label="${page.itemsLabel}"`)
  })

  it('still links every item and marks the one being read', () => {
    expect(html.match(/<a /g)).toHaveLength(COLLAPSE_FROM)
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('item=8"')
  })

  it('offers no search box, because there is nothing to search', () => {
    expect(html).not.toContain('type="search"')
  })
})

describe('ItemPicker · a 251-item edital', () => {
  const list = run(251, { 251: { description: 'GRAMPEADOR DE MESA para até 100 folhas' } })
  const html = render(list)

  it('collapses into a disclosure that opens on demand', () => {
    expect(html).toContain('<details')
    // The same `<details>` idiom as `LongText`, `ItemDescription` and
    // `FullObject` — not a fourth shape, and not a JavaScript toggle, which
    // would need an effect this suite cannot run (§4c). D39 extracts them.
    expect(html).toContain('<summary')
    expect(summary(html)).toContain(itemCopy.showMore)
    expect(summary(html)).toContain(itemCopy.less)
  })

  it('says how many items it holds, in both states', () => {
    // Collapsed exactly one item is on screen, so both sentences are true of
    // the state that shows them. Reusing `radar.opportunity.items.showing`,
    // which already says this — no new copy (D38's rule).
    expect(summary(html)).toContain(format(itemCopy.showing, { shown: 1, total: 251 }))
    expect(summary(html)).toContain(format(itemCopy.showing, { shown: LIST_CAP, total: 251 }))
  })

  it('keeps the chosen item visible when the list collapses', () => {
    // Inside the `<summary>`, which is the half that matters: rendered after
    // it, it would disappear with everything else on the collapse. Asserted as
    // markup and not as a substring of the page, for D30's reason.
    expect(summary(html)).toContain('Item 1 ·')
    // And it is not a link: an anchor inside a summary is a control inside a
    // control. The real `aria-current` link is in the list below.
    expect(summary(html)).not.toContain('<a ')
  })

  it('offers a search field named by the group it searches', () => {
    expect(html).toContain('type="search"')
    const field = html.match(/<input[^>]*type="search"[^>]*>/)
    expect(field, 'one search field').not.toBeNull()
    const id = html.match(/<span id="([^"]+)"[^>]*>Itens do edital<\/span>/)
    expect(id, 'the heading carries the id the field borrows').not.toBeNull()
    expect((field as RegExpMatchArray)[0]).toContain(
      `aria-labelledby="${(id as RegExpMatchArray)[1]}"`,
    )
  })

  it('draws the whole list at rest, capped so a 1 124-item edital cannot wedge it', () => {
    expect(html.match(/<a /g)).toHaveLength(LIST_CAP)
    expect(html).toContain('item=1"')
    expect(html).toContain(`item=${LIST_CAP}"`)
    // Past the cap the search field is the way through, not a "Ver mais".
    expect(html).not.toContain(`item=${LIST_CAP + 1}"`)
  })

  it('carries the search that got the reader here on every chip', () => {
    expect(html).toContain('cnpj=51885242000140')
    expect(html).toContain('q=papel')
  })

  it('bounds its own height instead of growing the page', () => {
    // The defect was a column taller than the card it leads to. A height, so
    // no breakpoint is involved: the rail takes width, never height.
    expect(html).toContain('overflow-y-auto')
    expect(html).toMatch(/max-h-\[\d+vh\]/)
  })

  /**
   * D29, D30 and D32 are three instances of one defect: a block inside the app
   * shell asking the window how wide it is. This list is in `main`
   * (`max-w-[960px] px-gutter`) beside a 264px rail, so its column is
   * `min(viewport − rail, 960) − 40` — 720px at 1024px, where a viewport query
   * is wrong by up to 264px.
   *
   * There is no width breakpoint here at all, which is the one answer that
   * cannot be wrong. These two assertions are the tripwire for the day somebody
   * adds one.
   */
  it('never asks the window how wide the column is', () => {
    // Both spellings: D30 swept `min-[Npx]:` and missed `md:`, which is D32.
    // The lookbehind is load bearing — `\b` sits between `@` and `min`.
    expect(html).not.toMatch(/(?<!@)\b(?:sm|md|lg|xl|2xl|min-\[\d+px\]):/)
  })

  it('pairs any container query it ever grows with a container to measure', () => {
    // `@min-[Npx]:` without `@container` on an ancestor silently measures the
    // nearest container — or the viewport — which is the defect wearing the
    // fix's clothes.
    if (html.match(/@min-\[\d+px\]:/)) expect(html).toContain('@container')
  })
})
