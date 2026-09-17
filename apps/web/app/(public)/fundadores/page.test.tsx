import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messages } from '@/lib/messages'
import FoundersOfferPage, { revalidate } from './page'

const out = renderToStaticMarkup(<FoundersOfferPage />)

describe('/fundadores', () => {
  it('drops the "Prévia" banner the source page carried', () => {
    expect(out).not.toContain('Prévia')
    expect(out).not.toContain('O formulário ainda não envia dados')
  })

  it('has exactly one h1, and it is the approved headline', () => {
    expect(out.match(/<h1/g)).toHaveLength(1)
    expect(out).toContain(messages.foundersPage.hero.title)
  })

  it('keeps the landmarks a screen reader navigates by', () => {
    expect(out).toContain('<header')
    expect(out).toContain('<main id="topo"')
    expect(out).toContain('<footer')
  })

  it('quotes the prices of spec §10 and nothing else', () => {
    expect(out).toContain('R$ 26')
    expect(out).toContain('R$ 57')
    expect(out).toContain('por mês nos 6 primeiros meses')
  })

  it('draws all 48 founder seats', () => {
    expect(out.match(/aspect-square/g)).toHaveLength(48)
  })

  it('labels every form control', () => {
    for (const id of ['nome', 'email', 'whatsapp', 'vende', 'aceite']) {
      expect(out).toContain(`for="${id}"`)
      expect(out).toContain(`id="${id}"`)
    }
  })

  it('does not point the form at an endpoint task F1 has not built', () => {
    expect(out).not.toContain('/api/founders')
    expect(out).not.toMatch(/<form[^>]*\saction=/)
  })

  it('revalidates inside the 10–30 min window of spec §3.3', () => {
    expect(revalidate).toBeGreaterThanOrEqual(600)
    expect(revalidate).toBeLessThanOrEqual(1800)
  })

  it('renders no product copy that is not in the pt-BR catalogue', () => {
    // A spot check on the strings most likely to be hardcoded by accident.
    expect(out).toContain(messages.founders.offer.cta)
    expect(out).toContain(messages.brand.promise)
    expect(out).toContain(messages.legal.privacyLabel)
  })
})
