import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ACCOUNT_HREF } from '@/lib/routes'
import { messages } from '@/lib/messages'
import { accountHref } from '@/lib/routes'
import { priceHref, tenderHref } from '@/lib/radar/client'
import type { QuotaView, TenderDetail, VisitorView } from '@/lib/radar/contract'
import type { ScreeningModel } from '@/lib/radar/screening-result'
import { ScreeningView, quotaLabel, type ScreeningViewProps } from './screening-view'

/**
 * Canvas 04, state by state.
 *
 * The view is a pure function of a view model, so every state a person can
 * reach — including the three nobody wants to design (timeout, failed, quota
 * exhausted) — is a render here rather than a thing to reproduce by hand.
 */

const copy = messages.radar
const page = copy.screening
/** The shared `Files` component draws from the Opportunity screen's copy. */
const opportunity = copy.opportunity

const TENDER = {
  id: '00394544000185-1-002027/2026',
  object: 'Implantação de sistema de abastecimento de água na Aldeia São João',
  agencyName: 'Distrito Sanitário Especial Indígena Tapajós',
  city: 'Jacareacanga',
  state: 'PA',
  modalityName: 'Concorrência Eletrônica',
} as unknown as TenderDetail

const MODEL: ScreeningModel = {
  score: 2,
  verdict: page.verdict.hard,
  reason: 'Obra complexa de engenharia sem benefício para ME/EPP.',
  object: 'Implantação de sistema de abastecimento de água',
  qualification: [
    {
      id: 'meEpp',
      label: copy.fields.meEpp,
      value: copy.values.meEppNone,
      tone: 'neutral',
      page: 35,
      pageUnverified: false,
      known: true,
      note: null,
    },
    {
      id: 'minimumCapital',
      label: copy.fields.minimumCapital,
      value: 'R$ 169.334,68',
      tone: 'attention',
      page: 17,
      pageUnverified: false,
      known: true,
      note: 'Patrimônio líquido mínimo de 10% do valor total estimado.',
    },
    {
      id: 'sample',
      label: copy.fields.sample,
      value: copy.values.notRequired,
      tone: 'good',
      page: null,
      pageUnverified: false,
      known: true,
      note: null,
    },
  ],
  requirements: [
    {
      id: 'deliveryPlace',
      label: copy.fields.deliveryPlace,
      value: 'Aldeia São João, Terra Indígena Munduruku',
      tone: 'neutral',
      page: 5,
      pageUnverified: false,
      known: true,
      note: null,
    },
  ],
  blockers: [
    { id: 'blocker-0', text: 'Não há tratamento favorecido para ME/EPP.', page: 35, pageUnverified: false },
    { id: 'blocker-1', text: 'Atestado de perfuração em rocha cristalina.', page: 18, pageUnverified: true },
  ],
  citations: { citations: 8, verified: 8, rate: 1 },
  worthDeepDive: false,
}

const QUOTA: QuotaView = {
  feature: 'screening',
  plan: 'visitor',
  period: 'total',
  limit: 2,
  used: 1,
  left: 1,
}

const VISITOR: VisitorView = {
  expiresAt: '2026-09-24T12:00:00.000Z',
  expired: false,
  screeningsUsed: 1,
  screeningsLeft: 1,
}

/** A real search, so every outbound link in these views is asserted to carry it. */
const SEARCH = { cnpj: '51885242000140', state: 'SP', q: 'papel', group: 'check' } as const

function render(overrides: Partial<ScreeningViewProps> = {}): string {
  const props: ScreeningViewProps = {
    tenderId: TENDER.id,
    tender: TENDER,
    model: MODEL,
    quota: QUOTA,
    visitor: VISITOR,
    signedIn: false,
    status: { kind: 'ready' },
    backHref: `/radar/edital/${TENDER.id}`,
    search: SEARCH,
    now: new Date('2026-09-21T12:00:00.000Z'),
    // The real screen always has one; the states that offer a retry only offer
    // it when there is something to retry with.
    onRetry: () => {},
    ...overrides,
  }
  return renderToStaticMarkup(<ScreeningView {...props} />)
}

describe('quotaLabel', () => {
  it('counts a visitor’s two against the board’s "1 de 2 sem conta"', () => {
    expect(quotaLabel(QUOTA)).toBe('1 de 2 sem conta')
  })

  it('says "no mês" for a plan whose allowance resets', () => {
    expect(quotaLabel({ ...QUOTA, plan: 'basico', period: 'month', limit: 5, used: 3, left: 2 })).toBe(
      '3 de 5 no mês',
    )
  })

  it('says nothing at all when there is no limit to report', () => {
    expect(quotaLabel({ ...QUOTA, limit: null, left: null })).toBe(page.quota.unlimited)
    expect(quotaLabel(null)).toBeNull()
  })
})

describe('ScreeningView · a finished analysis', () => {
  const html = render()

  it('prints the page of every finding that cited one — the acceptance criterion', () => {
    expect(html).toContain('p.35')
    expect(html).toContain('p.17')
    expect(html).toContain(copy.fields.minimumCapital)
    expect(html).toContain('169.334,68')
  })

  it('prints an em dash where a finding cited no page, never a blank', () => {
    expect(html).toContain(page.noPage)
  })

  it('always carries the AI notice, word for word from the catalogue', () => {
    expect(html).toContain(messages.ai.disclaimer)
    expect(html).toContain(messages.ai.notLegalAdvice)
  })

  /**
   * **Inverted by D28.** It required the aggregate — *"8 de 8 páginas citadas
   * conferem"* — and that number is now gone.
   *
   * A reader who cannot tell *which* of the cited pages failed discounts all of
   * them, including the page the blocker depends on, so one disclosed ratio
   * cost trust in every citation rather than buying it in one. Nothing is
   * hidden by its removal: `pageUnverified` marks the failing row itself, in
   * colour, with a `*` and an `sr-only` explanation. Per-row failure is
   * actionable; the ratio was not.
   *
   * Inverted rather than deleted so the next person to reach for an aggregate
   * finds the reason it was taken out.
   */
  it('never states an aggregate citation rate', () => {
    expect(html).not.toMatch(/\d+ de \d+ páginas citadas/)
    // The per-row marker is what carries it now, and it still ships.
    expect(page.pageUnverified).toContain('não confere')
  })

  it('still says so when a reading cited no page at all', () => {
    // A different statement, and one the reader needs: "we cited nothing" is
    // not "some of what we cited did not check out".
    const out = render({ model: { ...MODEL, citations: { citations: 0, verified: 0, rate: 0 } } })
    expect(out).toContain(page.citationsNone)
    // …and the other half, which the first version of this test was missing:
    // inverting the condition left all 35 green, because nothing asserted the
    // sentence stays away when pages *were* cited.
    expect(html).not.toContain(page.citationsNone)
  })

  it('shows the score with its label, the verdict and the reason', () => {
    expect(html).toContain(page.verdict.hard)
    expect(html).toContain('Obra complexa de engenharia')
    expect(html).toContain('/10')
    // D28: the label shipped `sr-only`, so a sighted reader met a bare "4/10"
    // under a heading reading *Difícil* with nothing saying which end is good.
    expect(html).toContain(page.verdict.scoreLabel)
    expect(html).not.toContain(`sr-only"> ${page.verdict.scoreLabel}`)
  })

  it('offers the locked price block, canvas 05, as a real link', () => {
    expect(html).toContain(page.priceTitle)
    expect(html).toContain(`/radar/edital/${TENDER.id}/preco`)
  })

  it('locks the documents tab behind an account rather than hiding it', () => {
    expect(html).toContain(page.tabs.files)
    // See the note in price-view.test.tsx: the destination is R2's constant
    // while U1 is unbuilt, so the tab is locked behind a link that resolves.
    expect(html).toContain(ACCOUNT_HREF)
  })

  it('shows the allowance badge and the visitor banner', () => {
    expect(html).toContain('1 de 2 sem conta')
    expect(html).toContain(copy.visitor.label)
    expect(html).toContain(copy.visitor.createAccount)
  })
})

describe('ScreeningView · the requirements tab', () => {
  const html = render({ tab: 'requirements' })

  it('moves to the delivery, payment and product rows', () => {
    expect(html).toContain(copy.fields.deliveryPlace)
    expect(html).toContain('p.5')
  })

  it('lists each blocker with its page', () => {
    expect(html).toContain('Não há tratamento favorecido')
    expect(html).toContain('p.18')
  })

  it('says so when a cited page did not check out, instead of dropping it', () => {
    expect(html).toContain(page.pageUnverified)
  })

  it('says the good news out loud when there is no blocker', () => {
    const clean = render({ tab: 'requirements', model: { ...MODEL, blockers: [] } })
    expect(clean).toContain(page.noBlockers)
  })
})

describe('ScreeningView · every state has an answer', () => {
  it('analyzing: the spinner, with what is happening', () => {
    const html = render({ status: { kind: 'analyzing' }, model: null })
    expect(html).toContain(page.analyzingTitle)
    expect(html).toContain(messages.ai.analyzing)
    expect(html).toContain('aria-live="polite"')
  })

  it('timeout: a ceiling on the spinner, and a way to try again', () => {
    const html = render({ status: { kind: 'timeout' }, model: null })
    expect(html).toContain(page.timeoutTitle)
    expect(html).toContain(copy.states.timeoutAction)
  })

  it('timeout without a retry still points back at the tender', () => {
    const html = render({ status: { kind: 'timeout' }, model: null, onRetry: undefined })
    expect(html).toContain(page.openTender)
  })

  it('failed: says we could not read it, not that it is still loading', () => {
    const html = render({ status: { kind: 'failed' }, model: null })
    expect(html).toContain(page.failedTitle)
    expect(html).not.toContain(page.analyzingTitle)
  })

  it('no_text: a scanned PDF is an answer, and nothing was charged', () => {
    const html = render({ status: { kind: 'noText' }, model: null })
    expect(html).toContain(page.noTextTitle)
    expect(html).toContain('Nada foi cobrado')
  })

  it('quota: the visitor’s two are gone, so the way out is an account', () => {
    const html = render({ status: { kind: 'quota' }, model: null })
    expect(html).toContain(page.quotaTitle)
    expect(html).toContain('Sem conta são 2 triagens')
    expect(html).toContain(copy.visitor.createAccount)
  })

  it('quota: a monthly plan is told when the allowance comes back', () => {
    const html = render({
      status: { kind: 'quota' },
      model: null,
      quota: { ...QUOTA, plan: 'basico', period: 'month', limit: 5, used: 5, left: 0 },
    })
    expect(html).toContain('as 5 triagens do período')
  })

  it('not found: the id is not one we hold', () => {
    const html = render({ status: { kind: 'notFound' }, model: null, tender: null })
    expect(html).toContain(copy.opportunity.notFoundTitle)
  })

  it('error: the route’s own sentence, with a retry', () => {
    const html = render({
      status: { kind: 'error', code: 'server_error', text: messages.errors.pncpDown },
      model: null,
    })
    expect(html).toContain(messages.errors.pncpDown)
  })

  it('a ready row we could not parse is a failure, not an empty screen', () => {
    const html = render({ status: { kind: 'ready' }, model: null })
    expect(html).toContain(page.failedTitle)
  })

  it('keeps the way back on screen in every one of them', () => {
    for (const status of [
      { kind: 'analyzing' },
      { kind: 'timeout' },
      { kind: 'failed' },
      { kind: 'noText' },
      { kind: 'quota' },
    ] as const) {
      expect(render({ status, model: null })).toContain(`href="/radar/edital/${TENDER.id}"`)
    }
  })
})

/**
 * Every address that leaves canvas 04. All three were bare, so a visitor who
 * pressed Documentos, or the price block, or "Criar conta" came back to a
 * Radar with no CNPJ and no tab — the search gone, exactly as on the screen
 * before this one.
 */
describe('the links out of this screen carry the search', () => {
  const SEARCH_QUERY = 'cnpj=51885242000140&amp;uf=SP&amp;q=papel&amp;group=check'

  it('sends the price block the search', () => {
    expect(render()).toContain(`/radar/edital/${TENDER.id}/preco?${SEARCH_QUERY}`)
  })

  it('does not send the reader anywhere for Documentos — it is a panel (D31)', () => {
    // The inverse of what this asserted until D31, and the inversion is the
    // point: the tab carried an href, so opening it navigated to the tender
    // page and landed at the top of it. Nothing on this screen may link there
    // for the annexes any more.
    expect(render()).not.toContain('tab=files')
  })

  it('comes back to this same triagem after creating an account', () => {
    const html = render({ status: { kind: 'quota' } })
    expect(html).toContain(
      encodeURIComponent(`/radar/edital/${TENDER.id}/triagem?cnpj=51885242000140`),
    )
  })

  it('never links to a bare preço', () => {
    expect(render()).not.toContain(`href="/radar/edital/${TENDER.id}/preco"`)
  })
})

describe('the Documentos tab, and who it is locked for', () => {
  /**
   * **A paying subscriber met a padlock for files they could open one screen
   * back.** The tab was an unconditional `accountHref(...)` with a lock icon,
   * written to §8's rule — *"files only with an account"* — and applied to
   * people who have one. Clicking it bounced an Essencial subscriber to
   * `/conta`. Sci found it on his own account, 2026-09-29.
   *
   * **All thirty tests in this file passed**, because none of them rendered
   * this view as somebody signed in — there was no way to say it. The prop
   * exists now partly so the state can be tested at all.
   *
   * The other half of the bug was quieter: the link went to the tender page,
   * which opens on **Itens**. A reader clicked Documentos and got something
   * else, which is barely better than the padlock. `?tab=files` fixes that.
   */
  const ANNEX = {
    sequence: 1,
    title: 'Anexo I — Termo de Referência',
    docType: 'Anexo',
    url: 'https://pncp.gov.br/anexo-1.pdf',
    publishedAt: null,
    pages: 12,
    noText: false,
  }

  it('shows a visitor the locked block **in place**, instead of bouncing them', () => {
    const out = render({ signedIn: false, tab: 'files', tender: { ...TENDER, files: null } })
    expect(out).toContain(opportunity.filesLocked)
    // The bounce is what Sci met, and it is what this test now forbids.
    expect(out).not.toContain('tab=files')
  })

  it('does not lock it for an account', () => {
    const out = render({ signedIn: true })
    expect(out).not.toContain(accountHref(tenderHref(TENDER.id, SEARCH)))
  })

  it('renders the annexes on this screen for an account, with no navigation', () => {
    const out = render({ signedIn: true, tab: 'files', tender: { ...TENDER, files: [ANNEX] } })
    expect(out).toContain(ANNEX.title)
    expect(out).toContain(ANNEX.url)
    expect(out).not.toContain('tab=files')
  })

  it('says so when the agency published nothing, rather than showing an empty panel', () => {
    const out = render({ signedIn: true, tab: 'files', tender: { ...TENDER, files: [] } })
    expect(out).toContain(opportunity.files.emptyTitle)
  })
})

/**
 * D25 (3) — the action bar on the triagem screen.
 *
 * The funnel's next step from a finished reading is the price question, and
 * below `lg` the only other way off this screen was the AppBar's "Voltar" — a
 * browser-history word, not a destination. The bar names where it goes.
 *
 * Widths and clipping are `e2e/journeys/tender-action-bar.spec.ts`;
 * `environment: 'node'` has no layout (CLAUDE.md §4c).
 */
describe('the action bar', () => {
  function bar(html: string): string | null {
    const at = html.indexOf('sticky bottom-0')
    return at === -1 ? null : html.slice(html.lastIndexOf('<div', at))
  }

  it('offers the price question once the reading is on screen', () => {
    const block = bar(render())
    expect(block).not.toBeNull()
    expect(block).toContain(messages.radar.screening.barPrice)
    expect(block).toContain(priceHref(TENDER.id, SEARCH).replaceAll('&', '&amp;'))
    // The way back names the place, not the gesture.
    expect(block).toContain(messages.common.tender)
    // Drawn at every width now: a sticky bar is laid out by the column, so
    // the rail it used to hide from is no longer its problem.
    expect(block).not.toContain('lg:hidden')
    expect(block).toContain('z-40')
  })

  it('offers nothing while the reading is still being made', () => {
    // A bar proposing the next step under "Lendo o edital…" would be offering
    // it before this step has finished.
    expect(bar(render({ status: { kind: 'analyzing' }, model: null }))).toBeNull()
  })

  it('takes its room from the flow, after `main`', () => {
    // `sticky` reserves its own height whatever it turns out to be; the
    // `fixed` version needed a padding constant, and no constant covered the
    // 69px–144px the bar actually measures across widths and labels.
    const html = render()
    expect(bar(html)).toContain('sticky')
    expect(html.indexOf('sticky bottom-0')).toBeGreaterThan(html.indexOf('</main>'))
  })
})
