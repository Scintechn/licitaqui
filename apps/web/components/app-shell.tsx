'use client'

import { createContext, useCallback, useContext, useId, useMemo, useState } from 'react'
import { MenuView } from '@/app/radar/menu-view'
import type { AccountSummary } from '@/lib/account/summary'
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

export function AppShell({
  summary,
  current,
  children,
}: {
  summary: AccountSummary | null
  /** Which nav item is the page you are on. */
  current?: string
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
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
          className="sticky top-0 hidden h-dvh w-[264px] shrink-0 border-r border-line bg-surface lg:block"
        >
          <MenuView summary={summary} current={current} />
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
