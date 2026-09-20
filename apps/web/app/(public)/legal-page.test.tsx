import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { loadLegalDocument, type LegalDocumentId } from '@/lib/legal/document'
import { messages } from '@/lib/messages'
import { LegalPage } from './legal-page'
import Privacidade from './privacidade/page'
import Termos from './termos/page'

/**
 * `/termos` and `/privacidade`.
 *
 * These pages exist because the Offer form asks people to accept two documents
 * — LGPD art. 8, CDC art. 46. Until this lane they were not published at all
 * and the checkbox named them in plain text, so the acceptance it recorded was
 * one nobody could have given. What follows pins the parts that make them
 * count as published: the real text is on the page, it comes from the Markdown
 * rather than a second copy, and it carries a publication date.
 */

/**
 * `LegalPage` is an async server component, and `renderToStaticMarkup` is
 * synchronous: it cannot resolve one nested inside another element. So the
 * shell is awaited and rendered directly, and the two route modules are
 * checked separately for pointing at the right document.
 */
const render = async (id: LegalDocumentId) => renderToStaticMarkup(await LegalPage({ id }))

describe.each([
  ['termos-de-uso', Termos] as const,
  ['politica-de-privacidade', Privacidade] as const,
])('%s', (id, Page) => {
  it('is what the route renders', () => {
    const element = Page() as React.JSX.Element
    expect(element.type).toBe(LegalPage)
    expect(element.props).toEqual({ id })
  })

  it('renders the document from docs/legal, not a transcription', async () => {
    const { title, html } = await loadLegalDocument(id)
    const out = await render(id)

    expect(out).toContain(title)
    // A distinctive run of the real text, so a page that renders an empty
    // document or the wrong file fails here rather than looking fine.
    const sample = html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).slice(40, 48)
    expect(sample.length).toBeGreaterThan(0)
    for (const word of sample) expect(out).toContain(word)
  })

  it('states when it was published — an undated policy is not published', async () => {
    const out = await render(id)
    expect(out).toContain(messages.legal.updatedAt)
    expect(out).toMatch(/\d{2}\/\d{2}\/\d{4}/)
  })

  it('leaves no placeholder in front of a reader', async () => {
    const { html } = await loadLegalDocument(id)
    expect(html).not.toContain('TODO')
    // Bracketed placeholders in the prose. Checked on the document rather than
    // the page, whose Tailwind class names legitimately contain brackets.
    expect(html).not.toMatch(/\[[A-ZÀ-Ú]/)
  })

  it('does not show the reader the drafting note meant for Sci and the lawyer', async () => {
    const out = await render(id)
    expect(out).not.toContain('Minuta')
    expect(out).not.toContain('não é parecer jurídico')
    expect(out).not.toContain('antes de publicar')
  })

  it('has exactly one h1', async () => {
    const out = await render(id)
    expect(out.match(/<h1/g)).toHaveLength(1)
  })
})

describe('the documents themselves', () => {
  it('carry the company identification the brief prescribes', async () => {
    const terms = await loadLegalDocument('termos-de-uso')
    const privacy = await loadLegalDocument('politica-de-privacidade')
    for (const doc of [terms, privacy]) {
      expect(doc.html).toContain('36.955.612/0001-85')
    }
    expect(privacy.html).toContain('privacidade@licitaquiapp.com.br')
  })

  it('publish no physical address and no elected forum (decided 20/09/2026)', async () => {
    const terms = await loadLegalDocument('termos-de-uso')
    expect(terms.html).not.toMatch(/foro da comarca/i)
    expect(terms.html).not.toContain('escritório virtual')
  })

  it('renders tables, which most of the privacy policy is', async () => {
    const { html } = await loadLegalDocument('politica-de-privacidade')
    expect(html).toContain('<table>')
  })
})

describe('the shared shell', () => {
  it('links back to the landing so the page is not a dead end', async () => {
    const out = renderToStaticMarkup(await LegalPage({ id: 'termos-de-uso' }))
    expect(out).toContain('href="/"')
    expect(out).toContain(messages.legal.backToHome)
  })
})
