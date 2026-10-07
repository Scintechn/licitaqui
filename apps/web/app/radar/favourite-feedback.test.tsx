import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messages } from '@/lib/messages'
import { tenderHref } from '@/lib/radar/client'
import type { TenderCard, TenderGroup } from '@/lib/radar/contract'
import { FavouriteNoticeRegion } from './favourite-notice'
import { FavouriteStar } from './favourite-star'
import { RadarView, type RadarViewProps } from './radar-view'
import { TenderCardView, tenderTitleId } from './tender-card'

/**
 * **D56 and D57 — the mechanism, where a string assertion can hold it.**
 *
 * `vitest.config.mts` has no jsdom (CLAUDE.md §4c): nothing clicks, no effect
 * runs, there are no boxes, and — the point of this file — **nothing computes an
 * accessible name**. So everything below is about the wiring:
 *
 *  - the star names itself from two nodes, and both of those nodes exist;
 *  - the ids are derived from the tender id by both sides, so twenty cards get
 *    twenty names without anything being threaded through as a prop;
 *  - the live region is in the DOM **before** there is anything to say, which is
 *    the whole reason the announcement works;
 *  - the region is a sibling of the list's `@container`, not a child.
 *
 * What a browser does with that wiring — the computed name, the visible
 * sentence, the 401 and the 429 and the dropped connection — is
 * `e2e/journeys/favourite-feedback.spec.ts`. Neither file can do the other's
 * job, and saying which is which is the §4c discipline.
 */

const copy = messages.radar.favourites
const common = messages.common
const NOW = new Date('2026-09-17T15:00:00.000Z')

function tender(n: number, shortTitle: string): TenderCard {
  return {
    id: `51885242000140-1-${String(n).padStart(6, '0')}/2026`,
    object: `AQUISIÇÃO DE ${shortTitle.toUpperCase()}, PROCESSO 2026/${String(n).padStart(4, '0')}`,
    shortTitle,
    agencyName: 'Prefeitura de Campinas',
    city: 'Campinas',
    state: 'SP',
    modalityName: 'Pregão eletrônico',
    proposalsCloseAt: '2026-09-19T11:30:00.000Z',
    estimatedValue: '48196.00',
    confidentialBudget: false,
    priceRegistration: false,
    meEppSummary: 'exclusive',
    favoredTreatment: false,
    itemCount: 7,
    segments: ['Gráfico / Escritório'],
    matchedSegments: [],
    group: 'compatible',
    status: 'Divulgada no PNCP',
    pncpUpdatedAt: '2026-09-16T10:00:00.000Z',
  }
}

const THREE = [
  tender(1, 'Baterias e pilhas'),
  tender(2, 'Papel A4'),
  tender(3, 'Cartuchos de tinta'),
]

function card(row: TenderCard): string {
  return renderToStaticMarkup(
    <TenderCardView
      tender={row}
      now={NOW}
      href={tenderHref(row.id, { cnpj: '51885242000140', group: 'compatible' })}
      action={<FavouriteStar tenderId={row.id} marked={false} onChange={() => {}} />}
    />,
  )
}

function radar(overrides: Partial<RadarViewProps> = {}): string {
  const props: RadarViewProps = {
    query: { cnpj: '51885242000140', state: null, q: null, group: 'compatible' as TenderGroup },
    status: { kind: 'ready' },
    grouping: null,
    visitor: null,
    counts: { compatible: THREE.length, check: 0, keyword: 0 },
    tenders: THREE,
    freshness: null,
    now: NOW,
    // The star is rendered only where a handler exists, so the region's whole
    // reason to be there arrives with this prop.
    onFavourite: () => {},
    ...overrides,
  }
  return renderToStaticMarkup(<RadarView {...props} />)
}

/**
 * Everything the first `<div class="@container">` contains, by a balanced
 * `<div>` scan — an ancestor relation rather than a pair of string offsets.
 */
function containerContent(html: string): string {
  // **The list's** container, not D52's filter row, which is also `@container`
  // and comes first — `radar-view.test.tsx` counts two of them on this screen.
  const tag = '<div class="@container"><ul class="grid'
  const open = html.indexOf(tag)
  expect(open, 'the list container is in the markup').toBeGreaterThanOrEqual(0)
  const start = open + '<div class="@container">'.length
  let i = start
  let depth = 1
  while (depth > 0) {
    const nextOpen = html.indexOf('<div', i)
    const nextClose = html.indexOf('</div>', i)
    expect(nextClose, 'the container closes').toBeGreaterThanOrEqual(0)
    if (nextOpen >= 0 && nextOpen < nextClose) {
      depth += 1
      i = nextOpen + '<div'.length
    } else {
      depth -= 1
      i = nextClose + '</div>'.length
    }
  }
  return html.slice(start, i - '</div>'.length)
}

/** The `aria-labelledby` of the one star in a single card's markup. */
function labelledBy(html: string): string[] {
  const found = html.match(/<button[^>]*aria-labelledby="([^"]+)"/)
  expect(found, 'the star names itself with aria-labelledby').not.toBeNull()
  return (found as RegExpMatchArray)[1].split(' ')
}

describe('D57 · one name per star, and it names the edital', () => {
  it('names itself from its own action word and the card’s title, in that order', () => {
    const html = card(THREE[0])
    const [action, subject] = labelledBy(html)

    // The subject is the card's title node — text the screen is already showing,
    // which is what makes this fix cost no new string.
    expect(subject).toBe(tenderTitleId(THREE[0].id))
    expect(html).toContain(`<div id="${subject}" class="text-lead`)
    expect(html).toContain(`>${THREE[0].shortTitle}</div>`)

    // The action word is a node *inside* the button, so a name can never come
    // out empty even if the title node were somehow missing.
    expect(html).toContain(`<span id="${action}" class="sr-only">${copy.add}</span>`)
    expect(labelledBy(html), 'action first, subject second').toEqual([action, subject])
  })

  it('never uses aria-label, which is the attribute that made twenty names one', () => {
    expect(card(THREE[0])).not.toContain('aria-label=')
  })

  /**
   * The defect, stated as arithmetic rather than as prose: three cards, three
   * different `aria-labelledby` values, three different title nodes. A fix that
   * pointed every star at one shared id would pass every assertion above and
   * fail this one.
   */
  it('gives three cards three different names, without a prop being threaded', () => {
    const names = THREE.map((row) => labelledBy(card(row)).join(' '))
    expect(new Set(names).size, 'three distinct accessible names').toBe(3)

    const out = radar()
    for (const row of THREE) {
      // Per row, and the pair: this card's star names *this* card's title.
      expect(out, `${row.shortTitle} has a title node to be named by`).toContain(
        `id="${tenderTitleId(row.id)}"`,
      )
      expect(out, `${row.shortTitle}'s star points at it`).toContain(
        `${tenderTitleId(row.id)}"`,
      )
    }
    expect(out.match(/id="tender-title-/g), 'one title id per card').toHaveLength(3)
    expect(
      out.match(/aria-labelledby="[^"]+"/g)?.map((one) => one),
      'three stars, three different labelledby pairs',
    ).toHaveLength(3)
    expect(new Set(out.match(/aria-labelledby="[^"]+"/g)).size).toBe(3)
  })

  it('writes no title id on a card that has no control to name', () => {
    // `/conta/favoritos` and the Landing's example panel pass no action; their
    // markup must not grow an id nothing references.
    const plain = renderToStaticMarkup(
      <TenderCardView tender={THREE[0]} now={NOW} href="/radar/edital/x" />,
    )
    expect(plain).not.toContain('id="tender-title-')
  })

  it('escapes the slash in a numeroControlePNCP, because an id is a selector', () => {
    // `51885242000140-1-000001/2026`. Legal in an IDREF, a combinator in CSS.
    expect(tenderTitleId('51885242000140-1-000001/2026')).toBe(
      'tender-title-51885242000140-1-000001-2026',
    )
    expect(tenderTitleId('a b.c/d')).toBe('tender-title-a-b-c-d')
  })
})

describe('D56 · the region exists before there is anything to say', () => {
  it('renders the status region empty, on every paint of the list', () => {
    const out = radar()
    // Empty — `><` with nothing between — which is what makes the later change
    // a *mutation* of a live region rather than the insertion of one. An
    // inserted region carrying its text is announced unreliably.
    expect(out).toContain('<p role="status" aria-live="polite"')
    expect(out).toMatch(/<p role="status" aria-live="polite" class="[^"]*"><\/p>/)
    // Nothing is said yet, so none of the three sentences may be on the page.
    for (const sentence of [copy.signedOut, copy.failed, copy.tooMany]) {
      expect(out).not.toContain(sentence)
    }
  })

  /**
   * **An ancestor relation, asserted as one.**
   *
   * The first draft of this test took the index of `</ul></div>` after the
   * container and required `role="status"` to come later. Move the region
   * *inside* the container and that substring stops existing — the markup
   * becomes `</ul><div class="…fixed…">` and nothing else in `RadarView`
   * produces `</ul></div>` after that offset — so `indexOf` returned **-1** and
   * `toBeGreaterThan(-1)` passed. The assertion collapsed to *"a `role="status"`
   * exists somewhere"*: it could not fail, in the test written to catch the one
   * placement the whole component depends on. Neither mutation run touched it.
   *
   * It is the same substring-for-ancestor trap `radar-view.test.tsx`'s grid
   * block was rewritten to avoid, two hundred lines away. So this walks the
   * container's `<div>` nesting and asks what is **in** it.
   */
  it('puts the region outside the list’s @container, not inside it', () => {
    const out = radar()
    const inside = containerContent(out)
    expect(inside, 'the grid is what the container holds').toContain('<ul class="grid')
    // `container-type: inline-size` is a containing block for `position: fixed`,
    // so a region nested in there anchors to the bottom of the **grid** rather
    // than the bottom of the window — off screen on a full page.
    expect(inside, 'a fixed region inside an inline-size container').not.toContain(
      'role="status"',
    )
    // And it really is on the page, as a sibling after it: the assertion above
    // is also satisfied by a region that does not exist at all.
    expect(out, 'the region is rendered, outside').toContain('role="status"')
  })

  it('does not exist where no star does', () => {
    // No `onFavourite`, no stars, nothing to announce — and the Landing's
    // example panel and the server fallback must not grow a fixed region.
    expect(radar({ onFavourite: undefined })).not.toContain('role="status"')
  })

  it('draws no chrome until there is a sentence, and the close affordance with it', () => {
    const quiet = renderToStaticMarkup(<FavouriteNoticeRegion notice={null} />)
    expect(quiet).not.toContain('bg-ink')
    expect(quiet).not.toContain('<button')

    const loud = renderToStaticMarkup(<FavouriteNoticeRegion notice={copy.signedOut} />)
    expect(loud).toContain(copy.signedOut)
    expect(loud).toContain('bg-ink')
    // `common.close` is already approved, so the dismiss costs no new string.
    expect(loud).toContain(`aria-label="${common.close}"`)
    // And the sentence is inside the live element, not beside it.
    expect(loud).toMatch(
      new RegExp(`<p role="status" aria-live="polite" class="[^"]*">${copy.signedOut}`),
    )
  })

  /**
   * **Named for what it checks, which is less than it sounds.**
   *
   * It was called *"has a sentence for each of the three failure classes"* and
   * it does not check that: the status → key mapping is in `favourite-star.tsx`
   * and is reached by a click, which `environment: 'node'` cannot do. Three e2e
   * tests own it (401, 429, 500/offline), and no mutation of the mapping could
   * ever turn this red. What is worth holding here is that the three sentences
   * are three *different* sentences and each one renders — a 429 answered with
   * `failed` would be telling the reader to redo the thing that just failed.
   *
   * `signedOut` is Sci's. `failed` and `tooMany` are **drafts awaiting Sci**
   * (`pt-BR.json` says so in their `_note` lines, and `docs/TO_VALIDATE.md` §14
   * carries the decision). They are asserted for the same reason every approved
   * string is: a string nothing renders is the shape CLAUDE.md lists five
   * instances of.
   */
  it('renders three distinct sentences, one per failure class', () => {
    for (const sentence of [copy.signedOut, copy.tooMany, copy.failed]) {
      expect(renderToStaticMarkup(<FavouriteNoticeRegion notice={sentence} />)).toContain(sentence)
    }
    expect(new Set([copy.signedOut, copy.tooMany, copy.failed]).size).toBe(3)
  })
})
