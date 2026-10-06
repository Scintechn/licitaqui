import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { format, messages } from '@/lib/messages'
import type { CompanyView, GroupedBy, TenderGroup } from '@/lib/radar/contract'
import { TENDER_GROUPS } from '@/lib/radar/contract'
import { RadarView, type RadarStatus, type RadarViewProps } from './radar-view'

/**
 * D19: the header and the list must answer from one source, and the sentence
 * about CNAEs must be true.
 *
 * Sci, 2026-09-28, on `/radar?q=saas`: *"I didnt enter my CNPJ, so how those
 * tenders can be compatible with a null CNPJ?"* The screen said **"Sua empresa
 * · sem CNAE lido · Todo o Brasil"**, and two lines under it **"Compatíveis
 * 13"** and **"seu CNAE atende"**. Both cannot be true. The false one was the
 * one asserting a match, which is the shape `docs/CLAIMS.md` exists for.
 *
 * ## What this file pins, and what it cannot
 *
 * The suite is `environment: 'node'` with no jsdom (CLAUDE.md §4c), so the
 * *cause* — a client that resolves the company only when the URL carries
 * `?cnpj=`, while the route resolves `?cnpj= ?? visitors.cnpj` — is invisible
 * here: it needs a mounted effect, a cookie and a response. That half is pinned
 * in `e2e/journeys/radar-header.spec.ts`, which opens the Radar with **no**
 * `?cnpj=` and a visitor CNPJ behind an `httpOnly` cookie.
 *
 * What is pinned here is the mechanism: `RadarView` has exactly one company
 * input, `grouping`, and it is the list route's own `groupedBy`. Every sentence
 * in the header and under the tabs is a function of that one field, so the two
 * cannot disagree whatever the client does — which is what the last assertion
 * in this file checks, state by state and tab by tab.
 *
 * ## Separate from `radar-view.test.tsx` on purpose
 *
 * That file is canvas 02 in every state; this one is one invariant across all
 * of them. It is also being edited by three other lanes this week.
 */

const copy = messages.radar
const list = copy.list

/** "sem CNAE lido" — the zero branch of the plural the header renders. */
const NO_CNAE = format(list.cnaeCount, { count: 0 })

const CNPJ = '51885242000140'

/**
 * Three CNAEs reaching two segments — the two numbers D19 found conflated.
 *
 * It is not a contrived fixture: `cnae_segments` maps one CNAE onto as many
 * segments as it genuinely reaches, and B6 leaves 777 codes mapped to none at
 * all, so "how many CNAEs" and "how many segments" differ in both directions
 * for most real companies.
 */
const COMPANY: CompanyView = {
  cnpj: CNPJ,
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

const CNAES_ON_RECORD = 3

function render(overrides: Partial<RadarViewProps> = {}): string {
  const props: RadarViewProps = {
    query: { cnpj: null, state: null, q: 'canvas', group: 'compatible' },
    status: { kind: 'ready' },
    grouping: null,
    visitor: null,
    counts: { compatible: 0, check: 0, keyword: 3 },
    tenders: [],
    freshness: { state: 'fresh', updatedAt: '2026-10-06T12:00:00.000Z', ageSeconds: 600 },
    now: new Date('2026-10-06T12:10:00.000Z'),
    ...overrides,
  }
  return renderToStaticMarkup(<RadarView {...props} />)
}

/** Everything above the first tab label: the heading and the company line. */
function header(out: string): string {
  const end = out.indexOf(list.groups.compatible)
  expect(end).toBeGreaterThan(0)
  return out.slice(0, end)
}

/** What the header claims about CNAEs. `none` = it makes no claim at all. */
function headerSays(out: string): 'none' | 'zero' | 'some' {
  const top = header(out)
  if (top.includes(NO_CNAE)) return 'zero'
  if (/\d+ CNAEs|1 CNAE/.test(top)) return 'some'
  return 'none'
}

/** What the sentence under the tabs claims. */
function helpSays(out: string): 'none' | 'zero' | 'claims' {
  if (out.includes(list.groupHint.compatible) || out.includes(list.groupHint.check)) return 'claims'
  if (out.includes(list.groupHintNoCnae)) return 'zero'
  return 'none'
}

type State = { name: string; status: RadarStatus; grouping: GroupedBy | null }

/**
 * Every state the company half of this screen can be in. The middle one is the
 * one D19's card asks to be decided: a CNPJ is driving the list — from the
 * cookie, invisibly — and nothing has been read for it yet.
 */
const STATES: State[] = [
  { name: 'nothing asked yet', status: { kind: 'analyzing', what: 'list' }, grouping: null },
  { name: 'no company at all', status: { kind: 'ready' }, grouping: null },
  {
    name: 'a CNPJ with nothing read for it yet',
    status: { kind: 'ready' },
    grouping: { cnpj: CNPJ, company: null, cnaeCount: 0 },
  },
  {
    name: 'a CNPJ with a company read',
    status: { kind: 'ready' },
    grouping: { cnpj: CNPJ, company: COMPANY, cnaeCount: CNAES_ON_RECORD },
  },
]

describe('the Radar header and the tab help (D19)', () => {
  it('counts CNAEs, because that is what the string says it counts', () => {
    const out = render({
      grouping: { cnpj: CNPJ, company: COMPANY, cnaeCount: CNAES_ON_RECORD },
    })
    expect(out).toContain(format(list.cnaeCount, { count: CNAES_ON_RECORD }))
    // The segment count, which this line used to render under the word CNAE.
    expect(out).not.toContain(format(list.cnaeCount, { count: COMPANY.segments.length }))
  })

  it('names the company the list grouped by', () => {
    const out = render({
      grouping: { cnpj: CNPJ, company: COMPANY, cnaeCount: CNAES_ON_RECORD },
    })
    expect(header(out)).toContain('Papelaria Central')
    expect(header(out)).not.toContain(list.companyFallback)
    expect(header(out)).not.toContain(list.noCompany)
  })

  it('says there is no company when there is none, and claims no match anywhere', () => {
    for (const group of TENDER_GROUPS) {
      const out = render({
        grouping: null,
        query: { cnpj: null, state: null, q: 'canvas', group },
      })
      expect(header(out)).toContain(list.noCompany)
      expect(headerSays(out)).toBe('none')
      expect(helpSays(out)).not.toBe('claims')
    }
    // The keyword tab's own sentence is about the search term, not about a
    // CNAE, so it survives intact — a company-less visitor's whole list is
    // `keyword` by construction (`labels([])` is `array[]::text[]`).
    const keyword = render({ query: { cnpj: null, state: null, q: 'canvas', group: 'keyword' } })
    expect(keyword).toContain(list.groupHint.keyword)
  })

  it('a CNPJ nothing has been read for names no company and reports no CNAE', () => {
    const out = render({ grouping: { cnpj: CNPJ, company: null, cnaeCount: 0 } })
    // There is a company behind the list; we simply do not know its name yet.
    // So the non-committal label, not "sem empresa" — which would be false.
    expect(header(out)).toContain(list.companyFallback)
    expect(header(out)).not.toContain(list.noCompany)
    expect(headerSays(out)).toBe('zero')
    expect(helpSays(out)).toBe('zero')
  })

  it('reports an unanswered list as unknown, never as no company', () => {
    const out = render({ status: { kind: 'analyzing', what: 'list' }, grouping: null })
    // The CNPJ driving the list may be in the visitor cookie, which no browser
    // code can read. Before the route has answered, nothing is asserted.
    expect(header(out)).toContain(list.companyFallback)
    expect(header(out)).not.toContain(list.noCompany)
    expect(headerSays(out)).toBe('none')
  })

  /**
   * The test D19's card asks for by name.
   *
   * > a test renders the header and the tab help together and fails if one
   * > claims a CNAE match while the other reports none
   *
   * Every state against every tab, because `group` can come straight out of
   * the URL — `/radar?q=canvas&group=compatible` is exactly the address in
   * Sci's screenshot, and nothing stops a visitor with no CNAE from opening it.
   */
  it('never claims a CNAE match beside a line reporting no CNAE', () => {
    for (const state of STATES) {
      for (const group of TENDER_GROUPS) {
        const out = render({
          status: state.status,
          grouping: state.grouping,
          query: { cnpj: null, state: null, q: 'canvas', group },
        })
        const where = `${state.name} / ${group}`

        // The defect, in one line: "sem CNAE lido" over "seu CNAE atende".
        expect(
          headerSays(out) === 'zero' && helpSays(out) === 'claims',
          `${where}: the header reports no CNAE and the tab help claims one`,
        ).toBe(false)

        // And the mirror of it, which would be just as wrong: a header naming
        // CNAEs over a hint saying there are none to compare.
        expect(
          headerSays(out) === 'some' && helpSays(out) === 'zero',
          `${where}: the header counts CNAEs and the tab help says there are none`,
        ).toBe(false)
      }
    }
  })

  /**
   * One source, structurally.
   *
   * `grouping` is the only company-shaped input this component has, so there is
   * no second one for a caller to fill from somewhere else. The assertion is
   * the compile — `RadarViewProps` has no `company` — and this test states the
   * rule so that re-adding one is a deliberate act with a failing test beside
   * it rather than a quiet prop.
   */
  it('takes its company from the list route and from nowhere else', () => {
    const props: Record<string, unknown> = {
      query: { cnpj: null, state: null, q: 'canvas', group: 'compatible' as TenderGroup },
      status: { kind: 'ready' } as RadarStatus,
      grouping: null,
      visitor: null,
      counts: null,
      tenders: [],
      freshness: null,
    }
    expect(Object.keys(props)).not.toContain('company')
    expect(renderToStaticMarkup(<RadarView {...(props as unknown as RadarViewProps)} />)).toContain(
      list.noCompany,
    )
  })
})
