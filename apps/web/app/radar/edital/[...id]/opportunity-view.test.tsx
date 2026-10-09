import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { format, messages } from '@/lib/messages'
import type { SegmentFit, TenderDetail } from '@/lib/radar/contract'
import { TENDER_ITEMS_FIXTURE } from '@/lib/radar/items-fixture'
import { tenderBudget } from '@/lib/radar/headline'
import { AppShell } from '@/components/app-shell'
import type { AccountSummary } from '@/lib/account/summary'
import { screeningHref } from '@/lib/radar/client'
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
  shortTitle: null,
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
const SEARCH = { cnpj: '51885242000140', states: ['SP'], q: 'papel', group: 'check' } as const

/**
 * The common case, and the one Sci ruled must not change: someone opening a
 * tender they have never screened. The default here so the rest of the file
 * renders the screen as it ships, rather than one with the state missing.
 */
const FIRST_VISIT = { ready: false, spent: false, metered: true } as const

function render(overrides: Partial<OpportunityViewProps> = {}): string {
  const props: OpportunityViewProps = {
    tender: TENDER,
    freshness: { state: 'fresh', updatedAt: '2026-09-17T14:30:00.000Z', ageSeconds: 1_800 },
    status: { kind: 'ready' },
    backHref: '/radar?cnpj=51885242000140&group=check',
    search: SEARCH,
    screening: FIRST_VISIT,
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
    expect(out).toContain('border-dashed')
    expect(out).not.toMatch(/\sdisabled(=|\s|>)/)
    // **It used to assert the bare `ACCOUNT_HREF`, and that was the bug.** A
    // visitor who signed up from here landed on `/conta` and lost the edital
    // they were reading — recorded as a FINDING in `ricardo.spec.ts` and left
    // standing because `accountHref()`'s argument is optional, so no type
    // check could reach it. The signup now carries the way back.
    expect(out).toContain('/conta/criar?next=')
    expect(out).toContain(encodeURIComponent('/radar/edital/'))
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

  it('reads a published zero as "não informado", never as R$ 0,00', () => {
    // What Sci found on production, at this screen's VALOR ESTIMADO box.
    const out = render({ tender: { ...TENDER, estimatedValue: '0.00' } })
    expect(out).toContain(copy.card.noValue)
    expect(out).not.toContain(copy.card.confidential)
    expect(out).not.toMatch(/R\$\s*0\b/)
  })

  it('says the same three things the Radar card says about the same row', () => {
    // One decision, in `tenderBudget`. If the two screens ever disagree about
    // a row, a reader who taps a card sees the list contradicted by the page
    // it opened.
    for (const over of [
      { estimatedValue: '48196.00' },
      { estimatedValue: null },
      { estimatedValue: '0.00' },
      { confidentialBudget: true },
    ]) {
      const tender = { ...TENDER, ...over }
      const { value, note } = tenderBudget(tender)
      const out = render({ tender })
      expect(out).toContain(value ?? note ?? '')
    }
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

  /**
   * **Half inverted by D25**, on Sci's 2026-09-30 ruling. The block is trimmed
   * for the eye now, so the "no ellipsis" half is gone — that ellipsis is
   * `trimObject`'s and is the visible sign that there is more.
   *
   * The half that mattered survives untouched and is why this test is inverted
   * rather than deleted: **the whole objeto is still in the markup.** Trimming
   * what is shown is a rendering decision; withholding the agency's own words
   * from find-in-page or from assistive technology is not one this product may
   * make (§2.2 rule 4).
   */
  it('keeps the whole objeto in the markup, however little of it is shown', () => {
    const out = render({ tender: { ...TENDER, object: LONG } })
    expect(out).toContain(page.objectTitle)
    expect(out).toContain('pelo período de 12 (doze) meses.')
    expect(out).toContain('Lote 02 — equipamentos de informática.')
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

  /**
   * **Inverted by D25, on Sci's ruling of 2026-09-30**: *"settle the Objeto in
   * 3–4 lines + 'ler tudo'"*. It used to require the block expanded with no
   * toggle at all.
   *
   * Inverted and not deleted, because a deleted guard on this component is how
   * its position was silently reverted once already (`cc4b766`).
   *
   * **Two halves of the old rule survive, and they are the load-bearing ones.**
   * No `line-clamp`: `format.ts` argues truncation beats clamping because a
   * clamp hides that there is more and leaves the whole string in the
   * accessibility tree, so a screen-reader user would hear 500 characters while
   * a sighted one saw four lines. And the old assertion was a literal
   * `/ler mais/i` — Sci's wording is *"Ler tudo"*, which would have walked
   * straight past a guard written to stop exactly this, so the new one names
   * the string it actually renders.
   */
  it('trims with a real disclosure, and never with a clamp', () => {
    const out = render({ tender: { ...TENDER, object: LONG } })
    const block = out.slice(out.indexOf(page.objectTitle))
    expect(block).not.toMatch(/line-clamp/)
    expect(block).toContain('<details')
    expect(block).toContain(page.objectMore)
    expect(block).toContain(page.objectLess)
    // The whole objeto is still in the markup — trimmed for the eye, entire for
    // find-in-page and for anyone reading the page with assistive technology.
    expect(block).toContain(LONG.slice(-40))
  })

  it('leaves a short objeto alone rather than giving it a toggle', () => {
    const out = render({ tender: { ...TENDER, object: 'Compra de café em grão.' } })
    const block = out.slice(out.indexOf(page.objectTitle))
    expect(block).not.toContain('<details')
    expect(block).not.toContain(page.objectMore)
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
    //
    // The marker was `min-[900px]:grid` until D29 keyed the columns to the
    // block's own width instead of the window's. Only the spelling moved: this
    // guard is about the *order*, and it fails the same way if the block goes
    // back inside the grid. `indexOf` returning -1 for a renamed marker also
    // fails it, which is the behaviour we want — a guard that cannot find what
    // it guards must go red, not quietly pass.
    expect(out.indexOf(page.objectTitle)).toBeLessThan(out.indexOf('@min-[860px]:grid'))
  })

  /**
   * D29: the columns are a fact about this block, not about the viewport.
   *
   * `min-[900px]` was a viewport query, and D20 later put a 264px rail beside
   * the content from `lg` (1024px) up — so between 1024px and ~1164px the
   * block drew two columns in about 760px. The rail can also be collapsed to
   * 56px from `localStorage`, which no media query can observe at all.
   *
   * `renderToStaticMarkup` cannot measure a layout, so this asserts the
   * *mechanism* rather than the result: a container, and a container query
   * keyed to the width `main`'s content box had at the old breakpoint
   * (900 − 2×20 gutter = 860). The widths themselves are Playwright's.
   */
  it('keys its columns to the block, never to the viewport', () => {
    const out = render({ tender: { ...TENDER, object: LONG } })
    const at = out.indexOf('@min-[860px]:grid')
    expect(at).toBeGreaterThan(-1)
    // The query needs a container, and it must be a different element.
    const container = out.lastIndexOf('@container', at)
    expect(container).toBeGreaterThan(-1)
    expect(container).toBeLessThan(at)
    // No viewport query may govern this block again. The lookbehind is load
    // bearing: `\b` sits between `@` and `min`, so a bare word boundary here
    // matches the container query this test exists to require.
    const block = out.slice(container, out.indexOf(page.screeningCta))
    expect(block).not.toMatch(/(?<!@)min-\[\d+px\]:/)
  })

  /**
   * The action, pinned above the record — the same kind of guard as the three
   * above it, and for the same reason.
   *
   * Until 2026-09-24 the CTA was the last thing on the page, under the Itens
   * panel. `ITEMS_PAGE` is 20 and an item card is ~140px at 400px, so it sat
   * roughly 4 500px down a 700px viewport, and every "Mostrar mais" press
   * pushed it another ~2 800px away: the control that helps someone evaluate
   * was the control that buried the action.
   *
   * Sci found it on `08358889000195-1-000160/2026`. Nothing pinned the order,
   * so nothing would have stopped a later merge putting it back — which is
   * exactly what happened to the Objeto block and `cc4b766`.
   */
  /**
   * **This guard changed shape on 2026-09-30, and the reason is the point.**
   *
   * It used to require the CTA to sit above the tab strip, because the CTA was
   * in the page: below the Itens panel it sat ~4 500px down a 700px viewport
   * and every "Mostrar mais" pushed it another ~2 800px away. Position in the
   * document was the only thing keeping it reachable.
   *
   * The action is now in the bar, which is `sticky` and on screen at every
   * width, so its position in the document no longer decides anything — and
   * asserting the old order would now be asserting the opposite of the fix.
   * What still has to hold is that the agency's own words come before the
   * record, and that the action is **not** in the page.
   */
  it('keeps the action out of the scroll entirely', () => {
    const out = render({ tender: { ...TENDER, object: LONG } })
    const at = (needle: string) => {
      const i = out.indexOf(needle)
      expect(i).toBeGreaterThan(-1)
      return i
    }
    // One CTA, and it is the bar's — after `</main>`, not buried in it.
    expect(at(page.screeningCta)).toBeGreaterThan(at('</main>'))
    // **And it is the only one.** Without this the guard is document order
    // alone: a restored in-page duplicate rendering the *returning* label
    // would leave `indexOf(screeningCta)` pointing at the bar and pass.
    expect(out.split('href="/radar/edital/'), 'one link into the triagem tree').toHaveLength(2)
    // Whether it is *pinned* is a layout fact and `environment: 'node'` has no
    // boxes — `e2e/journeys/tender-action-bar.spec.ts` measures that, at every
    // width, now including desktop.
  })

  /**
   * §2.2 rule 5 says the AI notice appears on **every result screen**, and it
   * still does. What it no longer does is sit immediately above the button:
   * the button left the page for the bar, and Sci moved the notice to the foot
   * of the reading on 2026-09-30 — *"the disclaimer is [necessary], can be at
   * the footer of this page"*.
   *
   * The consequence is written down rather than left to be discovered: the
   * action is always on screen, so a reader can press it without having
   * scrolled to the notice. That is a question about what the rule means, not
   * about whether this screen carries the sentence, and it is Sci's.
   */
  it('still carries the AI notice, now closing the reading (§2.2 rule 5)', () => {
    // Both halves, and on **both tabs**: the notice sits below the record, and
    // the nearest wrong place to put it is inside the Itens panel — where the
    // order assertions below still hold and a reader on Documentos gets no
    // notice at all. `pncpUrl` is the other trap: the block beside it renders
    // only for an id this app can parse.
    for (const tab of ['items', 'files'] as const) {
      const out = render({ tender: { ...TENDER, object: LONG }, tab })
      const notice = out.indexOf(messages.ai.disclaimer)
      expect(notice, tab).toBeGreaterThan(-1)
      expect(out, tab).toContain(messages.ai.notLegalAdvice)
      expect(notice, tab).toBeGreaterThan(out.indexOf('role="tablist"'))
      expect(notice, 'inside the reading, not stranded after it').toBeLessThan(
        out.indexOf('</main>'),
      )
    }
    // And on a tender whose id this app cannot parse, which drops the PNCP
    // block the notice now sits beside.
    const unparseable = render({ tender: { ...TENDER, id: 'nao-e-um-id-do-pncp' } })
    expect(unparseable).toContain(messages.ai.disclaimer)
  })

  it('keeps "Ver no PNCP" available without letting it compete', () => {
    // Sci, 2026-09-24: keep it, "but in a not too express way". It is the
    // source line, not a second call to action — so it stays below the record
    // and is no longer a full-width secondary button.
    const out = render({ tender: { ...TENDER, object: LONG } })
    expect(out).toContain(page.pncpLink)
    expect(out.indexOf(page.pncpLink)).toBeGreaterThan(out.indexOf('role="tablist"'))
    const anchor = out.slice(out.indexOf(page.pncpLink) - 400, out.indexOf(page.pncpLink))
    expect(anchor).not.toContain('border-line-strong')
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
    // `'<p '` with the space, not `'<p'`: D25 gave the block a disclosure whose
    // chevron renders `<path d="…">`, and a prefix match found that instead of
    // the paragraph. The guard was right and looking at the wrong tag.
    const open = after.indexOf('<p ')
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
    // The dashed upsell surface, inside the panel, as a real link — and one
    // that comes back to this edital rather than dropping him on `/conta`.
    expect(out).toContain('border-dashed')
    expect(out).toContain('/conta/criar?next=')
    expect(out).toContain(encodeURIComponent('tab=files'))
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
 * ever happened.
 *
 * His ruling on the cure is narrower than the problem looks, and these tests
 * are the statement of it: *"If it is the first time of that user, the CTA
 * stays as-is. However, if the user already requested the triage before, he
 * only wants to see it again, so we could change the text."*
 *
 * So the switch is `spent`, and the first-time label does not move.
 */
describe('the call to action recognises a triagem this user already asked for', () => {
  it('changes the words once this user has requested it', () => {
    const out = render({ screening: { ready: true, spent: true, metered: true } })
    expect(out).toContain(page.screeningCtaRequested)
    expect(out).not.toContain(page.screeningCta)
  })

  it('leaves the first-time label exactly as it ships', () => {
    const out = render({ screening: { ready: false, spent: false, metered: true } })
    expect(out).toContain(page.screeningCta)
    expect(out).not.toContain(page.screeningCtaRequested)
  })

  /**
   * The case that must **not** flip the label. `ai_analyses` has no `user_id`
   * — a reading exists because somebody else opened this edital (§3.2) — and
   * for this user that is still a first request, which is what Sci wants it to
   * read as. Switching on `ready` here would tell them a triagem they never
   * asked for is theirs.
   */
  it('is still the first-time label when somebody else paid for the reading', () => {
    const out = render({ screening: { ready: true, spent: false, metered: true } })
    expect(out).toContain(page.screeningCta)
    expect(out).not.toContain(page.screeningCtaRequested)
  })

  /**
   * Paid, but nothing current to show — the job is still running, or the
   * agency republished the edital and `files_hash` moved. Still theirs, still
   * free, so still the recognising label; the screen behind it says what it
   * found.
   */
  it('recognises a request that has not produced a current reading yet', () => {
    expect(render({ screening: { ready: false, spent: true, metered: true } })).toContain(
      page.screeningCtaRequested,
    )
  })

  it('falls back to the shipping label before the route has answered', () => {
    const out = render({ screening: null })
    expect(out).toContain(page.screeningCta)
    expect(out).not.toContain(page.screeningCtaRequested)
  })
})

/**
 * The cost line is a **separate** decision from the label, still with Sci, so
 * it is one flag and not a branch inside the label logic. These pin that the
 * two are independent: turning the caption on does not change which words the
 * button uses, and turning it off does not hide the recognition.
 */
describe('the cost line under the button, which is its own question', () => {
  it('is off by default — an unchanged label is what was approved', () => {
    const out = render({ screening: { ready: false, spent: false, metered: true } })
    expect(out).not.toContain(page.screeningCost)
    expect(out).not.toContain(page.screeningCostReady)
  })

  it('warns a first-time reader when it is switched on', () => {
    const out = render({ screening: { ready: false, spent: false, metered: true }, showScreeningCost: true })
    expect(out).toContain(page.screeningCost)
    // The label is untouched by the flag: that is the whole point of it.
    expect(out).toContain(page.screeningCta)
  })

  /**
   * §3.2 shares the analysis and §10 still charges this reader for it, so
   * "already read" and "free" are different claims and only the first is true.
   */
  it('says a reading exists and still costs one, when it does', () => {
    const out = render({ screening: { ready: true, spent: false, metered: true }, showScreeningCost: true })
    expect(out).toContain(page.screeningCostReady)
  })

  it('never puts a cost on a triagem this user has already paid for', () => {
    const out = render({ screening: { ready: true, spent: true, metered: true }, showScreeningCost: true })
    expect(out).not.toContain(page.screeningCost)
    expect(out).not.toContain(page.screeningCostReady)
    expect(out).toContain(page.screeningCtaRequested)
  })

  it('never tells an unlimited plan that a triagem uses up an allowance', () => {
    // `plan_limits` gives `promocional`, `essencial` and `pro` a null
    // quantity. For six hours on the morning founders week opened, everyone
    // who had just paid read "Usa 1 das suas triagens" under the button — on
    // a plan whose own feature list says "Triagens de edital sem limite".
    const paid = render({
      screening: { ready: false, spent: false, metered: false },
      showScreeningCost: true,
    })
    expect(paid).not.toContain(page.screeningCost)
    expect(paid).not.toContain(page.screeningCostReady)

    // …and the visitor, for whom it is true, still sees it.
    const visitor = render({
      screening: { ready: false, spent: false, metered: true },
      showScreeningCost: true,
    })
    expect(visitor).toContain(page.screeningCost)
  })
})

/**
 * D25 (3) and (4) — the action bar, and the count under its button.
 *
 * Sci's journey, 2026-09-29: *"the decision is below the fold"*. The bar takes
 * the one action this screen is for out of the scroll.
 *
 * **These render the screen, and one of them renders it inside a real
 * `AppShell`**, because the count reaches the bar through the shell's context
 * and nothing else. That is the assertion this repo keeps failing to make:
 * `menu-view.test.tsx` rendered a drawer nothing could open, and #93 shipped
 * `onOpenMenu` on a props type that no screen called, green throughout. A test
 * that renders `ActionBar` with a caption prop would prove only that a string
 * passed to a component comes out of it.
 *
 * What these cannot do is see a layout: `environment: 'node'` has no boxes, so
 * whether the bar actually covers the last row of the Itens list is
 * `e2e/journeys/tender-action-bar.spec.ts` (CLAUDE.md §4c).
 */
describe('the action bar', () => {
  /**
   * The bar's markup — **its subtree, not the rest of the document**.
   *
   * The first version sliced to the end of the string, which inside a shell
   * swept up `Sheet` and the whole `MenuView`. Its assertions survived by the
   * luck of their wording: `not.toContain('z-50')` would have failed on the
   * drawer, and the caption checks passed only because `MenuView` says
   * "3 de 5 triagens usadas" and never "Restam". So this counts `<div>`s.
   */
  function bar(html: string): string {
    const at = html.indexOf('sticky bottom-0')
    expect(at, 'the screen must draw the bottom bar').toBeGreaterThan(-1)
    const open = html.lastIndexOf('<div', at)
    let depth = 0
    for (const tag of html.slice(open).matchAll(/<(\/?)div\b[^>]*>/g)) {
      depth += tag[1] === '/' ? -1 : 1
      if (depth === 0) return html.slice(open, open + tag.index + tag[0].length)
    }
    throw new Error('the bar’s subtree is not closed')
  }

  /** The same screen, inside the shell that actually wraps it in `/radar`. */
  function inShell(summary: AccountSummary | null, overrides: Partial<OpportunityViewProps> = {}) {
    const props: OpportunityViewProps = {
      tender: TENDER,
      freshness: { state: 'fresh', updatedAt: '2026-09-17T14:30:00.000Z', ageSeconds: 1_800 },
      status: { kind: 'ready' },
      backHref: '/radar?cnpj=51885242000140&group=check',
      search: SEARCH,
      screening: FIRST_VISIT,
      now: NOW,
      ...overrides,
    }
    return renderToStaticMarkup(
      <AppShell summary={summary}>
        <OpportunityView {...props} />
      </AppShell>,
    )
  }

  function quota(over: Partial<AccountSummary['screenings']> = {}): AccountSummary {
    return {
      plan: 'basico',
      screenings: {
        feature: 'screening',
        plan: 'basico',
        period: 'month',
        limit: 5,
        used: 2,
        left: 3,
        ...over,
      },
      alerts: { feature: 'alert', plan: 'basico', period: 'week', limit: 1, used: 0, left: 1 },
      founderSeat: null,
      signedIn: true,
    }
  }

  it('is drawn at every width, now that it is laid out by the column', () => {
    // It was `lg:hidden` while it was `fixed`: a fixed bar is positioned
    // against the viewport and the rail is 56px or 264px of *layout* whose
    // state is `localStorage`, so no left edge was right in both. A sticky bar
    // is laid out by the column, so the breakpoint had nothing left to do —
    // and dropping it is what lets each screen keep exactly one CTA.
    const block = bar(render())
    expect(block).not.toContain('lg:hidden')
    // `sheet.tsx` reserved this: the drawer is `z-50` and must stay over it.
    expect(block).toContain('z-40')
    expect(block).not.toContain('z-50')
    // And the drawer really is above it, on the screen as it ships.
    expect(bar(inShell(null))).not.toContain('z-50')
  })

  it('is the only way to the triagem, not one of two', () => {
    // Two controls for one action is how a screen comes to say two things —
    // and below `lg` it was also two links with one accessible name. The
    // in-page button is deleted, not hidden.
    const first = render()
    // React escapes the `&` between the query's parameters, so the literal in
    // the markup is not the string the helper returns.
    const href = `href="${screeningHref(TENDER.id, SEARCH).replaceAll('&', '&amp;')}"`
    expect(first.split(href), 'exactly one link to the triagem').toHaveLength(2)
    expect(bar(first)).toContain(page.screeningCta)

    const again = render({ screening: { ready: true, spent: true, metered: true } })
    expect(bar(again)).toContain(page.screeningCtaRequested)
    expect(bar(again)).not.toContain(page.screeningCta)
  })

  /**
   * The second slot, Sci's ruling of 2026-09-30, in the words the tabs
   * themselves use. **And the anchor it points at has to exist**: a link to a
   * fragment nothing defines is this repo's named defect wearing an `href` —
   * `radar.list.changeCompany` was approved copy rendered nowhere, and this
   * would be an approved control leading nowhere.
   */
  it('sends the reader to the record, and the record is there to be sent to', () => {
    const html = render()
    const anchor = html.match(/href="#([a-z-]+)"/)
    expect(anchor, 'the second slot is an in-page link').not.toBeNull()
    expect(bar(html)).toContain(page.barRecord)
    expect(html).toContain(`id="${(anchor as RegExpMatchArray)[1]}"`)
  })

  it('renders without the count, outside a shell and before one is read', () => {
    // The Landing renders these screens' siblings with no shell at all, and
    // the server pass has no summary yet. Both must draw the bar anyway —
    // "the server fallback renders the bar without the count and fills in".
    expect(bar(render())).not.toContain('Restam')
    expect(bar(inShell(null))).not.toContain('Restam')
  })

  /**
   * **The combination the app actually renders, which no test had.**
   *
   * `opportunity-screen.tsx` passes `showScreeningCost` unconditionally, so a
   * metered reader on a fresh edital meets *both* facts: this will cost one,
   * and you have N. The captions were briefly a ternary — cost *or* count —
   * and because `screeningsLeftCaption` answers only for `visitor` and
   * `basico`, which are exactly the metered plans, the count could then never
   * appear on a first visit at all. D25 (4) was deleted and every test stayed
   * green, because the cost tests render without a shell and the count tests
   * render in a shell without `showScreeningCost`. That pair is a shape the
   * product never produces, and it was the only shape under test.
   */
  it('tells a metered reader both the cost and what is left', () => {
    const block = bar(inShell(quota(), { showScreeningCost: true }))
    expect(block, 'the press will spend one').toContain(page.screeningCost)
    expect(block, 'and this is how many remain').toContain('Restam 3 triagens neste mês')
  })

  it('drops the cost line, not the count, once the triagem is already hers', () => {
    const block = bar(
      inShell(quota(), {
        showScreeningCost: true,
        screening: { ready: true, spent: true, metered: true },
      }),
    )
    expect(block).not.toContain(page.screeningCost)
    expect(block).toContain('Restam 3 triagens neste mês')
  })

  it('takes the count from the shell’s one server read', () => {
    // Not a second `readShell()` in `page.tsx`: a session read outside the
    // Suspense boundary costs the whole page on a cold Neon.
    const html = inShell(quota())
    expect(bar(html)).toContain('Restam 3 triagens neste mês')
  })

  it('puts the count under the button and never inside its label', () => {
    // A primary action that is also a status readout resizes under itself as
    // the number changes, and it cannot be translated — the label and the
    // count are two sentences with two different plural rules.
    const block = bar(inShell(quota()))
    const cta = block.indexOf(page.screeningCta)
    const close = block.indexOf('</a>', cta)
    const label = block.slice(block.lastIndexOf('<a', cta), close)
    expect(label).toContain(page.screeningCta)
    expect(label, 'the count is a sibling of the button, not part of it').not.toContain('Restam')
    expect(block.indexOf('Restam'), 'and it comes after it').toBeGreaterThan(close)
  })

  it('says nothing about a quota it has no sentence for', () => {
    // `essencial` is unlimited — `left: null` — and the morning founders week
    // opened, "Usa 1 das suas triagens" ran for six hours under this button on
    // plans whose own feature list says "Triagens de edital sem limite".
    const unlimited = quota({ plan: 'essencial', limit: null, left: null })
    expect(bar(inShell({ ...unlimited, plan: 'essencial' }))).not.toContain('Restam')
    // Exhausted belongs to `radar.screening.quotaTitle`, which reads the real
    // total from `plan_limits`; the `=0` copy here names a literal 5.
    expect(bar(inShell(quota({ used: 5, left: 0 })))).not.toContain('triagens deste mês')
  })

  /**
   * The bar reserves its own height by **being in the flow**, so nothing can
   * be covered and there is no number to get wrong.
   *
   * The first version was `fixed` plus a `BAR_CLEARANCE` padding constant, and
   * the test here asserted `main` contained that same constant — importing it
   * and looking for the string it had just produced. It passed for every
   * possible value, including `pb-0`, which is what the review proved by
   * setting it. The measured heights are 69px to 144px across widths, labels
   * and the caption, so no constant was ever going to be right.
   */
  it('takes its room from the flow rather than from a constant', () => {
    const block = bar(render())
    expect(block).toContain('sticky')
    expect(block, 'out of flow is what made a clearance necessary').not.toContain('fixed')
    // And it is the last thing in the column, after `main`, which is the one
    // thing `sticky bottom-0` needs from its caller.
    const html = render()
    expect(html.indexOf('sticky bottom-0')).toBeGreaterThan(html.indexOf('</main>'))
  })
})
