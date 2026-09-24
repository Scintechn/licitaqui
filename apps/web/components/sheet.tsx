'use client'

import { useEffect, useRef, type ReactNode } from 'react'
import { cn } from '@/lib/cn'

/**
 * A modal surface: the menu drawer (D5) and, next, the quota wall (B16).
 *
 * ## Why it is hand-rolled and not `<dialog>`
 *
 * `showModal()` gives focus trapping, inertness and Escape for free, and it
 * was the recommendation. It loses to one constraint in this repo:
 * `vitest.config.mts` sets `environment: 'node'` and there is no jsdom and no
 * `@testing-library` anywhere. Every component test here is
 * `renderToStaticMarkup` string assertions. A `<dialog>` without `open`
 * renders `display: none`, so the only thing those tests could assert is
 * invisible markup — and the alternative, adding jsdom, would make this the
 * first jsdom test in the project and slow `pnpm test` for everything else.
 *
 * A `fixed inset-0` panel renders in the server pass, asserts in the existing
 * house style, and is on screen before hydration rather than after it. What it
 * costs is that the four behaviours below are ours to write. They are written
 * here once, so the wall inherits them instead of re-deriving them differently
 * — which is how `components/tabs.tsx` ended up with a `role="tablist"` it
 * does not fully implement.
 *
 * Stacking is unusually safe here: one `z-` in the whole of `app/` and
 * `components/` (a skip link's `focus:z-10`), and `AppBar` is not sticky. The
 * drawer takes `z-50`; a future action bar should sit below it at `z-40`.
 *
 * ## The four behaviours
 *
 * 1. **Focus moves in on open** — to the panel's own heading, never to the
 *    close button, so the first thing announced is what opened rather than
 *    "fechar".
 * 2. **Tab is trapped** while it is open, both directions.
 * 3. **Focus returns** to whatever opened it, on every exit — Escape, the
 *    close button, the scrim, or following a link out.
 * 4. **The page behind does not scroll**, and its scroll position survives.
 *    The lock is on `<html>`, not `<body>`: the screens use `min-h-dvh`, so
 *    `<body>` is not the scrolling element. iOS Safari forgets the offset
 *    unless it is recorded and restored by hand.
 */

export type SheetProps = {
  open: boolean
  /** `id` of the heading that names the sheet. Required — it is the a11y name. */
  labelledBy: string
  /** Called for Escape, the scrim and the close control. */
  onDismiss: () => void
  /**
   * Accessible name for the scrim, which is the one dismiss affordance
   * `Sheet` owns. The close **button** belongs to the content — `MenuView`
   * renders its own — so this does not name that.
   *
   * It was previously rendered as an `sr-only` span *outside* the
   * `role="dialog"` element, which `aria-modal="true"` tells assistive
   * technology to ignore. It labelled nothing.
   */
  dismissLabel: string
  children: ReactNode
  className?: string
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Sheet({
  open,
  labelledBy,
  onDismiss,
  dismissLabel,
  children,
  className,
}: SheetProps) {
  const panel = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLDivElement>(null)
  /** Whatever had focus when this opened. Restored on every exit path. */
  const opener = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return

    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null

    // Focus the heading, not the close button: the first thing a screen
    // reader says should be what just opened.
    heading.current?.focus()

    const root = document.documentElement
    const scrollY = window.scrollY
    const previousOverflow = root.style.overflow
    root.style.overflow = 'hidden'
    // Captured here, not read in the cleanup: the cleanup needs to ask
    // whether *this* node is still in the document, and by then the ref may
    // already point elsewhere. This is also what react-hooks/exhaustive-deps
    // asks for, and here the rule and the intent agree.
    const openedPanel = panel.current

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onDismiss()
        return
      }
      if (event.key !== 'Tab' || !panel.current) return

      const stops = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (node) => node.offsetParent !== null || node === document.activeElement,
      )
      if (stops.length === 0) {
        event.preventDefault()
        heading.current?.focus()
        return
      }

      // Containment, not edge identity.
      //
      // The first version compared `activeElement` against the first and last
      // stops only. Focus starts on the heading wrapper, which is
      // `tabIndex={-1}` and therefore excluded from `FOCUSABLE` — so it
      // matched neither, and the very first **Shift+Tab** fell through with no
      // `preventDefault` and walked backwards out of the dialog into the page
      // behind it. Worse, it did not recover: once focus was outside, it
      // matched neither edge on every subsequent press either, so the trap
      // stayed disarmed. The docstring above claimed "both directions", and a
      // keyboard user's most likely second keystroke disproved it.
      const first = stops[0]
      const last = stops[stops.length - 1]
      const inside = panel.current.contains(document.activeElement)

      if (!inside) {
        // Whatever let focus out, take it back rather than tracking where it
        // went. Shift+Tab re-enters at the end, Tab at the start.
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
        return
      }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      // Releasing the lock is right on every path, including unmount.
      root.style.overflow = previousOverflow

      // Restoring position and focus is right on exactly one path: the sheet
      // closing while the page stays. This cleanup also runs when the tree
      // **unmounts** because somebody followed a link out of it — and there,
      // both are wrong. `scrollTo` would drag the *destination* page to the
      // old page's offset, fighting the App Router's own scroll-to-top, and
      // `opener.current` is a detached node whose `.focus()` silently does
      // nothing, dropping focus to `<body>`.
      //
      // `isConnected` is the distinction: the panel is still in the document
      // when the sheet merely closed, and gone when the tree unmounted.
      if (!openedPanel?.isConnected) return
      // iOS Safari drops the offset when overflow is released.
      window.scrollTo(0, scrollY)
      opener.current?.focus()
    }
  }, [open, onDismiss])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex">
      {/*
        A scrim, not a control. Clicking it dismisses because pointer users
        expect that, but the same action is always on a real button too — a
        backdrop click is unreachable by keyboard and invisible to a screen
        reader, so it can never be the only way out.
      */}
      <button
        type="button"
        className="absolute inset-0 bg-ink/45"
        onClick={onDismiss}
        tabIndex={-1}
        aria-label={dismissLabel}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={cn(
          'relative flex h-dvh w-full max-w-[360px] flex-col overflow-y-auto',
          'border-r border-line bg-surface',
          className,
        )}
      >
        {/*
          The focus target on open. `tabIndex={-1}` makes it focusable by
          script without adding a Tab stop of its own.
        */}
        <div ref={heading} tabIndex={-1} className="outline-none">
          {children}
        </div>
      </div>
    </div>
  )
}
