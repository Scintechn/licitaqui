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
 */
export function MenuTrigger() {
  const menu = useAppMenu()
  if (!menu) return null
  return <AppBarAction icon="menu" label={messages.radar.nav.menu} onClick={menu.open} />
}
