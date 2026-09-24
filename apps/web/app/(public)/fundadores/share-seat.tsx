'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Icon } from '@/components'
import { messages } from '@/lib/messages'

/**
 * The mechanism behind `founders.confirmation.share`.
 *
 * That sentence — *"Conhece outro dono de empresa pequena que disputa
 * licitação? Ainda dá tempo de ele pegar uma vaga."* — asks the reader to tell
 * somebody else, and until this file existed there was **nothing on the screen
 * to tell them with**: no link, no button, no address to copy. It is the shape
 * `CLAUDE.md` names as a recurring defect here (a string rendered with no
 * mechanism behind it, five instances already recorded), and it was the sixth.
 *
 * ## Why the address is visible and not only in the clipboard
 *
 * `navigator.clipboard` is unavailable in an insecure context and can be
 * refused by permission policy, and the failure is silent by design (below).
 * So the URL itself is rendered as ordinary selectable text: if the button
 * does nothing, the reader can still read the address out or select it by
 * hand, which is the fallback `radar/edital/[...id]/copy-id.tsx` relies on for
 * the same reason. **The text shown and the text copied are the same string**,
 * so the two can never disagree.
 *
 * ## The copy
 *
 * `common.copy` / `common.copied` — "Copiar" / "Copiado" — already existed in
 * the catalogue and were rendered nowhere. No sentence is written here: the
 * wording on this page is Sci's under legal brief §5, and the only strings
 * this component reads are ones he has already approved.
 *
 * A **WhatsApp share** deliberately does not ship with it. It needs two things
 * the catalogue does not contain — a control label, and a message body written
 * to the person receiving it — and `founders.confirmation.share` is addressed
 * to the reader, not to their friend, so reusing it as the message would put
 * approved words in a context they were not approved for. Card D15.
 *
 * ## No absolute-URL helper
 *
 * `apps/web` has none, sets no `metadataBase` and reads no site-URL variable,
 * so the origin comes from the browser the reader is already on. That is also
 * the correct answer on a preview deployment, where a hard-coded production
 * host would hand somebody a link to a different build. `PLAN_HREF` in
 * `lib/routes.ts` is *not* the constant to lean on: its own docblock says it
 * stops pointing here the day F2 ships.
 */

/** The page being shared. A literal for the reason in the docblock above. */
const FOUNDERS_PATH = '/fundadores'

/** How long "Copiado" stays before the button offers to copy again. */
const COPIED_MS = 2400

/**
 * The address to share, absolute, from the origin actually being viewed.
 *
 * Falls back to the bare path when there is no `window` — server rendering,
 * and the `renderToStaticMarkup` the component tests use. In the product this
 * branch never runs: the confirmation only exists after a submit in the
 * browser.
 */
function foundersShareUrl(): string {
  if (typeof window === 'undefined') return FOUNDERS_PATH
  return new URL(FOUNDERS_PATH, window.location.origin).toString()
}

export function ShareSeat() {
  // A lazy initialiser rather than an effect: this runs during the first
  // client render, so the button never holds a relative path that would be
  // useless to whoever it was sent to.
  const [url] = useState(foundersShareUrl)
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mounted = useRef(true)
  // Generated rather than a literal, so two of these on one page could never
  // point a screen reader at each other's address.
  const urlId = useId()

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])

  const onCopy = useCallback(async () => {
    try {
      // `navigator.clipboard` is `undefined` on an insecure origin, so this
      // throws a TypeError on the member access rather than rejecting — inside
      // the `try` either way. And `writeText` is the first statement with no
      // `await` before it, which is what keeps Safari's user-activation
      // requirement satisfied.
      await navigator.clipboard.writeText(url)
    } catch {
      // Deliberately silent, like `CopyId`. The address is on screen in full
      // and selectable, so a refused clipboard costs the reader a gesture
      // rather than the link — and an error toast here would be alarming out
      // of all proportion to that.
      return
    }
    // The sheet can be dismissed while the write is in flight, and a timer
    // registered after the cleanup effect has run would never be cleared.
    if (!mounted.current) return
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), COPIED_MS)
  }, [url])

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-4">
      <p className="text-meta leading-[1.5] text-muted">
        {messages.founders.confirmation.share}
      </p>

      {/*
        Wraps rather than scrolls: at 390px the address and the button do not
        fit on one line, and the page has a test asserting nothing is wider
        than the screen. `min-w-0` is what actually lets the address shrink —
        a flex item defaults to `min-width: auto` and would otherwise push the
        row past the panel.
      */}
      <div className="flex flex-wrap items-center gap-2">
        <span
          id={urlId}
          className={
            // `break-all` and **not** `truncate`. Truncating was tried and is
            // wrong here: at 390px it rendered "http://…/fund…", which defeats
            // the entire reason the address is on screen — a reader whose
            // clipboard is refused cannot read an address that is ellipsised.
            // Wrapping costs a second line and keeps the fallback real.
            //
            // `border-field-line`, not `border-line`: this box is drawn to look
            // like a `Field`, and tokens.css says in as many words that a
            // border which *is* the affordance takes the 3.93:1 tier.
            // `--color-line` measures 1.15:1 here — no visible edge at all.
            'min-w-0 flex-1 basis-48 break-all ' +
            'rounded-control border border-field-line bg-fill-muted px-2.5 py-2 ' +
            'text-meta text-ink-soft'
          }
        >
          {url}
        </span>

        {/*
          Not `Button`: this one swaps its icon and label in place and sits at
          the size of the field beside it, which none of the variants do.

          The accessible name is "Copiar", which says nothing about *what* on
          its own — so `aria-describedby` points at the address above it and a
          screen reader reaches "Copiar, button, https://…/fundadores" without
          a hidden string nobody has approved (WCAG 2.5.3 keeps the visible
          label as the name; the description is what adds the context).

          No `aria-live` here on purpose. The confirmation that contains this
          is already `role="status"`, so the label change is announced by that
          region; a second live region nested inside it announces twice.
        */}
        <button
          type="button"
          onClick={onCopy}
          aria-describedby={urlId}
          className={
            // The same border and height the `secondary` Button variant uses
            // (`components/button.tsx`): `border-field-line` at 3.93:1 rather
            // than `border-line` at 1.30:1, and `min-h-control` so the target
            // matches every other control in the product instead of the ~34px
            // that padding alone produced.
            'inline-flex min-h-control shrink-0 items-center gap-1.5 rounded-control ' +
            'border border-field-line bg-surface px-3 text-meta font-medium text-ink ' +
            'transition-colors hover:bg-fill-muted'
          }
        >
          <Icon name={copied ? 'check' : 'copy'} size={16} />
          {copied ? messages.common.copied : messages.common.copy}
        </button>
      </div>
    </div>
  )
}
