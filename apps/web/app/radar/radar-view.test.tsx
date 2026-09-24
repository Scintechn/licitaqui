import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { format, messages } from '@/lib/messages'
import type { CompanyView, TenderCard, VisitorView } from '@/lib/radar/contract'
import { RadarView, type RadarStatus, type RadarViewProps } from './radar-view'

/**
 * Canvas 02 in every state it can be in.
 *
 * The card's acceptance criterion is "empty and analyzing states work", and
 * the failure it guards against is a screen that renders *nothing* while it
 * waits or when it finds nothing. So each state below is asserted twice: that
 * its own words are on the page, and that the words of the states it could be
 * confused with are not.
 */

const NOW = new Date('2026-09-17T15:00:00.000Z')
const copy = messages.radar

const COMPANY: CompanyView = {
  cnpj: '51885242000140',
  legalName: 'PAPELARIA CENTRAL LTDA',
  tradeName: 'Papelaria Central',
  mainCnae: '4761003',
  size: 'ME',
  isMei: false,
  state: 'SP',
  city: 'Campinas',
  segments: [
    { segment: 'Gráfico / Escritório', fit: 'compatible', fromMainCnae: true, fromSecondaryCnae: false },
    { segment: 'Informática / TI', fit: 'check', fromMainCnae: false, fromSecondaryCnae: true },
  ],
}

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
  matchedSegments: [COMPANY.segments[0]],
  status: 'Divulgada no PNCP',
  pncpUpdatedAt: '2026-09-16T10:00:00.000Z',
  group: 'compatible',
}

const VISITOR: VisitorView = {
  expiresAt: '2026-09-19T15:00:00.000Z',
  expired: false,
  screeningsUsed: 0,
  screeningsLeft: 2,
}

function render(overrides: Partial<RadarViewProps> = {}): string {
  const props: RadarViewProps = {
    query: { cnpj: '51885242000140', state: 'SP', q: null, group: 'compatible' },
    status: { kind: 'ready' },
    company: COMPANY,
    visitor: null,
    counts: { compatible: 12, check: 7, keyword: 3 },
    tenders: [TENDER],
    freshness: { state: 'fresh', updatedAt: '2026-09-17T14:48:00.000Z', ageSeconds: 720 },
    now: NOW,
    ...overrides,
  }
  return renderToStaticMarkup(<RadarView {...props} />)
}

/** Every state title, so "renders its own thing" can be asserted negatively. */
const OTHER_TITLES = [
  copy.states.analyzingCompanyTitle,
  copy.states.analyzingListTitle,
  copy.states.emptyTitle,
  copy.states.noSegmentsTitle,
  copy.states.manualCnaeTitle,
  copy.states.needCnpjTitle,
  copy.states.timeoutTitle,
  copy.states.errorTitle,
  copy.list.allEmpty.title,
]

function only(out: string, title: string) {
  expect(out).toContain(title)
  for (const other of OTHER_TITLES) {
    if (other === title) continue
    expect(out).not.toContain(other)
  }
}

describe('the Radar frame', () => {
  it('has exactly one h1, and it is the board’s "Radar"', () => {
    const out = render()
    expect(out.match(/<h1/g)).toHaveLength(1)
    expect(out).toContain(`>${copy.list.title}<`)
  })

  it('keeps the landmarks a screen reader navigates by', () => {
    const out = render()
    expect(out).toContain('<header')
    expect(out).toContain('<main id="radar"')
    expect(out).toContain('<nav aria-label=')
    expect(out).toContain(copy.nav.skip)
  })

  it('names the company, its CNAE count and where it is looking', () => {
    const out = render()
    expect(out).toContain('Papelaria Central')
    expect(out).toContain(format(copy.list.cnaeCount, { count: 2 }))
  })

  it('draws the three group tabs with their counts and marks the current one', () => {
    const out = render({ query: { cnpj: '1', state: null, q: null, group: 'check' } })
    for (const label of Object.values(copy.list.groups)) expect(out).toContain(label)
    expect(out).toContain('>12<')
    expect(out).toContain('>7<')
    expect(out).toContain('aria-current="page"')
    expect(out).toContain('href="/radar?cnpj=1&amp;group=keyword"')
  })

  it('renders every filter control with a label, at 16px', () => {
    const out = render()
    for (const id of ['radar-uf', 'radar-q']) {
      expect(out).toContain(`for="${id}"`)
      expect(out).toContain(`id="${id}"`)
    }
    // `text-base` is 16px. Below it, iOS Safari zooms the viewport on focus.
    expect(out.match(/<input[^>]*id="radar-q"[^>]*text-base/)).not.toBeNull()
    expect(out.match(/<select[^>]*id="radar-uf"[^>]*text-base/)).not.toBeNull()
  })

  it('says how old the list is, and that it is being refreshed when stale', () => {
    expect(render()).toContain(
      format(copy.freshness.fresh, { idade: format(copy.age.minutes, { count: 12 }) }),
    )
    const stale = render({
      freshness: { state: 'stale', updatedAt: '2026-09-17T11:00:00.000Z', ageSeconds: 14_400 },
    })
    expect(stale).toContain(
      format(copy.freshness.stale, { idade: format(copy.age.hours, { count: 4 }) }),
    )
  })
})

describe('a tender card', () => {
  it('carries the board’s six lines', () => {
    const out = render()
    expect(out).toContain('Registro de preços de baterias e pilhas')
    expect(out).toContain('Prefeitura de Campinas · Campinas/SP · Pregão eletrônico')
    expect(out).toContain('R$ 48.196')
    expect(out).toContain(format(copy.card.items, { count: 7 }))
    expect(out).toContain(copy.list.badges.compatible)
    expect(out).toContain(copy.tags.exclusive)
    expect(out).toContain(copy.tags.priceRegistration)
    expect(out).toContain(format(copy.card.daysLeft, { count: 13 }))
    expect(out).toContain(format(copy.card.proposalsUntil, { quando: '30/09 · 08:30' }))
  })

  it('links to the tender with the slash intact, so no %2F reaches a proxy', () => {
    expect(render()).toContain('href="/radar/edital/51885242000140-1-000744/2026?')
  })

  it('carries the search into the tender’s URL, because the way back reads it', () => {
    // `opportunity-screen.tsx` builds "Voltar" out of these four parameters.
    // Linking to the bare `/radar/edital/…` is why the back link went to a
    // bare `/radar`: no CNPJ, no keyword, no tab — the search, lost.
    const out = render({
      query: { cnpj: '51885242000140', state: 'SP', q: 'papel', group: 'check' },
      tenders: [{ ...TENDER, group: 'check' }],
    })
    expect(out).toContain(
      'href="/radar/edital/51885242000140-1-000744/2026?cnpj=51885242000140&amp;uf=SP&amp;q=papel&amp;group=check"',
    )
  })

  it('does not print a value it was told is confidential', () => {
    const out = render({
      tenders: [{ ...TENDER, confidentialBudget: true, estimatedValue: '48196.00' }],
    })
    expect(out).toContain(copy.card.confidential)
    expect(out).not.toContain('R$ 48.196')
  })

  it('says "Sem cota ME/EPP" rather than leaving the regime unsaid', () => {
    expect(render({ tenders: [{ ...TENDER, meEppSummary: 'none', favoredTreatment: false }] })).toContain(
      copy.tags.none,
    )
  })
})

describe('the states', () => {
  it('analyzing the CNPJ is a polite live region, not a blank page', () => {
    const out = render({ status: { kind: 'analyzing', what: 'company' }, tenders: [] })
    only(out, copy.states.analyzingCompanyTitle)
    expect(out).toContain('role="status"')
    expect(out).toContain('aria-live="polite"')
    expect(out).toContain('animate-ds-spin')
    // The frame stays: the user can still see where they are and change tabs.
    expect(out).toContain(copy.list.title)
  })

  it('analyzing the list says it is the list that is being read', () => {
    only(render({ status: { kind: 'analyzing', what: 'list' }, tenders: [] }), copy.states.analyzingListTitle)
  })

  it('an empty group says the group is empty and offers a way out', () => {
    // Empty here, results elsewhere: the board's own empty state, with the
    // way out pointing at the tab that has them.
    const out = render({ tenders: [], counts: { compatible: 0, check: 7, keyword: 3 } })
    only(out, copy.states.emptyTitle)
    expect(out).toContain(copy.states.emptyBody)
    expect(out).not.toContain('role="status"')
  })

  it('names the empty group it is talking about', () => {
    const check = render({
      query: { cnpj: '1', state: null, q: null, group: 'check' },
      tenders: [],
    })
    expect(check).toContain(copy.states.emptyCheckTitle)
    const keyword = render({
      query: { cnpj: '1', state: null, q: 'papel', group: 'keyword' },
      tenders: [],
    })
    expect(keyword).toContain(copy.states.emptyKeywordTitle)
  })

  it('an unmapped CNAE reads as "we could not match you", never as a failure', () => {
    const out = render({
      status: { kind: 'noSegments' },
      company: { ...COMPANY, segments: [] },
      tenders: [],
    })
    only(out, copy.states.noSegmentsTitle)
    expect(out).toContain(copy.states.noSegmentsBody)
    // B6 leaves 777 codes unmapped on purpose: this must not blame the filters.
    expect(out).not.toContain(copy.states.emptyBody)
  })

  it('a CNPJ BrasilAPI could not read says so, and keeps the keyword results', () => {
    const blank = render({ status: { kind: 'manualCnae' }, tenders: [] })
    only(blank, copy.states.manualCnaeTitle)

    const withResults = render({ status: { kind: 'manualCnae' } })
    expect(withResults).toContain('Registro de preços de baterias e pilhas')
    expect(withResults).not.toContain(copy.states.manualCnaeTitle)
  })

  it('no CNPJ and no keyword asks for one instead of erroring', () => {
    const out = render({ status: { kind: 'needCnpj' }, company: null, tenders: [], counts: null })
    only(out, copy.states.needCnpjTitle)
    expect(out).toContain('href="/"')
  })

  it('sixty seconds of waiting ends in words, not in a spinner for ever', () => {
    const out = render({ status: { kind: 'timeout' }, tenders: [] })
    only(out, copy.states.timeoutTitle)
    expect(out).not.toContain('animate-ds-spin')
  })

  it('an error shows the reason the API gave, without a padlock', () => {
    const out = render({
      status: { kind: 'error', code: 'server_error', text: messages.errors.pncpDown },
      tenders: [],
    })
    only(out, copy.states.errorTitle)
    expect(out).toContain(messages.errors.pncpDown)
  })

  it('every state renders a real page, never an empty body', () => {
    const states: RadarStatus[] = [
      { kind: 'ready' },
      { kind: 'analyzing', what: 'company' },
      { kind: 'analyzing', what: 'list' },
      { kind: 'timeout' },
      { kind: 'error', code: 'rate_limited' },
      { kind: 'needCnpj' },
      { kind: 'noSegments' },
      { kind: 'manualCnae' },
    ]
    for (const status of states) {
      const out = render({ status, tenders: [] })
      expect(out.match(/<h1/g)).toHaveLength(1)
      expect(out.length).toBeGreaterThan(2_000)
    }
  })
})

describe('the visitor strip', () => {
  it('counts the days and the screenings left, and offers the free account', () => {
    const out = render({ visitor: VISITOR })
    expect(out).toContain(copy.visitor.label)
    expect(out).toContain(format(copy.visitor.days, { count: 2 }))
    expect(out).toContain(format(copy.visitor.screenings, { count: 2 }))
    expect(out).toContain(copy.visitor.createAccount)
  })

  it('turns into the board’s "limite do visitante" once the window has closed', () => {
    const out = render({ visitor: { ...VISITOR, expired: true, screeningsLeft: 0 } })
    expect(out).toContain(copy.visitor.expiredTitle)
    expect(out).toContain(copy.visitor.expiredBody)
  })

  it('is absent for anyone who is not a visitor', () => {
    expect(render({ visitor: null })).not.toContain(copy.visitor.label)
  })
})

/**
 * "Ver mais editais". The copy existed and nothing rendered it, so `/radar`
 * showed the badge `Compatíveis 79` above a list of 20 and the other 59 were
 * unreachable — no control, and no request carrying a `cursor` in the trace.
 */
describe('the next page', () => {
  const twenty = Array.from({ length: 20 }, (_, index) => ({
    ...TENDER,
    id: `${TENDER.id}-${index}`,
  }))
  const paged = {
    tenders: twenty,
    counts: { compatible: 79, check: 7, keyword: 3 },
    nextCursor: 'cursor-2',
    onLoadMore: () => {},
  }

  it('offers the control the catalogue has always had a word for', () => {
    const out = render(paged)
    expect(out).toContain(copy.list.more)
    expect(out).toContain('<button')
  })

  it('hides it at the end of the list, where there is nothing to fetch', () => {
    const out = render({ ...paged, nextCursor: null })
    expect(out).not.toContain(copy.list.more)
    // The line saying where you are stays: the list did not become shorter.
    expect(out).toContain(format(copy.list.showing, { shown: 20, total: 79 }))
  })

  it('renders nothing at all without a handler, the way onRetry does', () => {
    const out = render({ ...paged, onLoadMore: undefined })
    expect(out).not.toContain(copy.list.more)
    expect(out).not.toContain(format(copy.list.showing, { shown: 20, total: 79 }))
  })

  it('says how far into the total you are, and announces it politely', () => {
    const out = render(paged)
    expect(out).toContain(format(copy.list.showing, { shown: 20, total: 79 }))
    expect(out).toContain('aria-live="polite"')
  })

  it('leaves the tab badge alone while a page is loading: 79 is still 79', () => {
    const out = render({ ...paged, loadingMore: true })
    expect(out).toContain(copy.list.moreLoading)
    expect(out).not.toContain(copy.list.more)
    expect(out).toContain('aria-busy="true"')
    expect(out).toMatch(/\sdisabled(=|\s|>)/)
    // The badge and the count line both keep the numbers they had.
    expect(out).toContain('79')
    expect(out).toContain(format(copy.list.showing, { shown: 20, total: 79 }))
  })

  it('stays away from every state that is not a list', () => {
    for (const status of [
      { kind: 'analyzing', what: 'list' },
      { kind: 'timeout' },
      { kind: 'needCnpj' },
      { kind: 'noSegments' },
    ] as RadarStatus[]) {
      expect(render({ ...paged, status })).not.toContain(copy.list.more)
    }
  })

  it('is absent from an empty group, which has no next page by definition', () => {
    expect(render({ ...paged, tenders: [] })).not.toContain(copy.list.more)
  })
})

const BASE_QUERY = { cnpj: '51885242000140', state: 'SP', q: null, group: 'compatible' } as const

describe('the group hint, inside the Radar', () => {
  it('says what the selected tab means, under the tabs', () => {
    // The three hints existed only inside "Como funciona" on the marketing
    // landing. A founder arriving from an e-mail link lands on /radar and
    // never passes the page where the words are defined, so "Verificar" was a
    // bare label on the screen where it decides whether to open an edital.
    expect(render({ query: { ...BASE_QUERY, group: 'compatible' } })).toContain(
      copy.list.groupHint.compatible,
    )
    expect(render({ query: { ...BASE_QUERY, group: 'check' } })).toContain(copy.list.groupHint.check)
    expect(render({ query: { ...BASE_QUERY, group: 'keyword' } })).toContain(
      copy.list.groupHint.keyword,
    )
  })

  it('shows one hint at a time — the one for the tab you are on', () => {
    const out = render({ query: { ...BASE_QUERY, group: 'check' } })
    expect(out).toContain(copy.list.groupHint.check)
    expect(out).not.toContain(copy.list.groupHint.compatible)
    expect(out).not.toContain(copy.list.groupHint.keyword)
  })
})

/**
 * Item 3 of the three UX failures: a search whose hits are all in Verificar or
 * Palavras opened on an empty Compatíveis and read as a bug. Choosing the tab
 * is `lib/radar/group.ts`; what the screen *says* about the other tabs is here.
 */
describe('an empty tab, when the results are on another one', () => {
  const found = { compatible: 0, check: 0, keyword: 36 } as const

  it('names the tab that has them, and how many, and links to it', () => {
    const out = render({
      query: { ...BASE_QUERY, q: 'pavimentação asfáltica', group: 'compatible' },
      tenders: [],
      counts: found,
    })
    expect(out).toContain(
      format(copy.list.seeOther, {
        quantos: format(copy.tabs.count, { count: 36 }),
        grupo: copy.list.groups.keyword,
      }),
    )
    expect(out).toContain('group=keyword')
  })

  it('says something different when every tab is empty', () => {
    const out = render({ tenders: [], counts: { compatible: 0, check: 0, keyword: 0 } })
    only(out, copy.list.allEmpty.title)
    expect(out).toContain(copy.list.allEmpty.body)
    // There is no populated tab to offer, so it must not invent one.
    expect(out).toContain(copy.states.emptyAction)
    for (const group of ['compatible', 'check', 'keyword'] as const) {
      expect(out).not.toContain(
        format(copy.list.seeOther, {
          quantos: format(copy.tabs.count, { count: 0 }),
          grupo: copy.list.groups[group],
        }),
      )
    }
  })

  it('counts are announced with their noun, not as a bare digit', () => {
    const out = render({ counts: { compatible: 0, check: 7, keyword: 3 } })
    expect(out).toContain(`<span class="sr-only">${format(copy.tabs.count, { count: 0 })}</span>`)
    expect(out).toContain(`<span class="sr-only">${format(copy.tabs.count, { count: 7 })}</span>`)
    // The digit itself is decoration once the words are there.
    expect(out).toMatch(/aria-hidden="true"[^>]*tabular-nums">0</)
  })

  it('the company can be changed without leaving the Radar', () => {
    // The CNPJ used to be `<input type="hidden">`: carried through every
    // search, editable nowhere, so the one thing you could not change here was
    // the company — and people went back to the landing to do it.
    const out = render()
    expect(out).not.toContain('<input type="hidden" name="cnpj"')
    expect(out).toContain('name="cnpj"')
    expect(out).toContain(copy.landing.cnpjLabel)
    // Still prefilled with the search on screen, so opening the row and
    // pressing Aplicar without touching anything repeats the same search.
    expect(out).toContain(`value="${BASE_QUERY.cnpj}"`)
  })

  it('the filter row says the search is inside it', () => {
    // "Filtros" does not tell anybody the whole search lives in there.
    // `changeCompany` was written for this and rendered nowhere.
    const out = render()
    expect(out).toContain(copy.list.changeCompany)
  })

  it('the filter control is not named after the sort order (WCAG 4.1.2)', () => {
    // "Ordenar: prazo" used to be a second span inside the <summary>, so the
    // computed name of the control was "Trocar empresa ou filtros Ordenar:
    // prazo" — a statement about the list welded onto the name of the button
    // that changes it.
    const out = render()
    const summary = out.slice(out.indexOf('<summary'), out.indexOf('</summary>'))
    expect(summary).toContain(copy.list.changeCompany)
    expect(summary).not.toContain(copy.list.sort)
    // It is still on the screen, just not inside the control.
    expect(out).toContain(copy.list.sort)
  })

  it('the sort label still sits on the row, and still lets the row be tapped', () => {
    // It is drawn over the right end of the summary rather than beside it: a
    // <details> squeezed to the left half would squeeze the full-width form it
    // opens along with it.
    const out = render()
    const sort = out.slice(out.indexOf(copy.list.sort) - 260, out.indexOf(copy.list.sort))
    expect(sort).toContain('absolute')
    // Clicks fall through to the summary underneath, so the control keeps the
    // full-width target it has always had.
    expect(sort).toContain('pointer-events-none')
  })

  it('the filter control looks like something that opens', () => {
    // The native marker is hidden and the `filters` glyph is identical open
    // and closed, so the only way to change the search read as a caption.
    const out = render()
    const summary = out.slice(out.indexOf('<summary'), out.indexOf('</summary>'))
    // `chevronRight`'s path, rotated a quarter turn by the parent's [open].
    expect(summary).toContain('M9 6l6 6-6 6')
    expect(summary).toContain('group-open:rotate-90')
    // The chevron is decoration next to a label that already names the
    // control, so it must not reach the accessible name.
    expect(summary).toContain('aria-hidden="true"')
  })

  it('the company line draws no affordance it cannot honour', () => {
    // It used to render a chevronRight inside a plain <p> — no link, no
    // button, no handler. An affordance that does nothing is worse than none.
    const out = render()
    const header = out.slice(0, out.indexOf(copy.list.groups.compatible))
    expect(header).not.toContain('chevron')
  })

  it('an elected tab is not written into the filter form as a chosen one', () => {
    // A tab the user pressed travels with a filter change; one the screen
    // picked for them must not, or the next search inherits a decision they
    // never made.
    const chosen = render({ query: { ...BASE_QUERY, group: 'keyword', groupChosen: true } })
    expect(chosen).toContain('<input type="hidden" name="group" value="keyword"/>')

    const elected = render({ query: { ...BASE_QUERY, group: 'keyword' } })
    expect(elected).not.toContain('name="group"')
  })
})
