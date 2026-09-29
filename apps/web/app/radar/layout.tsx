import { AppShell } from '@/components/app-shell'
import { readShellSummary } from '@/lib/account/server-summary'

/**
 * The shell for `/radar` and every screen under it — the edital tabs, the
 * triagem, the price screen (card D20).
 *
 * A layout rather than an `app/(app)/` route group. The group is the textbook
 * answer and means `git mv`-ing `radar/` and `conta/` into it: correct,
 * mechanical, and a large move nine days before the 08/10 opening. Sci chose
 * one shared `AppShell` rendered by two thin layouts instead — same single
 * source, no files moved. If the group is ever wanted, `AppShell` does not
 * change.
 *
 * `force-dynamic` because the summary is per-viewer. Without it Next would
 * happily serve one person's plan to the next.
 */
export const dynamic = 'force-dynamic'

export default async function RadarLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppShell summary={await readShellSummary()}>
      {children}
    </AppShell>
  )
}
