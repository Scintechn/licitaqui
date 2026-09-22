'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@/components'
import { messages } from '@/lib/messages'

const page = messages.radar.opportunity

/**
 * The copy button beside the Id contratação PNCP.
 *
 * ## Why this is its own file
 *
 * `opportunity-view.tsx` is imported by `page.tsx`, a **server** component, as
 * well as by the client screen. It therefore cannot hold a hook. This is the
 * one interactive atom of the row, so it is the one thing marked `'use client'`
 * and the rest of the screen stays renderable on the server.
 *
 * ## Why the id is not *inside* the button
 *
 * Pasting the id into PNCP's search is the use this exists for, and a click or
 * a drag inside a `<button>` does not select its text. So the id stays plain,
 * selectable text and the button sits next to it: the mouse gets one click, the
 * keyboard gets a labelled control, and selecting by hand still works when the
 * Clipboard API is unavailable — an insecure origin, an old browser, or a user
 * who denied the permission. That fallback is why the failure path below is
 * silent rather than an error message: nothing was lost.
 */
export function CopyId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    [],
  )

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(id)
    } catch {
      return
    }
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 2400)
  }, [id])

  return (
    /*
     * Labelled, not icon-only. At 390px the id already fills the row, so the
     * button wraps to a line of its own — and a bare glyph sitting under an
     * identifier is a guess, not an affordance. "Copiar" costs 45px on a line
     * that was empty anyway, and at 1280px it still sits inline after the id.
     *
     * The accessible name is the visible word plus a hidden "o Id PNCP", so it
     * says which thing it copies while still containing its visible label
     * (WCAG 2.5.3). `aria-live` announces the swap to "Copiado"; the icon is
     * decorative, because the word beside it already says the same.
     */
    <button
      type="button"
      onClick={onCopy}
      className="-my-1 inline-flex min-h-6 shrink-0 items-center gap-1 rounded-badge px-1 text-meta text-muted transition-colors hover:bg-fill-muted hover:text-ink"
    >
      <Icon name={copied ? 'check' : 'copy'} size={14} />
      <span aria-live="polite">{copied ? page.copiedId : page.copyId}</span>
      <span className="sr-only"> {page.copyIdContext}</span>
    </button>
  )
}
