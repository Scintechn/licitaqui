import type { Metadata } from 'next'
import { Suspense } from 'react'
import { messages } from '@/lib/messages'
import { RadarScreen } from './radar-screen'
import { RadarView } from './radar-view'

/**
 * `/radar` — canvas 02, `Editais.dc.html`.
 *
 * Spec §3.3: the Radar is **user data**, so it is dynamic and never touches a
 * CDN. `force-dynamic` makes Next answer every request with
 * `private, no-cache, no-store, max-age=0, must-revalidate`; `next.config.ts`
 * states the same header explicitly for this path, because a page that
 * accidentally became static would serve the previous visitor's company to the
 * next one, and one of those two guards should be visible in the diff.
 *
 * The page itself renders nothing but the shell: everything below depends on
 * the visitor cookie and on three fetches, so it lives in the client component
 * and the server sends the frame it will fill.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: messages.radar.meta.radarTitle,
  description: messages.radar.meta.radarDescription,
  robots: { index: false, follow: false },
}

export default function RadarPage() {
  return (
    <Suspense
      fallback={
        <RadarView
          query={{ cnpj: null, state: null, q: null, group: 'compatible' }}
          status={{ kind: 'analyzing', what: 'company' }}
          company={null}
          visitor={null}
          counts={null}
          tenders={[]}
          freshness={null}
        />
      }
    >
      <RadarScreen />
    </Suspense>
  )
}
