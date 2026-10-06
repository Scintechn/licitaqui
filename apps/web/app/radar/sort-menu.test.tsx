import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { format, messages } from '@/lib/messages'
import { TENDER_SORTS, type TenderSort } from '@/lib/radar/contract'
import { RadarView, type RadarQuery, type RadarViewProps } from './radar-view'

/**
 * The sort control on the filter row (D51).
 *
 * In its own file because `radar-view.test.tsx` is being edited by three other
 * lanes this week, and because what is asserted here is one component rather
 * than the screen's states.
 *
 * ## What this file can and cannot see
 *
 * `vitest.config.mts` is `environment: 'node'`: these are
 * `renderToStaticMarkup` string assertions with no DOM, no effects and no boxes
 * (CLAUDE.md §4c). So this file pins the **mechanism** — that each order is a
 * real `href` the browser can follow before any JavaScript runs, that the
 * current order is named, and that the control is not inside the filter
 * `<summary>` — and `e2e/journeys/radar-sort.spec.ts` pins the **result**: that
 * the row is still one line at 390px with the longest label showing, and that
 * following one of these links actually re-sorts the list.
 *
 * The one thing that cannot be asserted from here and is worth knowing: the
 * `<details>` is keyed on the active order so it closes after a client-side
 * navigation. A key is a render-time fact, so the markup below is the proof it
 * is *declared*; that it *closes* is the browser's doing.
 */

const copy = messages.radar
const list = copy.list

function render(query: Partial<RadarQuery> = {}): string {
  const props: RadarViewProps = {
    query: { cnpj: '51885242000140', state: 'SP', q: null, group: 'compatible', ...query },
    status: { kind: 'ready' },
    grouping: null,
    visitor: null,
    counts: { compatible: 12, check: 7, keyword: 3 },
    tenders: [],
    freshness: null,
    now: new Date('2026-09-17T15:00:00.000Z'),
  }
  return renderToStaticMarkup(<RadarView {...props} />)
}

/** The sort `<details>`, from its opening tag to the end of its list. */
function control(out: string): string {
  const start = out.indexOf('<details class="group/sort')
  expect(start).toBeGreaterThan(-1)
  const end = out.indexOf('</details>', start)
  expect(end).toBeGreaterThan(start)
  return out.slice(start, end)
}

describe('the sort control', () => {
  it('offers all three orders as real links, before any JavaScript', () => {
    // The whole reason it is a `<details>` of `<a>`s and not a `<select>`: a
    // select changed with no JavaScript submits nothing, and this row has to
    // work on the first paint like the group chips and the filter form do.
    const out = control(render())
    expect(TENDER_SORTS).toEqual(['deadline', 'valueDesc', 'valueAsc'])
    for (const sort of TENDER_SORTS) {
      expect(out).toContain(list.sortOrders[sort])
    }
    // The default is the address with no parameter at all; the other two name
    // themselves. Four `href`s would mean one of them is not a link.
    //
    // No `group` here, and that is the rule asserted below rather than an
    // omission: the fixture's tab is the one the counts elected, not one the
    // reader pressed.
    expect(out).toContain('href="/radar?cnpj=51885242000140&amp;uf=SP"')
    expect(out).toContain('sort=valueDesc')
    expect(out).toContain('sort=valueAsc')
    expect(out.match(/href=/g)).toHaveLength(3)
  })

  /** Every `href` inside the control, which is what a reader would follow. */
  function orders(out: string): string[] {
    return (control(out).match(/href="([^"]*)"/g) ?? []).map((href) =>
      href.slice(6, -1).replaceAll('&amp;', '&'),
    )
  }

  it('does not turn the tab the counts elected into a tab the reader chose', () => {
    // `query.group` is *the tab on screen* — chosen, or elected by `bestGroup()`
    // — so spreading it into these links would write an election into the URL as
    // a decision. `FilterRow`'s hidden `group` field is gated on `groupChosen`,
    // so a promoted tab then travels with every filter applied afterwards and a
    // later search opens on a tab nobody picked, which may be empty.
    //
    // Asserted as behaviour and not as a string: what matters is that no address
    // a reader can reach from here carries a `group` they did not choose.
    const elected = orders(render({ group: 'keyword', groupChosen: false }))
    expect(elected).toHaveLength(3)
    for (const href of elected) {
      expect(new URLSearchParams(href.split('?')[1]).has('group'), href).toBe(false)
      // …and nothing else is lost in the process.
      expect(href).toContain('cnpj=51885242000140')
    }

    // A tab the reader actually pressed is never second-guessed.
    const chosen = orders(render({ group: 'keyword', groupChosen: true }))
    expect(chosen).toHaveLength(3)
    for (const href of chosen) {
      expect(new URLSearchParams(href.split('?')[1]).get('group'), href).toBe('keyword')
    }
  })

  it('carries the whole search into every order, not just the order', () => {
    // A link that dropped the keyword would re-sort a different list — the same
    // loss `client.ts` exists to make impossible to write by hand.
    // `groupChosen` on purpose: the test above owns the elected case, and a
    // chosen tab is part of the search that has to survive.
    const out = control(render({ q: 'papel', state: 'MG', group: 'keyword', groupChosen: true }))
    for (const href of out.match(/href="[^"]*"/g) ?? []) {
      expect(href).toContain('cnpj=51885242000140')
      expect(href).toContain('uf=MG')
      expect(href).toContain('q=papel')
      expect(href).toContain('group=keyword')
    }
  })

  it('says which order is in effect, and says it the same way at every width', () => {
    const out = control(render({ sort: 'valueDesc' }))
    // "Ordenar:" is hidden below 480px — at 390px the row has 350px and
    // "Ordenar: maior valor" plus a chevron does not fit beside the filter
    // label. The accessible name carries the whole phrase regardless, so the
    // control is never named by the bare value.
    expect(out).toContain(`aria-label="${list.sort} ${list.sortOrders.valueDesc}"`)
    expect(out).toContain('hidden min-[480px]:inline')
    expect(out).toContain(list.sortOrders.valueDesc)
  })

  it('names the current order in the trigger, whichever one it is', () => {
    for (const sort of TENDER_SORTS) {
      const out = control(render({ sort }))
      const summary = out.slice(out.indexOf('<summary'), out.indexOf('</summary>'))
      expect(summary).toContain(`aria-label="${list.sort} ${list.sortOrders[sort]}"`)
      expect(summary).toContain(list.sortOrders[sort])
    }
  })

  it('names the trigger and the options differently, because they do different things', () => {
    // One name shared by "open the menu" and "choose prazo" would be two
    // controls with one name on the same row.
    const out = control(render())
    expect(out).toContain(`aria-label="${list.sort} ${list.sortOrders.deadline}"`)
    for (const sort of TENDER_SORTS) {
      const option = format(list.sortBy, { ordem: list.sortOrders[sort] })
      expect(out).toContain(`aria-label="${option}"`)
      expect(option).not.toBe(`${list.sort} ${list.sortOrders[sort]}`)
      // Label in Name (WCAG 2.5.3): the visible word is inside the name.
      expect(option).toContain(list.sortOrders[sort])
    }
  })

  it('treats an absent order as the deadline order', () => {
    // `RadarQuery.sort` is optional so the Landing's example panel need not
    // state one. Absent must be the same control as `sort: 'deadline'`.
    const absent = control(render())
    const explicit = control(render({ sort: 'deadline' }))
    expect(absent).toBe(explicit)
    const summary = absent.slice(absent.indexOf('<summary'), absent.indexOf('</summary>'))
    expect(summary).toContain(list.sortOrders.deadline)
  })

  it('marks the order in effect, and only that one', () => {
    const out = control(render({ sort: 'valueAsc' }))
    expect(out.match(/aria-current="true"/g)).toHaveLength(1)
    // The marked link is the one that leads back to this same list. `next/link`
    // renders `aria-current` ahead of `href`, so the link is read forwards.
    const marked = out.slice(out.indexOf('aria-current="true"'))
    const link = marked.slice(0, marked.indexOf('</a>'))
    expect(link).toContain('sort=valueAsc')
    expect(link).not.toContain('sort=valueDesc')
  })

  it('is outside the filter disclosure, so it cannot name it (WCAG 4.1.2)', () => {
    // The rule `FilterRow` was built around: "Trocar empresa ou filtros
    // Ordenar: prazo" is not the name of the button that opens the search.
    const out = render()
    const filters = out.slice(out.indexOf('<summary'), out.indexOf('</summary>'))
    expect(filters).toContain(list.changeCompany)
    expect(filters).not.toContain(list.sort)
    for (const sort of TENDER_SORTS) {
      if (sort === 'deadline') continue
      expect(filters).not.toContain(list.sortOrders[sort])
    }
    // …and the control is a sibling of that `<details>`, not a child of it.
    expect(out.indexOf('<details class="group/sort')).toBeGreaterThan(out.indexOf('</details>'))
  })

  it('keeps a chosen order when the reader applies a filter', () => {
    // The GET form posts to `/radar` with no JavaScript, so anything the order
    // needs to survive "Aplicar filtros" has to be a field in it.
    const sorted = render({ sort: 'valueDesc' })
    expect(sorted).toContain('<input type="hidden" name="sort" value="valueDesc"/>')
    // …and the default is not written out, for the same reason `radarHref`
    // leaves it out: it would put `sort=` into every search anybody applies.
    expect(render()).not.toContain('name="sort"')
    expect(render({ sort: 'deadline' })).not.toContain('name="sort"')
  })

  it('draws the three orders in the catalogue, in Portuguese', () => {
    // Copy is a draft for Sci until approved; what is pinned here is that the
    // screen reads the catalogue rather than spelling any of it out.
    const orders: Record<TenderSort, string> = list.sortOrders
    expect(list.sort).toBe('Ordenar:')
    expect(orders.deadline).toBe('prazo')
    expect(orders.valueDesc).toBe('maior valor')
    expect(orders.valueAsc).toBe('menor valor')
    expect(list.sortBy).toBe('Ordenar por {ordem}')
    // The trigger's name is `sort` and the order joined, never a fourth string
    // that could drift from them.
    expect(control(render())).toContain(`aria-label="${list.sort} ${orders.deadline}"`)
  })
})
