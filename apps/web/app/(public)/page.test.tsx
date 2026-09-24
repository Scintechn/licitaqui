import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { format, messages } from '@/lib/messages'
import { FOUNDER_SEATS } from '@/lib/founders/seats'
import { deadlineShort } from '@/lib/radar/format'
import { EXAMPLE_AS_OF, EXAMPLE_TENDERS, exampleCounts } from '@/lib/radar/landing-example'
import { mayShowUrgency } from '@/lib/radar/tender-status'

// The search card calls `useRouter()` for the client-side hop to the Radar,
// and there is no app router mounted under `react-dom/server`. The assertions
// below are all about the markup — including the no-JavaScript fallback, which
// is the real `<form method="get" action="/radar">` and not this stub.
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }))

const { default: LandingPage, revalidate } = await import('./page')

/**
 * The Landing, canvas 01.
 *
 * Rendered with no `DATABASE_URL`, which is also how `next build` runs it: the
 * "Hoje no Brasil" strip is then left out rather than printing zeroes, and
 * every other block still renders.
 *
 * `RENDERED_AT` is the instant it was rendered at. The example panel's deadline
 * line is drawn against the real clock, so the one assertion below that reads it
 * has to compare against the same clock the render used — not against a
 * constant, which is the defect card D11 was about.
 */
const RENDERED_AT = new Date()
const out = renderToStaticMarkup(await LandingPage())
const copy = messages.radar.landing

describe('/', () => {
  it('has exactly one h1, and it is the approved headline', () => {
    expect(out.match(/<h1/g)).toHaveLength(1)
    expect(out).toContain(copy.title)
  })

  it('keeps the landmarks a screen reader navigates by', () => {
    expect(out).toContain('<header')
    expect(out).toContain('<main id="inicio"')
    expect(out).toContain(messages.radar.nav.skip)
  })

  it('carries the board’s copy, none of it hardcoded in the component', () => {
    expect(out).toContain(copy.subtitle)
    expect(out).toContain(copy.cnpjLabel)
    expect(out).toContain(copy.ufLabel)
    expect(out).toContain(copy.keywordLabel)
    expect(out).toContain(copy.submit)
    expect(out).toContain(copy.trial)
    expect(out).toContain(copy.sources)
  })

  it('labels every control, and ties each label to its field', () => {
    for (const id of ['cnpj', 'uf', 'q']) {
      expect(out).toContain(`for="${id}"`)
      expect(out).toContain(`id="${id}"`)
    }
    // Rendered once, not twice behind `hidden`: two `id="cnpj"` inputs would
    // break every label on the page.
    expect(out.match(/id="cnpj"/g)).toHaveLength(1)
  })

  it('renders every input at 16px, so iOS Safari does not zoom on focus', () => {
    for (const id of ['cnpj', 'q']) {
      expect(out.match(new RegExp(`<input[^>]*id="${id}"[^>]*text-base`))).not.toBeNull()
    }
    expect(out.match(/<select[^>]*id="uf"[^>]*text-base/)).not.toBeNull()
  })

  it('offers all 27 states plus "Todo o Brasil"', () => {
    const options = out.match(/<option/g) ?? []
    expect(options).toHaveLength(28)
    expect(out).toContain(messages.radar.ufAll)
    expect(out).toContain('São Paulo (SP)')
  })

  it('works without JavaScript: a real GET form aimed at the Radar', () => {
    expect(out).toMatch(/<form[^>]*method="get"/)
    expect(out).toMatch(/<form[^>]*action="\/radar"/)
    for (const name of ['cnpj', 'uf', 'q']) {
      expect(out).toContain(`name="${name}"`)
    }
  })

  it('leaves the "Hoje no Brasil" strip out when there is no count to show', () => {
    expect(out).not.toContain(copy.todayLabel)
  })

  it('points at the founders offer page', () => {
    expect(out).toContain('href="/fundadores"')
    expect(out).toContain(copy.founders)
  })

  it('revalidates inside the 10–30 min window of spec §3.3', () => {
    expect(revalidate).toBeGreaterThanOrEqual(600)
    expect(revalidate).toBeLessThanOrEqual(1800)
  })
})

/**
 * The rest of `paginas/landing_radar.html`, which the page stopped short of.
 * Each block below is one the approved document has and the shipped page did
 * not.
 */
describe('/ · the approved page, section by section', () => {
  it('opens on the founders strip, above the header', () => {
    expect(out).toContain(copy.founderStrip.label)
    expect(out).toContain(format(copy.founderStrip.offer, { preco: messages.plans.promo.price }))
    expect(out).toContain(copy.founderStrip.cta)
    expect(out.indexOf(copy.founderStrip.label)).toBeLessThan(out.indexOf('<header'))
  })

  /**
   * The one assertion on this page that is about honesty rather than layout.
   * With no database — which is how `next build` and this test run — the strip
   * must say how many seats the offer has and nothing about how many are left.
   */
  it('never invents a remaining seat count when it cannot read one', () => {
    expect(out).toContain(format(copy.founderStrip.seatsUnknown, { total: FOUNDER_SEATS }))
    expect(out).not.toContain('restam')
    expect(out).not.toContain('[N]')
  })

  it('carries the nav, and every anchor in it lands on a section that exists', () => {
    for (const [label, anchor] of [
      [copy.nav.howItWorks, 'como-funciona'],
      [copy.nav.plans, 'planos'],
      [copy.nav.faq, 'perguntas'],
    ] as const) {
      expect(out).toContain(label)
      expect(out).toContain(`href="#${anchor}"`)
      expect(out).toContain(`id="${anchor}"`)
    }
    expect(out).toContain(copy.nav.signIn)
  })

  it('shows the example Radar panel, with the three real tenders', () => {
    expect(out).toContain(copy.example.label)
    expect(out).toContain(copy.example.panelLabel)
    for (const tender of EXAMPLE_TENDERS) {
      expect(out).toContain(tender.object)
      expect(out).toContain(tender.agencyName)
    }
  })

  it('draws the example with the product’s own badges and tags', () => {
    const list = messages.radar.list
    for (const badge of [list.badges.compatible, list.badges.check, list.badges.keyword]) {
      expect(out).toContain(badge)
    }
    expect(out).toContain(messages.radar.tags.exclusive)
    expect(out).toContain(messages.radar.tags.mixed)
    expect(out).toContain(messages.radar.tags.favored)
  })

  it('counts the example’s own tabs instead of quoting a number', () => {
    const counts = exampleCounts()
    expect(counts).toEqual({ compatible: 1, check: 1, keyword: 1 })
    for (const group of ['compatible', 'check', 'keyword'] as const) {
      expect(out).toContain(messages.radar.list.groups[group])
    }
  })

  /**
   * The example is three tenders transcribed on a fixed date, so: it says so,
   * it is dated, and none of its cards is a link to a tender page that would
   * 404 or show something else entirely.
   *
   * What it no longer does is freeze the countdown at that date. This used to
   * assert "13 dias" — the board's number, measured from 17/09/2026 — which is
   * the claim card D11 is about: from 01/10/2026 that is a live-looking
   * countdown over a deadline that has passed. The deadline line is now
   * whatever is true at render time, and `example-radar.test.tsx` moves the
   * clock across it. Here the page only has to agree with the card's own rule
   * (§2.2 rule 6) at the instant this file rendered it.
   */
  it('keeps the example visibly an example', () => {
    expect(out).toContain(format(copy.example.caption, { data: EXAMPLE_AS_OF }))
    expect(out).toContain(EXAMPLE_AS_OF)
    expect(out).not.toContain('/radar/edital/')

    for (const tender of EXAMPLE_TENDERS) {
      const quando = deadlineShort(tender.proposalsCloseAt) ?? ''
      const open = mayShowUrgency(tender, RENDERED_AT)
      expect(out).toContain(
        format(open ? messages.radar.card.proposalsUntil : messages.radar.card.previousDeadline, {
          quando,
        }),
      )
      expect(out).not.toContain(
        format(open ? messages.radar.card.previousDeadline : messages.radar.card.proposalsUntil, {
          quando,
        }),
      )
    }
  })

  it('explains how it works, with the three Radar groups as the legend', () => {
    expect(out).toContain(copy.how.title)
    for (const step of copy.how.steps) {
      expect(out).toContain(step.eyebrow)
      expect(out).toContain(step.title)
    }
    for (const hint of Object.values(messages.radar.list.groupHint)) {
      expect(out).toContain(hint)
    }
  })

  it('opens one real tender, dated, with the price band still locked', () => {
    const { opportunity } = copy
    expect(out).toContain(opportunity.title)
    expect(out).toContain(opportunity.cardLabel)
    expect(out).toContain(opportunity.tender)
    for (const row of opportunity.rows) {
      expect(out).toContain(row.label)
      expect(out).toContain(row.page)
    }
    expect(out).toContain(opportunity.lockedTitle)
    expect(out).toContain(messages.plans.locked.priceBand)
    expect(out).toContain(format(opportunity.source, { data: EXAMPLE_AS_OF }))
    // An AI score on the page means the disclaimer is on the page too (§7.2).
    expect(out).toContain(messages.ai.disclaimer)
  })

  it('shows the Telegram alert example', () => {
    expect(out).toContain(copy.alerts.title)
    expect(out).toContain(copy.alerts.messageLabel)
    for (const item of copy.alerts.items) expect(out).toContain(item.text)
  })

  it('prices the three plans from the catalogue, never from a literal', () => {
    expect(out).toContain(messages.plans.basic.price)
    expect(out).toContain(messages.plans.essential.price)
    expect(out).toContain(messages.plans.promo.price)
    expect(out).toContain(messages.plans.pro.price)
    expect(out).toContain(messages.plans.promo.priceChangeNote)
    expect(out).toContain(messages.plans.essential.feature4)
    expect(out).toContain(copy.plans.proSoon)
    expect(out).toContain('href="/fundadores"')
  })

  it('lists the guarantees and the questions', () => {
    for (const guarantee of copy.guarantees) expect(out).toContain(guarantee.title)
    for (const column of copy.faq.columns) {
      for (const item of column) expect(out).toContain(item.q)
    }
    expect(out.match(/<details/g)).toHaveLength(6)
  })

  it('closes on the footer, pointing at the legal pages', () => {
    expect(out).toContain(messages.foundersPage.footer.company)
    expect(out).toContain('href="/privacidade"')
    expect(out).toContain('href="/termos"')
  })

  it('drops the knowledge base’s "Prévia" banner', () => {
    expect(out).not.toContain('Prévia')
    expect(out).not.toContain('PRÉVIA')
  })
})
