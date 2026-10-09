import type { Metadata } from 'next'
import { headers } from 'next/headers'
import { Suspense } from 'react'
import { messages } from '@/lib/messages'
import { listScopes } from '@/lib/radar/scope'
import { loadingStatus } from './bare-radar'
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
 *
 * ## One thing it does know, and only the server can (D58, D60)
 *
 * **Who the answer will belong to** — `listScopes`, two opaque digests of this
 * request's cookies: one for the addresses that name a CNPJ and one for the
 * addresses the cookie decides. `listScopes` says why it is two and not one; the
 * short version is that our own `POST /api/radar/cnpj` changes the jar *after*
 * this render, so a single digest went stale inside the document that was
 * writing snapshots with it. The Radar's snapshot cache keys by it, because two of the
 * things the list route answers are facts about the caller rather than about the
 * search: the stars (`favourites`, D23) and the company it grouped by
 * (`?cnpj= ?? visitors.cnpj`, D19). Without it, signing out and returning to the
 * same search inside sixty seconds restored the previous identity's stars with
 * no request made, and bare `/radar` could not be cached at all.
 *
 * It is computed **here** and not in the screen because the cookies carrying it
 * are `httpOnly` — the same reason D19 and D55 exist. It is computed here and
 * not asked of a route because the restore happens in a `useState` initializer,
 * before the first paint and before any request. And it costs one HMAC and no
 * query: `lib/radar/scope.ts` explains what the cookie jar already states and
 * why reading `visitors.cnpj` here would have been both a round trip and a
 * second copy of the route's own resolution.
 *
 * **The values the screen holds are therefore only as fresh as the last render of
 * this component**, and Next reuses a page segment on a browser back/forward
 * without re-rendering it. That is **D70**; `regrouped` in `lib/radar/list-cache.ts`
 * is the guard for the half of it an answer can reach.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: messages.radar.meta.radarTitle,
  description: messages.radar.meta.radarDescription,
  robots: { index: false, follow: false },
}

export default async function RadarPage() {
  const scopes = listScopes((await headers()).get('cookie'))
  return (
    <Suspense
      fallback={
        <RadarView
          query={{ cnpj: null, states: [], q: null, group: 'compatible' }}
          /* The status has to agree with the `query` on the line above it, and
             it did not: this frame declares no CNPJ and then said "Consultando o
             CNPJ…", which names a request that cannot have been made. Asked of
             the same function the screen asks (D55) rather than written out a
             second time — two copies of one decision in different files is D29's
             shape, and this is the file D55 did not look in at first.

             It is unreachable today, and only because of `force-dynamic` above:
             a dynamically rendered route has `useSearchParams` on the server, so
             `RadarScreen` itself renders the first frame and this fallback is
             bypassed. That is a property of the rendering mode, not a guarantee
             — so the value here is kept correct rather than left to be wrong if
             the mode ever changes. */
          status={loadingStatus(null)}
          /* Nothing is known before the client has asked: not the company, and
             not whether there is one — the CNPJ may be in the visitor cookie,
             which this server pass cannot resolve without becoming the read
             that §3.3 keeps off the CDN. `null` with an `analyzing` status is
             the one combination `CompanyLine` reads as *unknown* rather than as
             *absent* (D19), so this frame claims nothing it cannot support. */
          grouping={null}
          visitor={null}
          counts={null}
          tenders={[]}
          freshness={null}
        />
      }
    >
      <RadarScreen scopes={scopes} />
    </Suspense>
  )
}
