'use client'

import { useAppMenu } from './app-shell'
import { screeningsLeftCaption } from '@/lib/account/screenings-left'

/**
 * *"Restam 3 triagens neste mês"* — the caption under the action bar's button
 * (D25 (4)), or nothing at all.
 *
 * ## Why this is its own client component
 *
 * `opportunity-view.tsx` is rendered by **both** `opportunity-screen.tsx`
 * (`'use client'`) and `page.tsx` (a server component, the fallback inside the
 * Suspense boundary), so it is shared and cannot call a client hook itself.
 * The first version did, and every unit test passed — `renderToStaticMarkup`
 * is just React in node and knows nothing about the RSC boundary. The browser
 * said what node could not:
 *
 *     Attempted to call useAppMenu() from the server but useAppMenu is on the
 *     client.
 *
 * So the hook lives behind a client boundary of its own, which a server
 * component may render freely. `components/menu-trigger.tsx` is the same
 * shape for the same reason, and it is already rendered from these views.
 *
 * ## Where the number comes from
 *
 * `app/radar/layout.tsx` calls `readShell()` **once per route** and `AppShell`
 * publishes the summary on its context. This reads it from there rather than
 * from a second `readShell()` in `page.tsx`: a session read outside the
 * Suspense boundary costs the whole page on a cold Neon.
 *
 * Outside a shell — the Landing renders these screens' siblings with none —
 * and on the server pass before anything is read, this renders nothing, and
 * the bar is drawn without it.
 */
export function ScreeningsLeft() {
  const shell = useAppMenu()
  const caption = screeningsLeftCaption(shell?.summary?.screenings ?? null)
  if (caption === null) return null
  return <p className="text-caption leading-relaxed text-muted">{caption}</p>
}
