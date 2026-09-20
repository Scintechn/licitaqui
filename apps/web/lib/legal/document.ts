/**
 * Rendering the legal documents that live in `docs/legal/`.
 *
 * The pages are generated **from those Markdown files at build time**, never
 * transcribed into JSX. That is the whole point: `legal/README.md` calls the
 * Markdown the source of truth for the wording, and a hand-copied page is a
 * second copy that drifts the first time a clause is amended. A user reading
 * one version of a refund rule on the site and another in the repository is
 * exactly the disagreement that produces a chargeback.
 *
 * Sci authors the text in the knowledge base and copies it here; this module
 * turns it into HTML and nothing else. It must never edit, reflow or reword —
 * the only transformation is Markdown to HTML.
 *
 * The content is committed to this repository and is never user input, so the
 * HTML is trusted. `marked` runs at build time on the server and is not sent
 * to the browser.
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { marked } from 'marked'

/** Which document to render. The value is the file's basename in `docs/legal/`. */
export type LegalDocumentId = 'politica-de-privacidade' | 'termos-de-uso' | 'faq-cobranca'

export interface LegalDocument {
  /** The `# …` heading, lifted out so the page can put it in `<h1>` and `<title>`. */
  title: string
  /** Everything after the heading, as HTML. */
  html: string
  /** The `**Última atualização:** …` date when the document states one. */
  updatedAt: string | null
}

/**
 * `docs/legal/` relative to the running process.
 *
 * `process.cwd()` is `apps/web` under `next build` and `next dev` alike, so the
 * documents are two levels up. Resolved once, here, rather than at each call
 * site guessing it.
 */
const LEGAL_DIR = path.join(process.cwd(), '..', '..', 'docs', 'legal')

/** `**Última atualização:** 20/09/2026 · …` → `20/09/2026`. */
const UPDATED_AT = /\*\*Última atualização:\*\*\s*([^\s·*]+)/

/**
 * The drafting note each document opens with:
 *
 *     **Minuta v1.1 · 20/09/2026 · não é parecer jurídico.** Este texto foi
 *     escrito para ser revisado por um advogado antes de publicar. …
 *
 * It is addressed to Sci and to the lawyer, not to the reader, and it is the
 * one line in these files that must **not** reach a visitor: a contract whose
 * first sentence calls itself an unreviewed draft argues against its own
 * enforceability, and a privacy policy that does the same undermines the
 * consent it is there to inform.
 *
 * Removed here rather than in the Markdown, because the wording of these
 * documents is Sci's and the brief is explicit that nobody else edits it. The
 * file keeps its note for whoever opens it in the repository; the page does
 * not show it. If Sci would rather drop the line at the source, deleting this
 * constant is the whole change.
 */
const DRAFTING_NOTE = /^\*\*Minuta[^\n]*\n+/m

marked.setOptions({ gfm: true, breaks: false })

export async function loadLegalDocument(id: LegalDocumentId): Promise<LegalDocument> {
  const source = await readFile(path.join(LEGAL_DIR, `${id}.md`), 'utf8')

  const heading = source.match(/^#\s+(.+)$/m)
  const title = heading ? heading[1].trim() : id
  const body = (heading ? source.replace(heading[0], '') : source).replace(DRAFTING_NOTE, '')

  return {
    title,
    html: await marked.parse(body.trim()),
    updatedAt: source.match(UPDATED_AT)?.[1] ?? null,
  }
}
