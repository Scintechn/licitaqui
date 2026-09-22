import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messages } from '@/lib/messages'
import type { TenderDetail } from '@/lib/radar/contract'
import {
  HUPE_DIVULGADA,
  HUPE_NOW,
  HUPE_SUSPENDED,
  HUPE_SITUACAO_ID,
} from '@/lib/radar/hupe.fixture'
import { TenderCardView } from '../../tender-card'
import { OpportunityView } from './opportunity-view'
import { PriceView } from './price-view'

/**
 * The defect of 2026-09-22, asserted against the tender it happened on.
 *
 * `TENDER_STATUS_AND_WATCH.md` §1 lists what the live screen rendered above a
 * tenth row reading "Situação: Suspensa". Every one of those four things gets
 * a test here, on the real payload, plus the control that proves the gate did
 * not simply switch urgency off for everybody.
 */

const copy = messages.radar

function opportunity(tender: TenderDetail): string {
  return renderToStaticMarkup(
    <OpportunityView
      tender={tender}
      freshness={{ state: 'fresh', updatedAt: '2026-09-22T10:30:00.000Z', ageSeconds: 1_800 }}
      status={{ kind: 'ready' }}
      backHref="/radar"
      now={HUPE_NOW}
    />,
  )
}

describe('the HUPE-RJ tender is suspended and the fixture says so', () => {
  it('is the one from the evidence: Suspensa, id 4, deadline still open', () => {
    expect(HUPE_SUSPENDED.status).toBe('Suspensa')
    expect(HUPE_SITUACAO_ID).toBe(4)
    expect(HUPE_SUSPENDED.unitName).toContain('PEDRO ERNESTO')
    // The condition that made the defect visible: the clock had not run out,
    // so there really was a countdown to print.
    expect(new Date(HUPE_SUSPENDED.proposalsCloseAt!).getTime()).toBeGreaterThan(
      HUPE_NOW.getTime(),
    )
  })
})

describe('Opportunity · a suspended tender shows no urgency', () => {
  const html = opportunity(HUPE_SUSPENDED)

  it('does not say "último dia"', () => {
    expect(html).not.toContain('último dia')
  })

  it('does not say "restantes"', () => {
    expect(html).not.toContain(copy.opportunity.remaining)
  })

  it('does not say "Ainda dá tempo"', () => {
    expect(html).not.toContain('Ainda dá tempo')
  })

  it('prints no countdown of any length', () => {
    expect(html).not.toMatch(/\d+\s+dias?\b/)
  })

  it('banners the suspension above the title, with the agency’s date', () => {
    expect(html).toContain('Edital SUSPENSO pelo órgão em 21/09/2026')
    expect(html.indexOf('Edital SUSPENSO')).toBeLessThan(html.indexOf('<h1'))
  })

  it('never calls the suspension a cancellation', () => {
    expect(html).not.toMatch(/cancelad/i)
  })

  it('keeps the date, relabelled, instead of hiding it', () => {
    // §3.2: "keeping the original date visible but muted and labelled as the
    // previous date". A user tracking this tender needs to know which date it
    // was that stopped applying.
    expect(html).toContain('Prazo suspenso')
    expect(html).toContain(copy.status.previousDeadline)
    expect(html).toContain('22 SET')
    expect(html).not.toContain(copy.opportunity.proposalsUntil)
  })

  it('shows the status chip beside the compatibility badge', () => {
    expect(html).toContain(copy.list.badges.compatible)
    expect(html).toContain('Suspensa')
  })

  it('still shows the tender: suppressing urgency is not hiding it', () => {
    expect(html).toContain('Kaspersky')
    expect(html).toContain('HOSPITAL UNIVERSITARIO PEDRO ERNESTO')
  })
})

describe('Opportunity · the Divulgada control is unchanged', () => {
  const html = opportunity(HUPE_DIVULGADA)

  it('still counts down', () => {
    expect(html).toContain('último dia')
    expect(html).toContain(copy.opportunity.remaining)
  })

  it('still says "Ainda dá tempo" in the why-list', () => {
    expect(html).toContain('Ainda dá tempo')
  })

  it('still labels the deadline "Proposta até" and banners nothing', () => {
    expect(html).toContain(copy.opportunity.proposalsUntil)
    expect(html).not.toContain('Prazo suspenso')
    expect(html).not.toContain('pelo órgão em')
  })
})

describe('Radar card · the list item obeys the same gate', () => {
  const suspended = renderToStaticMarkup(
    <TenderCardView tender={HUPE_SUSPENDED} now={HUPE_NOW} />,
  )
  const control = renderToStaticMarkup(
    <TenderCardView tender={HUPE_DIVULGADA} now={HUPE_NOW} />,
  )

  it('drops the countdown from the card', () => {
    expect(suspended).not.toContain('último dia')
    expect(control).toContain('último dia')
  })

  it('does not promote the deadline into the 22px anchor slot', () => {
    // This tender has no estimated value, so the deadline would otherwise win
    // the biggest slot on the card — the loudest place the defect could live.
    expect(suspended).not.toMatch(/text-\[22px\][^>]*>\s*último dia/)
  })

  it('relabels the date line rather than dropping it', () => {
    expect(suspended).toContain('Data anterior')
    expect(control).toContain('Proposta até')
  })

  it('carries the status chip, so the state is visible before opening it', () => {
    expect(suspended).toContain('Suspensa')
    expect(control).not.toContain('Suspensa')
  })
})

describe('AI result screens carry the same banner (§3.5)', () => {
  it('the price screen banners a suspended tender', () => {
    const html = renderToStaticMarkup(
      <PriceView
        tenderId={HUPE_SUSPENDED.id}
        tender={HUPE_SUSPENDED}
        item={1}
        status={{ kind: 'ready' }}
        backHref="/radar"
      />,
    )
    expect(html).toContain('Edital SUSPENSO pelo órgão')
    // Pricing a suspended edital is still useful — the screen still does its
    // job under the banner rather than refusing to render.
    expect(html).toContain('SUBSCRICAO DE LICENCA')
  })

  it('the price screen banners nothing on the control', () => {
    const html = renderToStaticMarkup(
      <PriceView
        tenderId={HUPE_DIVULGADA.id}
        tender={HUPE_DIVULGADA}
        item={1}
        status={{ kind: 'ready' }}
        backHref="/radar"
      />,
    )
    expect(html).not.toContain('pelo órgão em')
  })
})
