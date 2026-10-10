'use client'

import { useAppMenu } from './app-shell'
import { AppBarAction } from './app-bar'
import { messages } from '@/lib/messages'

/**
 * The button that opens the shell's drawer, for a bar that is not the shell.
 *
 * `AppShell` owns the drawer and its open state; `radar-view.tsx` and
 * `account-view.tsx` own the bars. This is the seam between them, and it is
 * the seam this repo has already shipped broken once: in #93 the drawer, its
 * API, its view and its tests all landed and **the button did not**, so
 * `onOpenMenu` sat on a props type called by nothing and `radar.nav.menu`
 * stayed an approved string rendered in zero files.
 *
 * Renders **nothing** outside a shell, which is not a defensive nicety: the
 * Landing draws `RadarView` inside an example panel with no shell around it,
 * and a hamburger there would open nothing at all.
 *
 * `/conta` never had this button. That is how Sci found D20 — signed in, on
 * his own account page, with no way to reach his plan or his triagens.
 *
 * **`lg:hidden`, because the drawer is.** From `lg` the shell draws the rail
 * and wraps the drawer in `lg:hidden` (`app-shell.tsx`), so on a desktop this
 * button set `open` on a drawer that was never painted: a hamburger that did
 * nothing (D85, Sci 2026-10-10). The expanded rail is the menu there. The
 * *collapsed* rail is not — it draws only its expand toggle, which is **D77**,
 * still open — but hiding this removes no way out of that state, because the
 * button never opened anything above `lg`. If D77 is answered with "the drawer
 * above `lg`", this class is the line that comes back off, for the collapsed
 * case only. A viewport breakpoint is right here and not a container query: the
 * question is whether the shell's rail exists, and the shell asks it with the
 * same `lg`.
 */
export function MenuTrigger() {
  const menu = useAppMenu()
  if (!menu) return null
  return <MenuButton onClick={menu.open} />
}

/**
 * The hamburger itself, for a bar that is handed its opener as a prop —
 * `radar-view.tsx`, which the Landing also draws with no shell around it.
 *
 * It lives here, beside `MenuTrigger`, so that `lg:hidden` is written once and
 * next to the reason. That class asks the **window**, deliberately, and
 * `radar-filters.test.tsx` forbids `radar-view.tsx` from asking the window
 * anything above 720px — rightly, for its layout, which lives in a column the
 * rail narrows. This is not layout in that column; it is whether the shell's
 * drawer exists at all, and the shell decides that with the same `lg`.
 */
export function MenuButton({ onClick }: { onClick: () => void }) {
  return (
    <AppBarAction
      icon="menu"
      label={messages.radar.nav.menu}
      onClick={onClick}
      className="lg:hidden"
    />
  )
}
