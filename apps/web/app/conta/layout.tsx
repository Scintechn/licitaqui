import { AppShell } from '@/components/app-shell'
import { readShellSummary } from '@/lib/account/server-summary'
import { ACCOUNT_PATH } from '@/lib/routes'

/**
 * The shell for `/conta` and `/conta/alertas` — card D20.
 *
 * **This is the route that had nothing.** `MenuView` was mounted inside
 * `radar-screen.tsx` and nowhere else, so a signed-in person who reached their
 * own account lost the navigation entirely. That is how Sci found the card:
 * *"is not accecible in each route"*.
 *
 * See `app/radar/layout.tsx` for why this is a layout and not a route group.
 *
 * ## Signed in only, and `/conta/criar` is why
 *
 * A layout wraps everything beneath it, and `/conta/criar` is the **sign-in
 * page** — it exists for people who do not have an account and it redirects
 * anyone who does. Wrapping it would hand a signed-out person a rail full of
 * links to gated screens, and a plan strip reading "Sem conta" on the very
 * page whose job is to fix that.
 *
 * So the shell renders for a signed-in viewer and steps aside otherwise.
 * `/conta` and `/conta/alertas` redirect signed-out visitors away, so in
 * practice they always have it; `/conta/criar` never does. The alternative was
 * a `(shell)` route group and moving files, which buys the same behaviour for
 * more churn.
 *
 * **`/radar` is deliberately different** — it is usable without an account and
 * `MenuView` draws the visitor strip on purpose, so that layout wraps
 * everybody.
 */
export const dynamic = 'force-dynamic'

export default async function AccountLayout({ children }: { children: React.ReactNode }) {
  const summary = await readShellSummary()
  if (!summary?.signedIn) return <>{children}</>

  return (
    <AppShell summary={summary} current={ACCOUNT_PATH}>
      {children}
    </AppShell>
  )
}
