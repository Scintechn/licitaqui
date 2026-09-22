import type { Metadata } from 'next'
import Link from 'next/link'
import { AppBar, Logo } from '@/components'
import { loadLegalDocument, type LegalDocumentId } from '@/lib/legal/document'
import { messages } from '@/lib/messages'

/**
 * The shared shell for `/termos` and `/privacidade`.
 *
 * Both pages are the same object — a long legal document with an app bar above
 * it — so they share one renderer and differ only by which file they load.
 *
 * Statically rendered: the text changes when someone commits a new version of
 * the Markdown, which is a deploy, not a request.
 */

const legal = messages.legal

export function legalMetadata(id: LegalDocumentId, canonical: string): () => Promise<Metadata> {
  return async () => {
    const { title } = await loadLegalDocument(id)
    return {
      title: `${title} · ${messages.brand.name}`,
      description: legal.meta[id],
      alternates: { canonical },
      openGraph: {
        type: 'article',
        locale: 'pt_BR',
        siteName: messages.brand.name,
        title,
        description: legal.meta[id],
      },
    }
  }
}

export async function LegalPage({ id }: { id: LegalDocumentId }) {
  const { title, html } = await loadLegalDocument(id)

  return (
    <div className="min-h-dvh bg-ivory text-base leading-[1.55] text-ink">
      <AppBar
        leading={
          <Link href="/" aria-label={legal.backToHome}>
            <Logo />
          </Link>
        }
      />
      <main className="mx-auto w-full max-w-[72ch] px-gutter pb-16">
        <h1 className="text-section font-semibold leading-tight">{title}</h1>
        {/*
          No date line here: each document opens with its own
          "Última atualização: … · Vigência: …" paragraph, which carries the
          effective date too. Rendering `updatedAt` as well printed it twice.
        */}
        {/*
          The document is committed Markdown from `docs/legal/`, converted at
          build time. It is our own content, never user input.
        */}
        <article
          className="legal-prose mt-8"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </main>
    </div>
  )
}
