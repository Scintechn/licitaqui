import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { messages } from '@/lib/messages'

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
 */
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
