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

export type SheetPlacement =
  /** Full-height panel against the left edge. The menu drawer (D5). */
  | 'drawer'
  /**
   * Centred card, capped at the viewport's height and scrolled inside.
   *
   * For a sheet that is a *task* rather than a place — the founders signup,
   * which is a form with a submit and a confirmation. A form in a full-height
   * left drawer reads as navigation on a wide screen, and on a phone the two
   * resolve to nearly the same thing anyway: `inset-4` with a 420px cap is the
   * width the form is drawn at.
   */
  | 'centre'

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
  /** Where the panel sits. Default `drawer`, which is what the menu uses. */
  placement?: SheetPlacement
  children: ReactNode
  className?: string
}

/**
 * The panel's own box, per placement.
 *
 * A prop rather than something a caller passes through `className`: `lib/cn.ts`
 * is a plain join with no `tailwind-merge`, so a caller's `max-w-[420px]`
 * would not replace `max-w-[360px]` — both would be in the sheet and which one
 * won would be Tailwind's generation order. Variants, not competing utilities.
 */
const PLACEMENT: Record<SheetPlacement, { outer: string; panel: string }> = {
  drawer: {
    outer: 'flex',
    panel: 'relative flex h-dvh w-full max-w-[360px] flex-col overflow-y-auto border-r border-line',
  },
  /**
   * Centred card from 560px; **full-bleed below it**.
   *
   * The founders form is long — name, e-mail, WhatsApp, CNPJ, what you sell,
   * two consent checkboxes, submit. At 390px the centred version was a 358px
   * card with `max-h-full`, and that height is the problem: `position: fixed`
   * measures the *layout* viewport, which does not shrink when an iOS keyboard
   * opens. So the bottom of the panel — the submit — sat behind the keyboard,
   * reachable only by scrolling inside a box that was itself partly hidden.
   *
   * `h-dvh` tracks the dynamic viewport instead, which is exactly the case it
   * exists for, and it is what `drawer` above already uses. With the padding,
   * the radius and the border dropped below 560px the panel is the screen, so
   * there is no "outside" left to tap — dismissal is Escape and the close
   * control, both of which `Sheet` owns and neither of which is the scrim.
   */
  centre: {
    outer: 'flex items-center justify-center min-[560px]:p-4',
    panel:
      'relative flex h-dvh w-full flex-col overflow-y-auto min-[560px]:h-auto min-[560px]:max-h-full min-[560px]:max-w-[420px] min-[560px]:rounded-panel min-[560px]:border min-[560px]:border-line',
  },
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function Sheet({
  open,
  labelledBy,
  onDismiss,
  dismissLabel,
  placement = 'drawer',
  children,
  className,
}: SheetProps) {
  const panel = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLDivElement>(null)
  /** Whatever had focus when this opened. Restored on every exit path. */
  const opener = useRef<HTMLElement | null>(null)
  /** Where the page was, so the scroll lock can give it back. */
  const scrollTop = useRef(0)
  /** True between opening and the close being handled. See the effect below. */
  const wasOpen = useRef(false)

  /**
   * Give back the scroll position and the focus, when the sheet **closes**.
   *
   * This used to live in the other effect's cleanup, guarded by
   * `panel.isConnected` — the idea being that the panel is still in the
   * document when the sheet merely closed, and gone when the tree unmounted
   * under a navigation. It never was: `open` going false returns `null` from
   * this component, React detaches the panel during the commit, and the
   * passive cleanup runs *after* that. So `isConnected` was false on both
   * paths and focus was restored on neither — while the docstring above
   * promised it "on every exit". Nothing asserted it, in this repository or
   * in the drawer that shipped with it; a journey written against the founders
   * dialog is what finally disproved it.
   *
   * An effect keyed on `open` is the honest discriminator: effects do not run
   * when a component unmounts, so this body runs when and only when the sheet
   * closed while the page stayed — which is exactly the case where restoring
   * is right. Following a link out of the sheet unmounts it, this does not
   * run, and the App Router keeps its own scroll-to-top and its own focus
   * handling.
   */
  useEffect(() => {
    if (open) {
      wasOpen.current = true
      return
    }
    if (!wasOpen.current) return
    wasOpen.current = false
    // iOS Safari drops the offset when the overflow lock is released.
    window.scrollTo(0, scrollTop.current)
    opener.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return

    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null

    // Focus the heading, not the close button: the first thing a screen
    // reader says should be what just opened.
    heading.current?.focus()

    const root = document.documentElement
    scrollTop.current = window.scrollY
    const previousOverflow = root.style.overflow
    root.style.overflow = 'hidden'

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
      // Releasing the lock is right on every path, including unmount — a page
      // navigated to with `overflow: hidden` left on `<html>` cannot scroll.
      // Giving back the position and the focus is not: that belongs to the
      // close, and is in the effect above.
      root.style.overflow = previousOverflow
    }
  }, [open, onDismiss])

  if (!open) return null

  const box = PLACEMENT[placement]

  return (
    <div className={cn('fixed inset-0 z-50', box.outer)}>
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
        className={cn(box.panel, 'bg-surface', className)}
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
