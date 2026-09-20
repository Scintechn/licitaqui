import type { Metadata } from 'next'
import { Suspense } from 'react'
import { messages } from '@/lib/messages'
import { OpportunityScreen } from './opportunity-screen'
import { OpportunityView } from './opportunity-view'

/**
 * `/radar/edital/<numeroControlePNCP>` — canvas 03, `Oportunidade.dc.html`.
 *
 * ## Why a catch-all segment
 *
 * A PNCP id is `51885242000140-1-000744/2026`: **it contains a slash**. A
 * single `[id]` segment would force `%2F` into the path, which proxies,
 * CDNs and browsers each normalise differently — the classic way a working
 * link becomes a 404 in production only. `[...id]` takes the two halves as
 * two segments and joins them back, so the address stays the id a person can
 * read and paste.
 *
 * Spec §3.3: the page is user data (the match badge and the locked file block
 * both depend on who is asking), so it is dynamic and never cached.
 */

export const dynamic = 'force-dynamic'

/** PNCP's `numeroControlePNCP`, the same shape the API route enforces. */
const TENDER_ID_RE = /^\d{14}-\d-\d{6}\/\d{4}$/

export const metadata: Metadata = {
  title: messages.radar.meta.radarTitle,
  description: messages.radar.meta.radarDescription,
  robots: { index: false, follow: false },
}

export default async function OpportunityPage({
  params,
}: {
  params: Promise<{ id: string[] }>
}) {
  const { id } = await params
  const tenderId = (id ?? []).join('/')

  if (!TENDER_ID_RE.test(tenderId)) {
    return (
      <OpportunityView
        tender={null}
        freshness={null}
        status={{ kind: 'notFound' }}
        backHref="/radar"
      />
    )
  }

  return (
    <Suspense
      fallback={
        <OpportunityView
          tender={null}
          freshness={null}
          status={{ kind: 'analyzing' }}
          backHref="/radar"
        />
      }
    >
      <OpportunityScreen id={tenderId} />
    </Suspense>
  )
}
