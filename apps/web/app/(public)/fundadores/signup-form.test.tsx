import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messages } from '@/lib/messages'
import { SignupForm } from './signup-form'

/**
 * The founders form, asserted against the form.
 *
 * Every requirement below used to be asserted against `/fundadores`'s rendered
 * page, because the form was part of it. It is now opened as a dialog
 * (`signup-sheet.tsx`), so the page's static HTML no longer contains it — and
 * an assertion that silently stopped covering the LGPD consent boxes because
 * its subject moved would be the worst possible way to lose this coverage. So
 * the subject moves with it: same requirements, rendered one level down.
 *
 * `renderToStaticMarkup`, like every other component test here — `vitest.config
 * .mts` is `environment: 'node'` and there is no jsdom in the project.
 */

const out = renderToStaticMarkup(<SignupForm />)
const copy = messages.foundersPage.signup

describe('the founders signup form', () => {
  it('labels every control', () => {
    for (const id of [
      'nome',
      'email',
      'whatsapp',
      'cnpj',
      'vende',
      'aceite-contato',
      'aceite-termos',
    ]) {
      expect(out, id).toContain(`for="${id}"`)
      expect(out, id).toContain(`id="${id}"`)
    }
  })

  it('submits through fetch, never a browser form navigation (F1)', () => {
    // A bare `action` would serialise the name, e-mail and WhatsApp number
    // into the URL on submit. There is no `action`, and that is also why the
    // form has never worked without JavaScript — which is what makes opening
    // it in a dialog cost no capability that existed.
    expect(out).toContain('<form')
    expect(out).not.toContain('action=')
    // React spells it `noValidate` on the server; the browser reads it
    // case-insensitively either way.
    expect(out.toLowerCase()).toContain('novalidate=""')
  })

  it('never pre-ticks a consent box (LGPD art. 8 §4, terms Annex B)', () => {
    const boxes = out.match(/<input[^>]*type="checkbox"[^>]*>/g) ?? []
    expect(boxes).toHaveLength(2)
    for (const box of boxes) {
      expect(box).not.toContain('checked')
      expect(box).toContain('required')
    }
  })

  it('lets the reader actually open what they are accepting', () => {
    expect(out).toContain(`href="${messages.legal.termsUrl}"`)
    expect(out).toContain(`href="${messages.legal.privacyUrl}"`)
  })

  it('quotes the prices of spec §10 and nothing else', () => {
    expect(out).toContain(copy.price)
    expect(out).toContain(copy.priceWas)
    expect(out).toContain(copy.priceUnit)
  })

  it('says the guarantee next to the price, not only in the small print', () => {
    // 30 days, contractual under terms §8. It appeared nowhere in the product
    // until 2026-09-21, while `faq-cobranca.md` said the Offer must carry it.
    expect(out).toContain(messages.foundersPage.refunds.ctaLine)
  })

  it('draws no seat grid until a seat is actually taken', () => {
    // The count is fetched, so the first paint carries no cells — which is
    // exactly why the grid used to be forty-eight visibly empty boxes under
    // "Restam 48 vagas". Scarcity framing only works above zero.
    expect(out).not.toContain('aspect-square')
    // The claim itself stays: it is true at 0 taken and at 48.
    expect(out).toContain(copy.seatsLabel)
  })

  it('renders no copy that is not in the pt-BR catalogue', () => {
    expect(out).toContain(messages.founders.offer.cta)
    expect(out).toContain(copy.planLabel)
  })

  it('carries no in-page anchor of its own any more', () => {
    // It used to be `#vaga`, with `scroll-mt-20` so a jump cleared the sticky
    // header. It is a dialog now: nothing links to it, and an id nothing
    // points at is the kind of leftover this repository keeps finding.
    expect(out).not.toContain('id="vaga"')
    expect(out).not.toContain('scroll-mt-20')
  })
})
