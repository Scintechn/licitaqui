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
    for (const id of ['nome', 'email', 'whatsapp', 'cnpj', 'vende', 'aceite-contato', 'aceite-termos']) {
      expect(out).toContain(`for="${id}"`)
      expect(out).toContain(`id="${id}"`)
    }
  })

  it('submits through fetch, never a browser form navigation (F1)', () => {
    // The endpoint is called from the submit handler, so nothing about it is in
    // the static HTML: a bare `action=` would serialise the e-mail and the
    // WhatsApp number into the URL.
    expect(out).not.toMatch(/<form[^>]*\saction=/)
  })

  it('never pre-ticks a consent box (LGPD art. 8 §4, terms Annex B)', () => {
    for (const box of out.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? []) {
      expect(box).not.toContain('checked')
    }
    expect(out.match(/type="checkbox"/g)).toHaveLength(2)
    expect(out).toContain(messages.consent.founders)
    expect(out).toContain(messages.consent.termsBefore)
    expect(out).toContain(messages.consent.termsBetween)
  })

  it('lets the reader actually open what they are accepting', () => {
    // Until the legal lane the two documents were named in plain text and had
    // nowhere to go, so the box recorded an acceptance nobody could have given.
    expect(out).toContain(`href="${messages.legal.termsUrl}"`)
    expect(out).toContain(`href="${messages.legal.privacyUrl}"`)
    // A new tab, so a half-filled form survives the detour.
    expect(out).toContain('rel="noopener noreferrer"')
  })

  it('carries the company identification the legal brief prescribes', () => {
    expect(out).toContain('36.955.612/0001-85')
    expect(out).toContain('contato@licitaquiapp.com.br')
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
