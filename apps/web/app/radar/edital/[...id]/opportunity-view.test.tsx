import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { format, messages } from '@/lib/messages'
import type { SegmentFit, TenderDetail } from '@/lib/radar/contract'
import { ACCOUNT_HREF } from '@/lib/routes'
import { TENDER_ITEMS_FIXTURE } from '@/lib/radar/items-fixture'
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

/** A real search, so every outbound link in these views is asserted to carry it. */
const SEARCH = { cnpj: '51885242000140', state: 'SP', q: 'papel', group: 'check' } as const

/**
 * The state Sci was actually in when he reported the button: a reading exists
 * and he had already paid for it. The default here so the rest of the file
 * renders a realistic screen rather than one with the state missing.
 */
const SCREENED = { ready: true, spent: true } as const

function render(overrides: Partial<OpportunityViewProps> = {}): string {
  const props: OpportunityViewProps = {
    tender: TENDER,
    freshness: { state: 'fresh', updatedAt: '2026-09-17T14:30:00.000Z', ageSeconds: 1_800 },
    status: { kind: 'ready' },
    backHref: '/radar?cnpj=51885242000140&group=check',
    search: SEARCH,
    screening: SCREENED,
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
    const out = render({ tab: 'files' })
    expect(out).toContain(page.filesLocked)
    expect(out).toContain(`href="${ACCOUNT_HREF}"`)
    expect(out).toContain('border-dashed')
    expect(out).not.toMatch(/\sdisabled(=|\s|>)/)
  })

  it('leads to the screening at the address the design gives it', () => {
    expect(render()).toContain('href="/radar/edital/51885242000140-1-000744/2026/triagem?')
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

  /**
   * The order, pinned — restored from task #56, which wrote it and proved it
   * guards by reverting the move and watching these fail.
   *
   * The Objeto is what the edital *is*, "Por que este edital apareceu para
   * você" is our commentary on it, "Operação" is metadata about it, and the
   * `Itens`/`Documentos` tabs are its parts. A person reads the thing before
   * reading what we say about the thing. Moving this block back under the
   * two-column grid must fail here.
   *
   * These three tests were **deleted** by `task/b9-tender-status`, whose merge
   * (`cc4b766`) also put the block back under the grid and restored
   * `max-w-[62ch]`. B9's own diff touches `FullObject` zero times, so none of
   * it was decided — and with the guards gone CI stayed green while undoing a
   * change Sci had asked for by name. That is the failure mode a pinned order
   * is supposed to make impossible, so they are back, and the fourth one below
   * extends the same guard over the tabs this PR adds.
   */
  it('comes after the deadline/value box and before everything we say about it', () => {
    const out = render({ tender: { ...TENDER, object: LONG } })
    const at = (needle: string) => {
      const i = out.indexOf(needle)
      expect(i).toBeGreaterThan(-1)
      return i
    }
    expect(at(page.estimatedValue)).toBeLessThan(at(page.objectTitle))
    expect(at(page.objectTitle)).toBeLessThan(at(page.whyTitle))
    expect(at(page.objectTitle)).toBeLessThan(at(page.operationTitle))
  })

  it('spans the content column instead of sharing the two-column grid', () => {
    const out = render({ tender: { ...TENDER, object: LONG } })
    // The grid wrapper must open *after* the Objeto block, never around it.
    expect(out.indexOf(page.objectTitle)).toBeLessThan(out.indexOf('min-[900px]:grid'))
  })

  /**
   * This test used to assert the opposite, and the flip is the point.
   *
   * It shipped as "caps the measure rather than setting type across the whole
   * column", pinning `max-w-[68ch]` — about 570px — on the typographic
   * argument that 105 characters of dense uppercase legal prose is a poor
   * measure. Sci overruled it on 2026-09-22: *"why does the Objeto text not
   * take the entire width like the table above?"* Everything this block
   * touches is full width, so at 571px it aligned with nothing on the screen
   * and read as a mistake.
   *
   * Inverted rather than deleted, because the next person to notice the long
   * line will be right about the typography and still wrong about the screen,
   * and because a deleted guard on this component is exactly how the block's
   * position was silently reverted once already (see `FullObject`).
   */
  it('spans the full column: any width cap here is a regression', () => {
    const out = render({ tender: { ...TENDER, object: LONG } })
    // The Objeto's own <p>, isolated — a `max-w-` anywhere else on the screen
    // must neither satisfy nor break this.
    const after = out.slice(out.indexOf(page.objectTitle))
    const open = after.indexOf('<p')
    const tag = after.slice(open, after.indexOf('>', open) + 1)
    expect(tag).toContain('whitespace-pre-line')
    expect(tag).not.toMatch(/max-w-/)
    // Belt and braces: the old cap by name, anywhere in the block.
    expect(after.slice(0, after.indexOf('</section>'))).not.toContain('max-w-[68ch]')
  })

  it('stays above the record’s tabs: the object is read before its parts', () => {
    // The fourth guard, and the reason it is its own named test rather than a
    // side effect of a tab assertion: the last test that pinned this order was
    // deleted by a lane that had no idea it was load-bearing.
    const out = render({
      tender: { ...TENDER, object: LONG, items: TENDER_ITEMS_FIXTURE, itemCount: 15 },
    })
    const strip = out.indexOf('role="tablist"')
    expect(strip).toBeGreaterThan(-1)
    expect(out.indexOf(page.objectTitle)).toBeLessThan(strip)
    // …and the tabs still come after the commentary, so the whole chain holds:
    // box → Objeto → why → Operação → tabs.
    expect(out.indexOf(page.operationTitle)).toBeLessThan(strip)
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

/**
 * The record's tabs — the same strip the triagem screen has, on the screen
 * that comes before it.
 *
 * Sci, on the two screens of the same tender: *"I believe we need to keep the
 * same design system and have the file in the same tabs, not placed surfing
 * anywhere."* Before this the screen ended in a loose
 * `EDITAL E ANEXOS · CRIAR CONTA` button with a bare `.zip` link under the
 * call to action.
 */
describe('OpportunityView · the record’s tabs', () => {
  const WITH_ITEMS: TenderDetail = { ...TENDER, items: TENDER_ITEMS_FIXTURE, itemCount: 15 }

  it('draws the strip the design system already has, not a second one', () => {
    const out = render({ tender: WITH_ITEMS })
    expect(out).toContain('role="tablist"')
    expect(out).toContain('role="tabpanel"')
    expect(out).toContain(page.tabs.items)
    expect(out).toContain(page.tabs.files)
  })

  it('opens on Itens, which is why Sci was opening PNCP beside us', () => {
    const out = render({ tender: WITH_ITEMS })
    expect(out).toMatch(/aria-selected="true"[^>]*>[\s\S]{0,40}Itens/)
    expect(out).toContain('FILMAGEM COM CAMÊRA')
    expect(out).toContain('R$ 326.668,00')
  })

  it('carries no stray files block outside the tabs any more', () => {
    const out = render({ tender: WITH_ITEMS })
    const panel = out.slice(out.indexOf('role="tablist"'))
    // The only occurrence of the locked label is inside the Documentos panel…
    expect(out.match(new RegExp(page.filesLocked, 'g'))).toBeNull()
    // …and on the Itens tab it is not on the screen at all.
    expect(panel).not.toContain(page.filesLocked)
  })

  it('puts the tabs after the Objeto, the way PNCP puts them after the object', () => {
    const out = render({ tender: WITH_ITEMS })
    expect(out.indexOf(page.objectTitle)).toBeLessThan(out.indexOf('role="tablist"'))
  })

  it('never puts the Objeto, the why-list or Operação behind a tab', () => {
    const out = render({ tender: WITH_ITEMS })
    const strip = out.indexOf('role="tablist"')
    for (const outside of [page.objectTitle, page.whyTitle, page.operationTitle]) {
      expect(out.indexOf(outside)).toBeLessThan(strip)
    }
  })

  it('keeps the deadline and value card above the tabs', () => {
    const out = render({ tender: WITH_ITEMS })
    expect(out.indexOf(page.proposalsUntil)).toBeLessThan(out.indexOf('role="tablist"'))
    expect(out.indexOf(page.estimatedValue)).toBeLessThan(out.indexOf('role="tablist"'))
  })
})

describe('OpportunityView · the Documentos tab', () => {
  const FILE = {
    sequence: 1,
    title: 'TR, Edital e seus anexos 32.2026.zip',
    docType: 'Edital',
    url: 'https://pncp.gov.br/arquivo/32-2026.zip',
    publishedAt: '2026-09-14T12:00:00.000Z',
    pages: null,
    noText: false,
  }

  it('shows a visitor that documents exist and that an account opens them', () => {
    const out = render({ tab: 'files' })
    expect(out).toContain(page.filesLocked)
    expect(out).toContain(page.filesLockedNote)
    // The dashed upsell surface, inside the panel, as a real link.
    expect(out).toContain('border-dashed')
    expect(out).toContain(`href="${ACCOUNT_HREF}"`)
  })

  it('marks the locked tab with the padlock before it is opened', () => {
    const out = render({ tab: 'items' })
    const strip = out.slice(out.indexOf('role="tablist"'), out.indexOf('role="tabpanel"'))
    expect(strip).toContain(page.tabs.files)
    expect(strip).toContain('<svg')
  })

  it('keeps the tab selectable for a visitor rather than linking straight out', () => {
    // The screening screen locks Documentos as a link because the files are
    // elsewhere; here the panel is the explanation, so it has to be openable.
    const out = render({ tab: 'items' })
    const strip = out.slice(out.indexOf('role="tablist"'), out.indexOf('role="tabpanel"'))
    expect(strip.match(/role="tab"/g)).toHaveLength(2)
    expect(strip).not.toContain('href=')
  })

  it('lists the real files for someone who has an account', () => {
    const out = render({ tab: 'files', tender: { ...TENDER, files: [FILE] } })
    expect(out).toContain('TR, Edital e seus anexos 32.2026.zip')
    expect(out).toContain(FILE.url)
    expect(out).not.toContain(page.filesLocked)
  })

  it('says the agency published nothing rather than showing an empty tab', () => {
    const out = render({ tab: 'files', tender: { ...TENDER, files: [] } })
    expect(out).toContain(page.files.emptyTitle)
    expect(out).toContain(page.files.emptyBody)
    expect(out).not.toContain(page.filesLocked)
  })
})

describe('OpportunityView · the tabs and the B9 status gate', () => {
  const SUSPENDED: TenderDetail = {
    ...TENDER,
    status: 'Suspensa',
    items: TENDER_ITEMS_FIXTURE,
    itemCount: 15,
  }

  it('still banners the suspension above everything, tabs and all', () => {
    const out = render({ tender: SUSPENDED })
    expect(out).toContain(copy.status.chip.suspensa)
    expect(out.indexOf(copy.status.chip.suspensa)).toBeLessThan(out.indexOf('role="tablist"'))
  })

  it('adds no urgency of its own: the items tab says nothing about the clock', () => {
    const out = render({ tender: SUSPENDED })
    for (const urgency of ['último dia', 'restantes', 'Ainda dá tempo', 'dias']) {
      expect(out).not.toContain(urgency)
    }
  })

  it('shows the items anyway — suppressing urgency is not hiding the tender', () => {
    const out = render({ tender: SUSPENDED })
    expect(out).toContain('R$ 326.668,00')
    expect(out).toContain('R$ 2.988.571,02')
  })

  it('never lets the sum of the items pass for the tender’s own value', () => {
    // `estimated_value` is null on this tender in production; the card above
    // must say so and the tab below must not quietly fill the gap.
    const out = render({
      tender: { ...SUSPENDED, estimatedValue: null },
    })
    expect(out).toContain(copy.card.noValue)
    const value = out.slice(out.indexOf(page.estimatedValue), out.indexOf('role="tablist"'))
    expect(value).not.toContain('2.988.571,02')
    expect(out).toContain(messages.radar.opportunity.items.sumNote)
  })
})

/**
 * Sci, on production, the same evening the card → tender link was fixed: *"I
 * lost the list of items after I came back from seeing the AI triagem."* The
 * CTA below was `${tenderHref(id)}/triagem` — the tender's address with a word
 * stuck on the end and the search left behind — so the triagem screen, which
 * reads its own "Voltar" out of its query string, had nothing to read.
 */
describe('the link out of this screen carries the search', () => {
  it('sends the CTA the CNPJ, the UF, the words and the tab', () => {
    expect(render()).toContain(
      `href="/radar/edital/${TENDER.id}/triagem?cnpj=51885242000140&amp;uf=SP&amp;q=papel&amp;group=check"`,
    )
  })

  it('never links to a bare triagem', () => {
    expect(render()).not.toContain(`href="/radar/edital/${TENDER.id}/triagem"`)
  })
})

/**
 * Sci, on production: *"I already have the AI Triage for this item … but the
 * button remains like the first time, for my user."* It did: the CTA was one
 * fixed string, because nothing in the tender payload knew a screening had
 * ever happened. Opening a reading you have paid for is free; opening one you
 * have not spends from §10's allowance **whether or not the shared analysis
 * already exists** (§3.2) — two actions that were sharing a label.
 */
describe('the call to action says which of the two actions it is', () => {
  it('offers to open, and says it is free, once this caller has paid', () => {
    const out = render({ screening: { ready: true, spent: true } })
    expect(out).toContain(page.screeningCta)
    expect(out).toContain(page.screeningDone)
    expect(out).not.toContain(page.screeningCtaNew)
  })

  it('warns that it costs a triagem when this caller has not paid', () => {
    const out = render({ screening: { ready: false, spent: false } })
    expect(out).toContain(page.screeningCtaNew)
    expect(out).toContain(page.screeningCost)
    expect(out).not.toContain(page.screeningDone)
  })

  /**
   * The case §3.2 creates and §10 charges for: somebody else's screening of
   * this edital is already in `ai_analyses`, and this user still spends one to
   * read it. Saying "Ver" here would promise a free look at a paid door.
   */
  it('still warns when a reading exists that this caller has not paid for', () => {
    const out = render({ screening: { ready: true, spent: false } })
    expect(out).toContain(page.screeningCtaNew)
    expect(out).toContain(page.screeningCostReady)
    expect(out).not.toContain(page.screeningDone)
  })

  /**
   * Paid, but nothing to show yet — the job is still running, or the agency
   * republished the edital and `files_hash` moved, so `readScreening` no
   * longer matches. Free to open either way, and the screen behind it is the
   * one that says what it found.
   */
  it('is free to open when paid for even if the reading is not current', () => {
    const out = render({ screening: { ready: false, spent: true } })
    expect(out).toContain(page.screeningCta)
    expect(out).toContain(page.screeningDone)
  })

  it('says nothing about cost before the route has answered', () => {
    const out = render({ screening: null })
    expect(out).not.toContain(page.screeningDone)
    expect(out).not.toContain(page.screeningCost)
  })
})
