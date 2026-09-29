'use client'

import { usePathname } from 'next/navigation'
import { createContext, useCallback, useContext, useId, useMemo, useState, useSyncExternalStore } from 'react'
import { Icon } from './icon'
import { MenuView } from '@/app/radar/menu-view'
import type { AccountSummary } from '@/lib/account/summary'
import { cn } from '@/lib/cn'
import { messages } from '@/lib/messages'
import { Sheet } from './sheet'

/**
 * The navigation every signed-in screen shares — card D20.
 *
 * ## What was wrong
 *
 * `MenuView` (D5) already rendered everything the design asks for: the plan
 * name, "3 de 5 triagens usadas no mês", alerts per week, the upgrade link,
 * all read from `plan_limits` rather than from literals. Three things were
 * wrong with **where it lived**, and Sci found all three by using the product:
 *
 *   **It was mounted inside `radar-screen.tsx` and nowhere else**, so `/conta`
 *   had no menu at all and a signed-in person lost their navigation by moving
 *   between routes.
 *
 *   **It was a modal drawer with a scrim at every width.** Right on a phone;
 *   at 1440px it dimmed the page it was describing — *"the side panel didnt
 *   should block the main page"*.
 *
 *   **Nothing showed a signed-in state at all**: a bell, a person glyph and a
 *   hamburger, identical with or without an account, so the only way to learn
 *   your own plan was to open something.
 *
 * ## Mobile first, which is not a slogan here
 *
 * Sci, 2026-09-29: *"the first experience should be the mobile - so Mobile
 * first"*. The drawer is the **primary** form and is unchanged — the same
 * `Sheet`, with its focus trap, Escape and scroll lock. The rail is the
 * enhancement above it, and it is additive: below `lg` nothing behaves
 * differently.
 *
 * The rail is in the **layout flow**, not over it. That is the whole
 * difference: a `Sheet` stretched to a wide screen is still an overlay with a
 * scrim, which is the complaint. An `<aside>` beside the content cannot dim
 * it, because there is nothing to dim.
 *
 * ## Why the trigger is a context and not a rendered button
 *
 * **Both screens already draw their own `AppBar`** — `radar-view.tsx` and
 * `account-view.tsx` — so a shell that rendered one would put two bars on
 * every page. But the drawer's open state has to live here, beside the
 * drawer, and the button that opens it lives in their bars: siblings, not
 * parent and child.
 *
 * So the shell owns the state and publishes `open()`; each bar calls it.
 *
 * That seam is exactly where this repo has been burnt before, and the comment
 * in `radar-view.tsx` says so: the drawer, its API, its view and its tests all
 * shipped in #93 and **the button did not**, so `onOpenMenu` sat on a props
 * type called by nothing while `radar.nav.menu` stayed an approved string
 * rendered in zero files. An unused optional prop is legal TypeScript, so the
 * build was green and every test passed — `menu-view.test.tsx` renders
 * `MenuView` directly and never asks whether anything can reach it.
 * `app-shell.test.tsx` asserts the reachable path, not the component.
 *
 * ## `summary` arrives from the server
 *
 * A prop, read once in the layout by `readShellSummary()`, **not** fetched
 * from `/api/conta/resumo` into state. The rail is the first thing painted on
 * every signed-in route; fetching would leave the strip empty and then fill
 * it, so *"am I signed in?"* — the question this card exists to answer — would
 * go unanswered for exactly as long as the round trip took. That is the defect
 * the price band's entitlement had, the same day, for the same reason.
 *
 * `null` is a visitor, and `MenuView` already draws that strip.
 */

type AppMenu = { open: () => void }

const AppMenuContext = createContext<AppMenu | null>(null)

/**
 * The drawer opener, for a bar rendered inside the shell.
 *
 * Answers `null` outside a shell — the Landing's example panel renders
 * `RadarView` with no shell around it, and it must not draw a button that
 * opens nothing. Callers render the trigger only when this is non-null, which
 * is the same rule `radar-view.tsx` already applies to `onOpenMenu`.
 */
export function useAppMenu(): AppMenu | null {
  return useContext(AppMenuContext)
}

/**
 * Which nav item the current path is.
 *
 * **Not a prop from the layout**, and that is the whole point. A layout wraps
 * a subtree, so `app/conta/layout.tsx` would hand the same value to `/conta`
 * and `/conta/alertas` and mark the wrong one on at least one of them. The
 * path is the only thing that knows, and the shell is a client component that
 * can read it.
 *
 * Longest match wins, so `/conta/alertas` is Alertas rather than Perfil.
 * `/conta` exactly resolves to **`profile`** because three items —
 * "Minha empresa", "Plano e pagamento", "Perfil" — all point there and
 * marking by href lit all three at once. Three labels for one page is the
 * real gap and is carded as **D22**; this picks the one under CONTA, which is
 * what the page calls itself ("Sua conta").
 *
 * Exported for its test: the bug this replaces was invisible in every unit
 * test because the menu was only ever rendered with `/radar`.
 */
export function currentItem(pathname: string | null): string | undefined {
  if (!pathname) return undefined
  if (pathname.startsWith('/conta/alertas')) return 'alerts'
  if (pathname.startsWith('/conta/criar')) return undefined
  if (pathname.startsWith('/conta')) return 'profile'
  if (pathname.startsWith('/radar')) return 'radar'
  return undefined
}

/**
 * Whether the rail is collapsed, remembered per browser.
 *
 * A tiny external store rather than `useState` + an effect, for two reasons.
 * The effect version sets state synchronously on mount, which React's own
 * lint rule rejects as cascading renders — and it deserves to: the rail would
 * paint expanded and immediately re-render collapsed. And `localStorage` must
 * not be read during render, because the server cannot read it and the markup
 * would not match.
 *
 * `useSyncExternalStore` is the shape React provides for exactly this: a
 * server snapshot that is always `false`, a client snapshot read once and
 * cached, and a subscription so every shell on the page agrees.
 *
 * Never read back by the server, and never anywhere but this browser.
 */
const COLLAPSED_KEY = 'licitaqui.rail.collapsed'

let collapsedCache: boolean | null = null
const listeners = new Set<() => void>()

function readCollapsed(): boolean {
  if (collapsedCache === null) {
    try {
      collapsedCache = window.localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      // Private window, blocked site data. The rail stays expanded.
      collapsedCache = false
    }
  }
  return collapsedCache
}

/** The server has no browser storage, so it always renders the rail open. */
function serverCollapsed(): boolean {
  return false
}

function subscribeCollapsed(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function writeCollapsed(next: boolean): void {
  collapsedCache = next
  try {
    window.localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0')
  } catch {
    // Not worth failing the interaction over; it just will not be remembered.
  }
  for (const listener of listeners) listener()
}

export function AppShell({
  summary,
  children,
}: {
  summary: AccountSummary | null
  children: React.ReactNode
}) {
  const current = currentItem(usePathname())
  const [open, setOpen] = useState(false)
  const collapsed = useSyncExternalStore(subscribeCollapsed, readCollapsed, serverCollapsed)
  const toggleRail = useCallback(() => writeCollapsed(!readCollapsed()), [])
  const titleId = useId()
  const close = useCallback(() => setOpen(false), [])
  const menu = useMemo<AppMenu>(() => ({ open: () => setOpen(true) }), [])

  return (
    <AppMenuContext.Provider value={menu}>
      <div className="lg:flex lg:items-start">
        {/*
          `hidden lg:block` rather than a media-query hook: the breakpoint is a
          layout fact and CSS already knows it. Deciding it in JavaScript would
          have the server render one thing and the client another — a
          hydration mismatch on the shell of every page.

          `sticky` with `h-dvh` so the nav stays while the list behind it
          scrolls. A rail that scrolls away is a drawer with extra steps.
        */}
        <aside
          aria-label={messages.radar.menu.title}
          className={cn(
            'sticky top-0 hidden h-dvh shrink-0 border-r border-line bg-surface lg:block',
            collapsed ? 'w-[56px]' : 'w-[264px]',
          )}
        >
          {/* **Collapsed still means present.** Sci asked to be able to
              retract the rail, not to get the old drawer back: the column
              narrows to the toggle and the content beside it widens, and
              nothing overlays anything. The nav is hidden rather than
              unmounted so re-expanding costs no re-render. */}
          <div className="flex justify-end p-2">
            <button
              type="button"
              onClick={toggleRail}
              aria-expanded={!collapsed}
              aria-label={collapsed ? messages.radar.menu.expandRail : messages.radar.menu.collapseRail}
              title={collapsed ? messages.radar.menu.expandRail : messages.radar.menu.collapseRail}
              className={
                'inline-flex size-touch items-center justify-center rounded-pill border-0 ' +
                'bg-transparent text-muted transition-colors hover:bg-fill-muted hover:text-ink'
              }
            >
              <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={20} />
            </button>
          </div>
          {collapsed ? null : <MenuView summary={summary} current={current} />}
        </aside>

        {/* `min-w-0` so a wide child — a table, a long unbroken title — shrinks
            instead of pushing the rail off screen. A flex item refuses to go
            below its content width without it, and the page scrolls sideways. */}
        <div className="min-w-0 grow">{children}</div>

        {/* Below `lg` only. Rendered at every width it would leave a dialog in
            the tree beside a rail already showing the same thing, and the
            focus trap could fire on a screen with no drawer to trap into. */}
        <div className="lg:hidden">
          <Sheet
            open={open}
            labelledBy={titleId}
            onDismiss={close}
            dismissLabel={messages.common.close}
          >
            <MenuView summary={summary} current={current} onDismiss={close} titleId={titleId} />
          </Sheet>
        </div>
      </div>
    </AppMenuContext.Provider>
  )
}
