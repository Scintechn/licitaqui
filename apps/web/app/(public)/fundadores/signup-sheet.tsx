'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Button, type ButtonVariant, Icon, Sheet } from '@/components'
import { messages } from '@/lib/messages'
import { SignupForm, type SignupDone } from './signup-form'

/**
 * The founders signup, as a dialog the page's calls to action open.
 *
 * ## Why this is a client island and not the page
 *
 * `page.tsx` is a server component with `force-static` (spec §3.3): the whole
 * of `/fundadores` is HTML on a CDN, and it must stay that way. Dialog state
 * needs a client component, so the boundary is drawn as tightly as it can be —
 * this file and `signup-form.tsx`. Everything the provider wraps is passed
 * through as `children`, which React renders on the server exactly as before;
 * only the four triggers and the sheet itself hydrate.
 *
 * ## One sheet, four triggers
 *
 * The header, the hero, the offer panel and the final band all open the same
 * instance through context, rather than each owning a sheet of its own. That
 * is not only about duplicate markup: `SignupForm` replaces itself with the
 * confirmation on success, and with four instances somebody who reserved from
 * the hero and then pressed the CTA at the foot of the page would be shown an
 * empty form and asked for their details a second time.
 *
 * ## What a dialog costs here, which is nothing
 *
 * The form has never worked without JavaScript. It submits through `fetch`
 * from a submit handler, carries `noValidate`, and deliberately has **no
 * `action`** — there is a test pinning that, because a bare action would
 * serialise the name, e-mail and WhatsApp number into the URL on submit. So a
 * visitor without JavaScript could not sign up before this change either, and
 * moving the form behind a trigger takes away no capability that existed.
 *
 * What it does change is that the seat gauge's `GET /api/founders/seats` now
 * runs when the sheet first opens rather than on page load. `SignupForm`
 * already aborts it on unmount, so opening and closing twice leaves no request
 * in flight.
 */

const TITLE_ID = 'signup-sheet-title'

/**
 * Opens the sheet, and names it with the label of the control that was
 * pressed. `null` outside the provider, and the triggers throw on that rather
 * than rendering a call to action that does nothing — a dead CTA on the page
 * taking sign-ups is the failure this whole file is about.
 */
const OpenSignup = createContext<((label: string) => void) | null>(null)

function useOpenSignup() {
  const open = useContext(OpenSignup)
  if (!open) {
    throw new Error('A signup trigger was rendered outside <SignupSheet>')
  }
  return open
}

export function SignupSheet({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  /**
   * The title, which is the label of the trigger that opened the sheet.
   *
   * Below 560px the sheet is the whole screen, so the dialog's name has to be
   * **visible**: without it somebody taps "Garantir minha vaga" and lands on a
   * screen whose first words are "Plano Promocional · só para fundadores",
   * with nothing connecting the two. No new copy is written for it — the
   * label of the button they just pressed is the truest heading available and
   * it is already approved, and the four triggers say four different things
   * ("Garantir minha vaga", "Quero minha vaga de fundador", "Garantir uma das
   * 48 vagas"), so a single fixed title would contradict three of them.
   *
   * It stays the accessible name at every width — the same element, the same
   * string, `sr-only` from 560px where the card is visibly a dialog over the
   * page it belongs to.
   *
   * The initial value is never rendered — `Sheet` draws nothing until `show`
   * has set a real one — but it is the header's call to action rather than an
   * empty string, so that a future way in that forgets to pass a label still
   * names the dialog something true instead of nothing.
   */
  const [title, setTitle] = useState(messages.foundersPage.nav.cta)
  /**
   * The finished signup, held **here** rather than in `SignupForm`.
   *
   * `Sheet` returns `null` when it is closed, so `SignupForm` unmounts with
   * it and everything in its state goes: the seat number and the share link
   * included. Before this, closing the confirmation destroyed it — re-opening
   * showed an empty form, and there was nothing anywhere that could tell
   * somebody what seat they had got. Escape and the close button already did
   * that; adding Back (below) would have made it a one-swipe accident on the
   * one screen where somebody has just handed over their details.
   *
   * `SignupSheet` wraps the whole page and never unmounts, so the seat
   * survives here for as long as the tab is open.
   */
  const [done, setDone] = useState<SignupDone | null>(null)
  /**
   * Whether the history entry below is ours to pop.
   *
   * A ref and not state: `dismiss` is passed to `Sheet` as `onDismiss`, which
   * is in the dependency list of the effect that focuses the panel on open. A
   * `dismiss` whose identity changed would re-run that effect and pull focus
   * back to the heading — out of the field somebody was correcting.
   */
  const ownsHistoryEntry = useRef(false)

  /**
   * Back closes the sheet instead of leaving the page.
   *
   * The panel fills the screen below 560px and reads as a page, so Back — the
   * Android button, the iOS edge-swipe — is what people use to leave it.
   * Without an entry of its own that gesture navigates away from
   * `/fundadores` and takes a half-filled form with it.
   *
   * **The URL must not change.** `pushState` is called with no `url`
   * argument, so the address stays exactly what it was: nothing in the page's
   * assertions moves, no `?vaga=1` appears in anybody's history or `Referer`,
   * and `/fundadores` stays one static document. Next patches `pushState` to
   * copy its own `__NA` marker and route tree onto whatever state is pushed
   * (`app-router.js`), which is what keeps its `popstate` handler from
   * treating the entry as foreign and reloading the page — `null` is the
   * state its own documentation passes, and it is what is passed here.
   */
  const show = useCallback((label: string) => {
    setTitle(label)
    setOpen(true)
    if (typeof window === 'undefined' || ownsHistoryEntry.current) return
    window.history.pushState(null, '')
    ownsHistoryEntry.current = true
  }, [])

  /**
   * Escape, the close button and the scrim all go through the same door as
   * Back: the sheet closes **now**, and the entry it owns is popped so that
   * the next Back is the one that leaves the page rather than one that finds
   * a sheet already gone.
   *
   * Both halves of that happen before `back()` is called, and that ordering
   * is the fix for a real race. The first version left the closing to the
   * `popstate` handler — `back()` only *queues* a traversal, so between the
   * tap and the pop the panel was still on screen with its close button live
   * and `ownsHistoryEntry` still true. A second tap in that window called
   * `back()` again: one traversal popped the sheet's entry and the other
   * popped the one underneath it, **leaving the page taking sign-ups**, with
   * the half-filled form. A phone, a 9 000px page still decoding images and a
   * control that gives no feedback is exactly where somebody taps twice.
   */
  const dismiss = useCallback(() => {
    setOpen(false)
    if (!ownsHistoryEntry.current) return
    ownsHistoryEntry.current = false
    window.history.back()
  }, [])

  /**
   * Listening whether the sheet is open or not, deliberately. Keyed on `open`
   * the listener would be removed by the close it is meant to observe, and
   * `ownsHistoryEntry` would never be cleared — so the entry would still be on
   * the stack, the next open would not push another, and Back would eventually
   * close a sheet that was already closed instead of leaving the page.
   *
   * **What this deliberately does not do is re-open on Forward.** Pressing
   * Forward after a Back lands back on the entry the sheet pushed, and this
   * closes rather than re-opens: the sheet stays shut and that entry is left
   * on the stack unowned, so one later Back press does nothing the reader can
   * see. A reload with the sheet open leaves the same orphan. The alternative
   * — marking the entry in its state and re-opening when that marker comes
   * back — reads the marker wrongly after exactly that reload (the entry
   * still says "open", the fresh React state says "closed"), which turns the
   * *next* Back into a surprise re-open. One invisible Back press after an
   * unusual gesture is the cheaper of the two, and it is written down here
   * rather than discovered.
   */
  useEffect(() => {
    function onPopState() {
      ownsHistoryEntry.current = false
      setOpen(false)
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  return (
    <OpenSignup.Provider value={show}>
      {children}
      <Sheet
        open={open}
        placement="centre"
        labelledBy={TITLE_ID}
        onDismiss={dismiss}
        dismissLabel={messages.common.close}
      >
        <div className="flex flex-col">
          {/* The close control belongs to the content, not to `Sheet` — the
              scrim is the only dismiss affordance `Sheet` owns, and a scrim is
              unreachable by keyboard. This one stays available after a
              successful signup too: somebody who has just handed over their
              details must not be trapped behind their own confirmation. */}
          {/*
            `justify-between` below 560px puts the title left and the close
            control right; `justify-end` from 560px keeps the button right
            when the heading is `sr-only` and therefore out of the flow —
            with `justify-between` and one in-flow child the button would jump
            to the *left* edge of the card.

            Not `mr-auto` on the heading: `not-sr-only` resets `margin: 0`, so
            an auto margin on that element is silently dropped. It was, and
            the title sat against the close button until a screenshot showed
            it.

            **`max-[560px]`, not `max-[559px]`.** Tailwind v4 emits `max-*` as
            a strict `width < N` — the built stylesheet says `@media not all
            and (min-width: 559px)` — so `max-[559px]` paired with
            `min-[560px]` leaves **[559, 560) matching neither**, and in that
            band this row fell back to `justify-content: normal` and put the
            close control against the title. Reachable by a desktop resize, an
            iPad split and browser zoom. `width < 560` against `width >= 560`
            is the partition with no hole in it; 559px is in the suite now.
            (There are ~12 `max-[559px]` in `page.tsx` with the same 1px hole.
            Cosmetic there, and not this PR's to sweep.)
          */}
          <div className="flex items-center gap-3 px-4 pt-4 max-[560px]:justify-between min-[560px]:justify-end min-[560px]:px-3 min-[560px]:pt-3">
            {/*
              The dialog's accessible name at every width, and its visible
              title below 560px where the sheet is the whole screen. The two
              are the same element and the same string on purpose: a visible
              heading and a separate `sr-only` name is how they drift.

              `max-[560px]:not-sr-only` / `min-[560px]:sr-only` are
              complementary queries rather than a base utility and one
              override. Both would be in the stylesheet at the same
              specificity below 560px and which one won would be Tailwind's
              generation order — the trap that lost the rule between the
              pillars on 2026-09-24. See the row above for why the breakpoint
              is 560 on both sides. Where the close control sits in each case
              is the row's business, also above.
            */}
            <h2
              id={TITLE_ID}
              className={
                'font-display text-subsection font-bold text-ink ' +
                'max-[560px]:not-sr-only min-[560px]:sr-only'
              }
            >
              {title}
            </h2>
            <button
              type="button"
              onClick={dismiss}
              aria-label={messages.common.close}
              className={
                'inline-flex size-touch shrink-0 items-center justify-center rounded-pill border-0 ' +
                'bg-transparent text-ink transition-colors hover:bg-fill-muted'
              }
            >
              <Icon name="close" size={22} />
            </button>
          </div>

          {/*
            The gutter, which below 560px is the *only* thing between the form
            and the edge of the phone: the form drops its own padding there
            (`PANEL` in `signup-form.tsx`). `px-4` rather than `px-3` for
            thumb clearance — a 16px gutter and a 358px measure at 390px,
            against the 324px the card-in-a-card left.
          */}
          <div className="px-4 pb-4 min-[560px]:px-3 min-[560px]:pb-3">
            <SignupForm done={done} onDone={setDone} />
          </div>
        </div>
      </Sheet>
    </OpenSignup.Provider>
  )
}

/**
 * A call to action that opens the sheet, drawn as a `Button`.
 *
 * `Button` without `href` renders a real `<button type="button">`, so these
 * are buttons and not links — which is what they now are. A link would promise
 * a destination, and there is no longer an `#vaga` to go to.
 */
export function SignupButton({
  variant,
  className,
  label,
}: {
  variant?: ButtonVariant
  className?: string
  /**
   * What the control says — and, because the sheet takes its title from the
   * trigger, what the dialog is called. One string, not a `children` plus a
   * `title` that can disagree: the heading is only honest if it is literally
   * the words that were pressed.
   */
  label: string
}) {
  const open = useOpenSignup()
  return (
    <Button variant={variant} className={className} onClick={() => open(label)}>
      {label}
    </Button>
  )
}

/**
 * The same action drawn as the header's text link.
 *
 * The sticky header's CTA is typographic, not a filled control, so it takes
 * the caller's classes rather than a `Button` variant — but it is still a
 * `<button>`, for the same reason as above.
 */
export function SignupTextButton({ className, label }: { className?: string; label: string }) {
  const open = useOpenSignup()
  return (
    <button type="button" onClick={() => open(label)} className={className}>
      {label}
    </button>
  )
}
