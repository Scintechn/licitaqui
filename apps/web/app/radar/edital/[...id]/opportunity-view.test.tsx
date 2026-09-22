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
  // PNCP's own vocabulary. It used to read 'Recebendo propostas', which is a
  // value the domain table does not have — and under the gate an unrecognised
  // status means no urgency, so the invented string would have silently turned
  // this control fixture into a suspended one.
  status: 'Divulgada no PNCP',
  pncpUpdatedAt: '2026-09-16T10:00:00.000Z',
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

describe('OpportunityView · traceability back to PNCP', () => {
  it('prints the Id contratação PNCP verbatim, in the Operação block', () => {
    const out = render({})
    expect(out).toContain(page.operation.pncpId)
    expect(out).toContain(TENDER.id)
    // Inside the Operação list, not under the title: the id has to sit in the
    // same <dl> as Modalidade and Situação.
    const operation = out.slice(out.indexOf(page.operationTitle))
    expect(operation).toContain(TENDER.id)
    expect(operation.indexOf(page.operation.modality)).toBeLessThan(
      operation.indexOf(page.operation.pncpId),
    )
  })

  it('leaves the id selectable, and offers a copy button beside it', () => {
    const out = render({})
    expect(out).toMatch(/select-all[^>]*>51885242000140-1-000744\/2026/)
    // Labelled, and the accessible name says which id it copies while still
    // containing the visible word (WCAG 2.5.3).
    expect(out).toContain(page.copyId)
    expect(out).toContain(page.copyIdContext)
    // The id is not *inside* the button: a click in a <button> does not select
    // its text, and pasting the id into PNCP's search is the point.
    expect(out).not.toMatch(/<button[^>]*>[^<]*51885242000140/)
  })

  it('links to the official PNCP record, in a new tab, safely', () => {
    const out = render({})
    expect(out).toContain('https://pncp.gov.br/app/editais/51885242000140/2026/744')
    expect(out).toContain(page.pncpLink)
    const anchor = out.slice(out.indexOf('https://pncp.gov.br/app/editais'))
    expect(anchor).toMatch(/target="_blank"/)
    expect(anchor).toMatch(/rel="noopener noreferrer"/)
    // The accessible name keeps the visible label and adds where it goes.
    expect(out).toContain(page.pncpLinkNewTab)
  })

  it('drops the sequence’s leading zeros, as the portal does', () => {
    const out = render({ tender: { ...TENDER, id: '87612826000190-1-000958/2026' } })
    expect(out).toContain('https://pncp.gov.br/app/editais/87612826000190/2026/958')
    expect(out).not.toContain('/2026/000958')
  })

  it('renders no link at all for an id it cannot parse', () => {
    const out = render({ tender: { ...TENDER, id: 'nao-e-um-id-pncp' } })
    expect(out).not.toContain('pncp.gov.br/app/editais')
    expect(out).not.toContain(page.pncpLink)
    // …but the id itself still shows, because it is what we hold.
    expect(out).toContain('nao-e-um-id-pncp')
  })

  it('keeps the PNCP record and the bidding system as two different links', () => {
    const out = render({})
    expect(out).toContain(page.pncpLink)
    expect(out).toContain(page.systemLink)
    expect(out).toContain('https://exemplo.gov.br/pregao/744')
  })
})

describe('OpportunityView · the whole Objeto', () => {
  // Three hundred characters of the kind of prose the órgãos actually publish,
  // with their own line breaks in it.
  const LONG =
    'CONTRATAÇÃO DE EMPRESAS PARA FORNECIMENTO DE MATERIAIS PERMANENTES PARA A SECRETARIA ' +
    'MUNICIPAL DE SAÚDE, conforme especificações, quantitativos e condições constantes do ' +
    'Termo de Referência — Anexo I deste Edital, a serem entregues de forma parcelada, ' +
    'mediante requisição da Secretaria, pelo período de 12 (doze) meses.\n' +
    'Lote 01 — mobiliário hospitalar.\nLote 02 — equipamentos de informática.'

  it('prints the object in full, with no truncation and no ellipsis', () => {
    const out = render({ tender: { ...TENDER, object: LONG } })
    expect(out).toContain(page.objectTitle)
    expect(out).toContain('pelo período de 12 (doze) meses.')
    expect(out).toContain('Lote 02 — equipamentos de informática.')
    // The h1 above still trims at 180 characters and keeps its ellipsis; this
    // block is the one place with no ellipsis in it.
    const block = out.slice(out.indexOf(page.objectTitle), out.indexOf(page.screeningCta))
    expect(block).not.toContain('…')
  })

  it('keeps every character the agency published, not a trimmed copy', () => {
    const out = render({ tender: { ...TENDER, object: LONG } })
    // The h1 is trimmed at 180 characters; this block must not be.
    const block = out.slice(out.indexOf(page.objectTitle))
    for (const fragment of ['Termo de Referência', 'requisição da Secretaria', 'Lote 01']) {
      expect(block).toContain(fragment)
    }
  })

  it('keeps the agency’s own line breaks rather than flattening the lots', () => {
    const out = render({ tender: { ...TENDER, object: LONG } })
    expect(out).toContain('whitespace-pre-line')
  })

  it('renders expanded, with no "ler mais" toggle to pay for', () => {
    const out = render({ tender: { ...TENDER, object: LONG } })
    const block = out.slice(out.indexOf(page.objectTitle))
    expect(block).not.toMatch(/line-clamp/)
    expect(out).not.toMatch(/ler mais/i)
  })

  it('sits before the call to action that offers the AI reading', () => {
    const out = render({ tender: { ...TENDER, object: LONG } })
    expect(out.indexOf(page.objectTitle)).toBeLessThan(out.indexOf(page.screeningCta))
  })

  it('is prose, not a second h1', () => {
    const out = render({ tender: { ...TENDER, object: LONG } })
    expect(out.match(/<h1/g)).toHaveLength(1)
  })

  it('disappears rather than printing an empty label', () => {
    const out = render({ tender: { ...TENDER, object: '   ' } })
    expect(out).not.toContain(page.objectTitle)
  })
})
