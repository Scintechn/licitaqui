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

  it('draws no seat grid until a seat is actually taken', () => {
    // The page is statically rendered, so the live count is never in this
    // HTML — which is exactly why the grid used to be forty-eight visibly
    // empty boxes under "Restam 48 vagas", for every visitor, on the page
    // founders week points at. Scarcity framing only works above zero.
    expect(out).not.toContain('aspect-square')
    // The claim itself stays: it is true at 0 and at 48.
    expect(out).toContain(messages.foundersPage.signup.seatsLabel)
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

describe('the refunds section', () => {
  /**
   * Until 2026-09-21 a sweep of the whole catalogue for
   * `devolv|reembols|garantia|arrepend|estorno` returned **nothing**, while both
   * refunds were already contractual under terms §8 and `faq-cobranca.md`'s own
   * placement table said the Offer must carry them. These assertions are what
   * keeps them from disappearing again.
   */
  it('states both refunds, verbatim from the billing FAQ', () => {
    const { refunds } = messages.foundersPage
    expect(out).toContain(refunds.title)
    // The distinguishing clause of each, so a paraphrase fails here.
    expect(out).toContain('direito de arrependimento do Código de Defesa do Consumidor')
    expect(out).toContain('uma vez por CNPJ')
    expect(out).toContain('Promocional e Essencial')
  })

  it('says the guarantee next to the price, not only in the small print', () => {
    expect(out).toContain(messages.foundersPage.refunds.ctaLine)
  })

  it('does not promise a proportional refund it never offered', () => {
    expect(out).toContain('não há devolução proporcional')
  })
})

describe('the competitor comparison', () => {
  it('records when its claims were last verified', () => {
    // Comparative advertising has to stay true without anyone touching the
    // code: a competitor can change terms and make this false on its own.
    const meta = messages.foundersPage.founderValue._meta
    expect(meta.verifiedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('brief §2.2 framing rules', () => {
  /**
   * Rules 1-3 of the product-framing section, which exists because there is no
   * budget for legal review before the first charge. Under CDC art. 30 the copy
   * *is* the obligation, so these are not style preferences — they are the
   * mitigation, and a regression here is a legal one.
   */
  it('never claims the reader can participate or is eligible (rule 2)', () => {
    expect(out).not.toContain('pode participar')
    expect(out).not.toMatch(/está habilitad|sua empresa está apta/i)
  })

  it('describes past winners, never a tendency about the next bid (rule 1)', () => {
    // "costuma vencer" puts the tendency on the reader's own bid; the winners
    // closing at a price is a fact about results that already happened.
    expect(out).not.toContain('costuma vencer')
  })

  it('never promises an outcome (rule 1)', () => {
    expect(out).not.toMatch(/\bvença\b|ganhe licitaç|aumente suas chances|\baprovado\b/i)
  })

  it('never leaves "preço-alvo" without saying what it is (rule 3)', () => {
    // A MEI reading "preço-alvo" beside an edital will assume it is the bid.
    const at = out.indexOf('preço-alvo')
    if (at !== -1) {
      expect(out.slice(at, at + 220)).toMatch(/máximo a pagar ao fornecedor/)
    }
  })

  it('gives the refund guarantees a section heading, not fine print', () => {
    // It was `text-lead font-semibold` — 15px IBM Plex Sans — while the other
    // eight h2s are 26px Archivo 700, so the 7-day CDC right of withdrawal and
    // the 30-day guarantee rendered *smaller than the body copy around them*,
    // directly above a FAQ with full display treatment.
    const heading = out.indexOf(messages.foundersPage.refunds.title)
    expect(heading).toBeGreaterThan(-1)
    // The display face and size the other sections get.
    const around = out.slice(Math.max(0, heading - 300), heading)
    expect(around).toContain('font-display')
    expect(around).not.toContain('text-lead font-semibold')
  })

  it('keeps the comparison table wide enough to be a table', () => {
    // `overflow-x-auto` was inert while the table was `w-full`: measured at
    // 390px, clientWidth 310 and scrollWidth 310, so nothing ever scrolled
    // and the columns compressed to 91/104/115px.
    expect(out).toContain('min-w-[420px]')
  })

  it('keeps a way to act on screen through the long middle of the page', () => {
    // Between the form's submit and the next CTA there are ~5 499px.
    expect(out).toMatch(/<header class="[^"]*sticky/)
  })

  /**
   * `tokens.css` says it in its own words, above the public-page scale:
   *
   *   "The 11–15px scale above is the in-app scale, designed for a 390px
   *    frame full of data. A marketing page needs larger… **Body copy there
   *    is Tailwind's `text-base`**."
   *
   * The page did not follow the instruction written for it. Measured at a
   * true 390px viewport before the change: 31% of the page's characters were
   * at 13px or smaller and 44% at 15px, with only 10% at 16px — for readers
   * who are often in their fifties and sixties, on low-end Android, deciding
   * whether to trust an unknown company with a business subscription.
   *
   * This asserts the idiom rather than every element: the body-copy blocks
   * use `text-base`, and none of them is left on the in-app `text-lead`.
   */
  it('sets body copy at the size the token file specifies for public pages', () => {
    const bodyBlocks = out.match(/text-base leading-\[1\.6\]/g) ?? []
    expect(bodyBlocks.length).toBeGreaterThanOrEqual(8)
    // The in-app body idiom must not come back on a marketing page.
    expect(out).not.toContain('text-lead leading-[1.55]')
  })
})
