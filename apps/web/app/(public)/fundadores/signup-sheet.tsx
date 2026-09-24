'use client'

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { Button, type ButtonVariant, Icon, Sheet } from '@/components'
import { messages } from '@/lib/messages'
import { SignupForm } from './signup-form'

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
 * Opens the sheet. `null` outside the provider, and the triggers throw on
 * that rather than rendering a call to action that does nothing — a dead CTA
 * on the page taking sign-ups is the failure this whole file is about.
 */
const OpenSignup = createContext<(() => void) | null>(null)

function useOpenSignup() {
  const open = useContext(OpenSignup)
  if (!open) {
    throw new Error('A signup trigger was rendered outside <SignupSheet>')
  }
  return open
}

export function SignupSheet({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const show = useCallback(() => setOpen(true), [])
  const dismiss = useCallback(() => setOpen(false), [])

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
          <div className="flex justify-end px-3 pt-3">
            <button
              type="button"
              onClick={dismiss}
              aria-label={messages.common.close}
              className={
                'inline-flex size-touch items-center justify-center rounded-pill border-0 ' +
                'bg-transparent text-ink transition-colors hover:bg-fill-muted'
              }
            >
              <Icon name="close" size={22} />
            </button>
          </div>

          {/* The dialog's accessible name. Visually hidden, and it is the
              header's own approved call to action rather than a new title:
              copy on this page is Sci's under the legal brief. */}
          <h2 id={TITLE_ID} className="sr-only">
            {messages.foundersPage.nav.cta}
          </h2>

          <div className="px-3 pb-3">
            <SignupForm />
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
  children,
}: {
  variant?: ButtonVariant
  className?: string
  children: ReactNode
}) {
  return (
    <Button variant={variant} className={className} onClick={useOpenSignup()}>
      {children}
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
export function SignupTextButton({
  className,
  children,
}: {
  className?: string
  children: ReactNode
}) {
  return (
    <button type="button" onClick={useOpenSignup()} className={className}>
      {children}
    </button>
  )
}
