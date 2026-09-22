import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { format, messages } from '@/lib/messages'
import type { SegmentFit, TenderDetail } from '@/lib/radar/contract'
import { ACCOUNT_HREF } from '@/lib/routes'
import { OpportunityView, matchKind, reasons, type OpportunityViewProps } from './opportunity-view'

const NOW = new Date('2026-09-17T15:00:00.000Z')
const copy = messages.radar
const page = copy.opportunity

const COMPATIBLE: SegmentFit = {
  segment: 'Gráfico / Escritório',
  fit: 'compatible',
  fromMainCnae: true,
  fromSecondaryCnae: false,
}
const CHECK: SegmentFit = {
  segment: 'Informática / TI',
  fit: 'check',
  fromMainCnae: false,
  fromSecondaryCnae: true,
}

const TENDER: TenderDetail = {
  id: '51885242000140-1-000744/2026',
  agencyCnpj: '51885242000140',
  object: 'Registro de preços de baterias e pilhas',
  agencyName: 'Prefeitura de Campinas',
  unitName: 'Secretaria de Saúde',
  city: 'Campinas',
  state: 'SP',
  modalityName: 'Pregão eletrônico',
  status: 'Recebendo propostas',
  priceRegistration: true,
  proposalsOpenAt: '2026-09-16T13:00:00.000Z',
  proposalsCloseAt: '2026-09-30T11:30:00.000Z',
  estimatedValue: '48196.00',
  confidentialBudget: false,
  biddingSystemUrl: 'https://exemplo.gov.br/pregao/744',
  meEppSummary: 'exclusive',
  favoredTreatment: true,
  itemCount: 7,
  segments: ['Gráfico / Escritório'],
  matchedSegments: [COMPATIBLE],
  group: 'compatible',
  items: [],
  files: null,
  closed: false,
}

function render(overrides: Partial<OpportunityViewProps> = {}): string {
  const props: OpportunityViewProps = {
    tender: TENDER,
    freshness: { state: 'fresh', updatedAt: '2026-09-17T14:30:00.000Z', ageSeconds: 1_800 },
    status: { kind: 'ready' },
    backHref: '/radar?cnpj=51885242000140',
    now: NOW,
    ...overrides,
  }
  return renderToStaticMarkup(<OpportunityView {...props} />)
}

describe('matchKind', () => {
  it('reads the badge off the viewer’s own segments, not off the tender', () => {
    expect(matchKind(TENDER)).toBe('compatible')
    expect(matchKind({ ...TENDER, matchedSegments: [CHECK] })).toBe('check')
    expect(matchKind({ ...TENDER, matchedSegments: [] })).toBe('keyword')
  })
})

describe('reasons', () => {
  it('states only facts the tender itself carries', () => {
    const out = reasons(TENDER, NOW)
    expect(out).toContain(format(page.why.compatible, { segmentos: 'Gráfico / Escritório' }))
    expect(out).toContain(page.why.exclusive)
    expect(out).toContain(page.why.priceRegistration)
    expect(out).toContain(
      format(page.why.open, { prazo: format(copy.card.daysLeft, { count: 13 }) }),
    )
  })

  it('never claims an absence the AI screening has not checked', () => {
    // The board's canvas lists "não exige atestado técnico / capital mínimo /
    // amostra". Those come out of the edital PDF with a page reference and
    // belong to task D4; printing them from the header would invent a legal
    // fact about a document nobody has read.
    const joined = reasons(TENDER, NOW).join(' | ')
    expect(joined).not.toMatch(/atestado/i)
    expect(joined).not.toMatch(/capital mínimo/i)
    expect(joined).not.toMatch(/amostra/i)
  })

  it('does not repeat "tratamento favorecido" next to "exclusivo ME/EPP"', () => {
    expect(reasons(TENDER, NOW)).not.toContain(page.why.favored)
    expect(reasons({ ...TENDER, meEppSummary: 'none' }, NOW)).toContain(page.why.favored)
  })

  it('is empty for a tender the CNAEs never reached, and says nothing at all', () => {
    const keywordOnly = {
      ...TENDER,
      matchedSegments: [],
      meEppSummary: 'none',
      favoredTreatment: false,
      priceRegistration: false,
      proposalsCloseAt: '2026-01-01T00:00:00.000Z',
    }
    expect(reasons(keywordOnly, NOW)).toHaveLength(0)
  })
})

describe('the Opportunity screen', () => {
  it('has one h1, and it is the tender object', () => {
    const out = render()
    expect(out.match(/<h1/g)).toHaveLength(1)
    expect(out).toContain('Registro de preços de baterias e pilhas')
  })

  it('draws the board’s deadline and value block', () => {
    const out = render()
    expect(out).toContain(page.proposalsUntil)
    expect(out).toContain('30 SET · 08:30')
    expect(out).toContain(format(copy.card.daysLeft, { count: 13 }))
    expect(out).toContain(page.remaining)
    expect(out).toContain(page.estimatedValue)
    expect(out).toContain('R$ 48.196')
    expect(out).toContain(format(copy.card.items, { count: 7 }))
  })

  it('shows the why list and points at the screening for the rest', () => {
    const out = render()
    expect(out).toContain(page.whyTitle)
    expect(out).toContain(page.why.exclusive)
    expect(out).toContain(page.requirementsNote)
  })

  it('says so plainly when the tender only matched a keyword', () => {
    const out = render({
      tender: {
        ...TENDER,
        matchedSegments: [],
        meEppSummary: 'none',
        favoredTreatment: false,
        priceRegistration: false,
        proposalsCloseAt: null,
      },
    })
    expect(out).toContain(page.whyEmptyTitle)
    expect(out).toContain(page.whyEmptyBody)
  })

  it('lists the operation facts the header carries', () => {
    const out = render()
    expect(out).toContain(page.operationTitle)
    expect(out).toContain('Secretaria de Saúde')
    expect(out).toContain('30/09/2026 · 08:30')
    expect(out).toContain('Campinas/SP')
  })

  it('locks the files behind the account, as a real link and not a disabled control', () => {
    const out = render()
    expect(out).toContain(page.filesLocked)
    expect(out).toContain(`href="${ACCOUNT_HREF}"`)
    expect(out).toContain('border-dashed')
    expect(out).not.toMatch(/\sdisabled(=|\s|>)/)
  })

  it('leads to the screening at the address the design gives it', () => {
    expect(render()).toContain(
      'href="/radar/edital/51885242000140-1-000744/2026/triagem"',
    )
  })

  it('opens the agency portal in a new tab, safely', () => {
    const out = render()
    expect(out).toContain('href="https://exemplo.gov.br/pregao/744"')
    expect(out).toContain('rel="noreferrer noopener"')
  })

  it('says when the proposals have already closed', () => {
    const out = render({
      tender: { ...TENDER, closed: true, proposalsCloseAt: '2026-09-01T11:30:00.000Z' },
    })
    expect(out).toContain(page.closedNotice)
    expect(out).toContain(copy.card.closed)
  })

  it('reports how old the tender we are showing is', () => {
    expect(render()).toContain(
      format(copy.freshness.fresh, { idade: format(copy.age.minutes, { count: 30 }) }),
    )
  })
})

describe('the Opportunity screen before it has a tender', () => {
  it('analyzing is a live region with the way back still on screen', () => {
    const out = render({ tender: null, status: { kind: 'analyzing' } })
    expect(out).toContain(copy.states.analyzingTenderTitle)
    expect(out).toContain('aria-live="polite"')
    expect(out).toContain(page.back)
    expect(out.match(/<h1/g)).toHaveLength(1)
  })

  it('an id PNCP no longer serves is a 404 in words, with a way back', () => {
    const out = render({ tender: null, status: { kind: 'notFound' } })
    expect(out).toContain(page.notFoundTitle)
    expect(out).toContain(page.notFoundBody)
    expect(out).toContain(page.backToRadar)
    expect(out).not.toContain(copy.states.analyzingTenderTitle)
  })

  it('an error shows the reason the API gave', () => {
    const out = render({
      tender: null,
      status: { kind: 'error', code: 'server_error', text: messages.errors.pncpDown },
    })
    expect(out).toContain(copy.states.errorTitle)
    expect(out).toContain(messages.errors.pncpDown)
  })

  it('a ready status with no tender still renders a page, never a blank one', () => {
    const out = render({ tender: null })
    expect(out).toContain(page.notFoundTitle)
    expect(out.length).toBeGreaterThan(1_000)
  })
})

describe('OpportunityView · the AI notice (legal brief §2.2 rule 5)', () => {
  const notice = `${messages.ai.disclaimer} ${messages.ai.notLegalAdvice}`

  it('carries the notice, because this screen shows a compatibility reading', () => {
    expect(render({})).toContain(notice)
  })

  it('keeps it off the states that show no reading at all', () => {
    expect(render({ status: { kind: 'analyzing' }, tender: null })).not.toContain(notice)
    expect(render({ status: { kind: 'notFound' }, tender: null })).not.toContain(notice)
  })
})

describe('OpportunityView · the value slot', () => {
  it('sets a real figure in Archivo at 28px', () => {
    const out = render({})
    expect(out).toContain('text-[28px]')
    expect(out).toContain('R$ 48.196')
  })

  it('collapses to a quiet line when the agency published no value', () => {
    const out = render({ tender: { ...TENDER, estimatedValue: null } })
    expect(out).toContain(copy.card.noValue)
    // The 28px Archivo slot is for a figure; an absence does not get it.
    expect(out).not.toMatch(/text-\[28px\][^>]*>\s*Valor/)
  })

  it('names a confidential budget rather than printing whatever the row holds', () => {
    const out = render({ tender: { ...TENDER, confidentialBudget: true } })
    expect(out).toContain(copy.card.confidential)
    expect(out).not.toContain('R$ 48.196')
  })
})
