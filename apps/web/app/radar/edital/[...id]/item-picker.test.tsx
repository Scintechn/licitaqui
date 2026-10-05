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
  matchesTokens,
  priceableFirst,
  queryTokens,
  rowsToDraw,
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

/**
 * **Every viewport breakpoint in the markup, by either spelling.**
 *
 * Token by token rather than by one regex over the whole string, because the
 * regex this replaces had three holes the review found: `max-[900px]:` and
 * `[@media(min-width:720px)]:` sailed through it, and the legitimate container
 * variant `@max-md:` was flagged. Splitting the class list and anchoring each
 * variant means `@` is always the first character of a container query and
 * never of a viewport one, and a chained variant (`hover:md:flex`) is read one
 * segment at a time.
 *
 * D30 swept `min-[Npx]:` and missed the named breakpoints, which became D32.
 * This is the third turn of that wheel and the last place to get it wrong.
 */
const BREAKPOINT = /^(?:(?:max-)?(?:sm|md|lg|xl|2xl)|(?:min|max)-\[\d+px\])$/

function viewportQueries(html: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)]
    .flatMap(([, list]) => list.split(/\s+/))
    .filter(
      (token) =>
        // An arbitrary media variant is checked before the split, because
        // `[@media(min-width:720px)]:` contains a colon of its own and would
        // otherwise be torn into pieces that match nothing. `[@container(…)]:`
        // is deliberately not caught: that one asks the column.
        token.includes('[@media') ||
        token
          .split(':')
          .slice(0, -1)
          .some((variant) => BREAKPOINT.test(variant)),
    )
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

  /**
   * **The case that pins NFKD rather than NFD**, and the reason the review
   * asked for it: `'g/m²'` above folds on both sides and passes either way, so
   * it proves nothing about the choice. These do not. `nº`, `3ª`, `m²`, `m³`
   * and `½` are everywhere in PNCP item text and NFD leaves every one of them
   * untouched — so a reader typing what a keyboard makes easy would find
   * nothing.
   */
  it('folds the compatibility forms PNCP writes and a keyboard cannot', () => {
    expect(matchesQuery(make(1), 'g/m2')).toBe(true)
    expect(matchesQuery(make(12, { description: 'Caderno nº 12, ½ pauta' }), 'no 12')).toBe(true)
    expect(matchesQuery(make(5, { description: 'Tubo 3ª qualidade, 2 m³' }), '3a')).toBe(true)
    expect(matchesQuery(make(5, { description: 'Tubo 3ª qualidade, 2 m³' }), 'm3')).toBe(true)
  })

  it('matches everything while the box is empty', () => {
    expect(matchesQuery(make(1), '')).toBe(true)
    expect(matchesQuery(make(1), '   ')).toBe(true)
  })

  it('folds and splits the query once, not once per item', () => {
    // 1 124 items on the widest tender we hold: the tokens are the same every
    // time, so the component computes them once per keystroke and the match
    // takes them as a list. `matchesQuery` is the two composed.
    expect(queryTokens('  PAPEL   A4 ')).toEqual(['papel', 'a4'])
    expect(queryTokens('   ')).toEqual([])
    expect(matchesTokens(make(1), queryTokens('papel a4'))).toBe(true)
    expect(matchesTokens(make(1), [])).toBe(true)
  })
})

/**
 * **The cap must never drop the row the screen is about.**
 *
 * `matched.slice(0, LIST_CAP)` was the first version and both suites missed
 * it, because both chose item 1. On the 251-item edital of the card, opening
 * `?item=251` — reachable *only* through this picker, since no other caller
 * puts an item in the URL — drew 50 chips none of which was item 251, with the
 * summary chip hidden because the list was open. `aria-current="page"` was then
 * nowhere on the screen, against the card's own acceptance criterion.
 */
describe('rowsToDraw', () => {
  const list = run(251)

  it('keeps the chosen item when it sits past the cap, and puts it first', () => {
    const rows = rowsToDraw(list, list[250])
    expect(rows).toHaveLength(LIST_CAP)
    expect(rows[0].number).toBe(251)
    // And it does not duplicate it or lose a row to make room.
    expect(new Set(rows.map((item) => item.number)).size).toBe(LIST_CAP)
  })

  it('leaves the agency’s order alone when the chosen item is already first', () => {
    expect(rowsToDraw(list, list[0]).map((item) => item.number)).toEqual(
      list.slice(0, LIST_CAP).map((item) => item.number),
    )
  })

  it('does not force a row the reader filtered out back into the answer', () => {
    // A filtered list is the reader's own question; a row they did not ask for
    // inside the answer is noise. The item they are on is still named by the
    // heading `price-view.tsx` draws above this block.
    const matched = list.slice(100, 110)
    expect(rowsToDraw(matched, list[0]).map((item) => item.number)).toEqual(
      matched.map((item) => item.number),
    )
  })

  it('draws everything when there is less than a capful', () => {
    const matched = list.slice(0, 3)
    expect(rowsToDraw(matched, list[2]).map((item) => item.number)).toEqual([3, 1, 2])
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

  it('collapses at the first length past the line, and not before', () => {
    // The boundary from both sides. Without the second case, `<=` could be
    // `<`, or `< COLLAPSE_FROM + 2`, and every other test would stay green.
    expect(render(run(COLLAPSE_FROM))).not.toContain('<details')
    expect(render(run(COLLAPSE_FROM + 1))).toContain('<details')
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

  it('draws the chosen item even when the cap would have cut it', () => {
    // The 🔴 the review found: with `?item=251` the chip was not rendered at
    // all and the summary chip is hidden while the list is open, so nothing on
    // the screen carried `aria-current`.
    const far = render(list, list[250])
    expect(far).toContain('item=251"')
    expect(far.match(/aria-current="page"/g), 'the summary chip and the row').toHaveLength(2)
    expect(far.match(/<a /g), 'and still only a capful of rows').toHaveLength(LIST_CAP)
  })

  it('lets a 70-character unbroken code wrap instead of widening the page', () => {
    // `EvidenceRow`'s class of defect one screen over: `trimObject` caps the
    // length, not the token count, and `CHIP` is a flex container, so without
    // `min-w-0 break-words` the label's min-content width pushes the chip past
    // its column — and the summary chip has no scrolling ancestor to contain
    // it. `environment: 'node'` has no boxes, so this pins the classes and
    // `price-item-list.spec.ts` pins the document width.
    expect(summary(html)).toContain('min-w-0 break-words')
    expect(html.match(/min-w-0 break-words/g)).toHaveLength(LIST_CAP + 1)
  })

  it('carries the search that got the reader here on every chip', () => {
    expect(html).toContain('cnpj=51885242000140')
    expect(html).toContain('q=papel')
  })

  it('bounds its own height instead of growing the page', () => {
    // The defect was a column taller than the card it leads to. A height, so
    // no breakpoint is involved: the rail takes width, never height.
    expect(html).toContain('overflow-y-auto')
    // `dvh`, like every other viewport height in this app: on mobile `vh` is
    // the *large* viewport, measured with the URL bar retracted. The first
    // version of this assertion was `/max-h-\[\d+vh\]/`, which would have
    // **reddened on the fix** — `60dvh` does not match it.
    expect(html).toMatch(/max-h-\[\d+dvh\]/)
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
  it('never asks the window how wide the column is, on either path', () => {
    expect(viewportQueries(html)).toEqual([])
    // The short list too: the first version guarded only this block, so the
    // other branch of the component was unguarded.
    expect(viewportQueries(render(run(COLLAPSE_FROM)))).toEqual([])
  })

  it('has a tripwire that actually catches the spellings it names', () => {
    // A guard that cannot fire is worse than none, and this one is a regex —
    // so it is tested against the classes it must reject and the ones it must
    // allow, rather than trusted because the suite is green.
    const caught = ['md:flex', 'lg:hidden', '2xl:grid', 'min-[900px]:flex', 'max-[900px]:flex']
    const caughtToo = ['max-md:flex', 'hover:md:flex', '[@media(min-width:720px)]:grid-cols-2']
    const allowed = ['@min-[420px]:flex-nowrap', '@md:flex', '@max-md:flex', 'group-open:hidden']
    for (const token of [...caught, ...caughtToo]) {
      expect(viewportQueries(`class="${token}"`), token).toEqual([token])
    }
    for (const token of allowed) {
      expect(viewportQueries(`class="${token}"`), token).toEqual([])
    }
  })

  it('pairs any container query it ever grows with a container to measure', () => {
    // `@min-[Npx]:` without `@container` on an ancestor silently measures the
    // nearest container — or the viewport — which is the defect wearing the
    // fix's clothes.
    if (html.match(/@min-\[\d+px\]:/)) expect(html).toContain('@container')
  })
})
