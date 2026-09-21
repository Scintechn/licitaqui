import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { messages } from '@/lib/messages'
import { tenderHref } from '@/lib/radar/client'
import { OpportunityScreen } from './opportunity-screen'
import { OpportunityView } from './opportunity-view'
import { PriceScreen } from './price-screen'
import { PriceView } from './price-view'
import { ScreeningScreen } from './screening-screen'
import { ScreeningView } from './screening-view'
import { readTenderRoute } from './tender-route'

/**
 * `/radar/edital/<numeroControlePNCP>` and the two screens behind it —
 * canvas 03 (`Oportunidade.dc.html`), canvas 04 (`Triagem.dc.html`) and
 * canvas 05 (`Preco.dc.html`).
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
 * ## …and why the three screens are one route rather than three
 *
 * The design board gives them three addresses — `/radar/edital/:id`,
 * `…/triagem`, `…/preco` — and Next.js will not build the obvious spelling of
 * the last two: *"Catch-all must be the last part of the URL in route
 * `/radar/edital/[...id]/triagem`"*. A catch-all swallows everything after it,
 * so nothing may be nested inside one.
 *
 * The alternative is to spell the id as two named segments
 * (`[agency]/[year]/triagem`), which trades one rule for a worse one: the shape
 * of a PNCP id would then be encoded in the *directory tree*, where the day it
 * changes is a routing bug rather than a regex to edit.
 *
 * So the catch-all keeps taking the whole path and this file reads the last
 * segment as the view. The addresses on the board are exactly the addresses
 * that ship; only the dispatch moved from the filesystem into fifteen lines
 * here, in `tender-route.ts`, where it is visible and unit-tested.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: messages.radar.meta.radarTitle,
  description: messages.radar.meta.radarDescription,
  robots: { index: false, follow: false },
}

export default async function TenderPage({ params }: { params: Promise<{ id: string[] }> }) {
  const { id } = await params
  const route = readTenderRoute(id)

  if (route.view === 'unknown') notFound()

  if (route.view === 'badId') {
    return (
      <OpportunityView tender={null} freshness={null} status={{ kind: 'notFound' }} backHref="/radar" />
    )
  }

  if (route.view === 'screening') {
    return (
      <Suspense
        fallback={
          <ScreeningView
            tenderId={route.tenderId}
            tender={null}
            model={null}
            quota={null}
            visitor={null}
            status={{ kind: 'analyzing' }}
            backHref={tenderHref(route.tenderId)}
          />
        }
      >
        <ScreeningScreen id={route.tenderId} />
      </Suspense>
    )
  }

  if (route.view === 'price') {
    return (
      <Suspense
        fallback={
          <PriceView
            tenderId={route.tenderId}
            tender={null}
            item={null}
            status={{ kind: 'analyzing' }}
            backHref={`${tenderHref(route.tenderId)}/triagem`}
          />
        }
      >
        <PriceScreen id={route.tenderId} />
      </Suspense>
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
      <OpportunityScreen id={route.tenderId} />
    </Suspense>
  )
}
