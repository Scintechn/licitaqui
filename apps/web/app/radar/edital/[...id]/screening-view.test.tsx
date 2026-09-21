import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ACCOUNT_HREF } from '@/lib/routes'
import { messages } from '@/lib/messages'
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
      note: null,
    },
    {
      id: 'minimumCapital',
      label: copy.fields.minimumCapital,
      value: 'R$ 169.334,68',
      tone: 'attention',
      page: 17,
      pageUnverified: false,
      note: 'Patrimônio líquido mínimo de 10% do valor total estimado.',
    },
    {
      id: 'sample',
      label: copy.fields.sample,
      value: copy.values.notRequired,
      tone: 'good',
      page: null,
      pageUnverified: false,
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

function render(overrides: Partial<ScreeningViewProps> = {}): string {
  const props: ScreeningViewProps = {
    tenderId: TENDER.id,
    tender: TENDER,
    model: MODEL,
    quota: QUOTA,
    visitor: VISITOR,
    status: { kind: 'ready' },
    backHref: `/radar/edital/${TENDER.id}`,
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

  it('reports how many of the cited pages the worker could confirm', () => {
    expect(html).toContain('8 de 8 páginas citadas conferem')
  })

  it('shows the score, the verdict and the reason', () => {
    expect(html).toContain(page.verdict.hard)
    expect(html).toContain('Obra complexa de engenharia')
    expect(html).toContain('/10')
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
