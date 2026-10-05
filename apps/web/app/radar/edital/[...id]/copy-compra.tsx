'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@/components'
import { messages } from '@/lib/messages'

const common = messages.common

/**
 * The copy button beside a price sample's Compras.gov.br purchase id (D37).
 *
 * ## Why this is a second component and not `CopyId`
 *
 * `CopyId` is the same mechanism, and it is **not reusable here for one
 * reason**: its accessible name is hard-wired to
 * `radar.opportunity.copyIdContext` — *"o Id PNCP"* — and this identifier is
 * emphatically **not** a PNCP id. Reusing it would put an approved sentence on
 * screen saying the wrong thing about where a number came from, which is the
 * defect `CLAIMS.md` exists to catch. The duplicated hook is nine lines; the
 * false provenance line would have been a claim.
 *
 * ## Its accessible name carries the id, not a sentence
 *
 * Four of these render at once, so a button named only *"Copiar"* would give a
 * screen-reader user four identical controls. The disambiguator is the
 * identifier itself — **data, not copy** — so the accessible name reads
 * *"Copiar 92990906001072026"*: it contains the visible label (WCAG 2.5.3) and
 * says which row it acts on, while writing no Portuguese sentence.
 *
 * **The visible label that names what this number *is* is still missing**, and
 * it is deliberately not invented here: *"Copiar"* is a control label, which
 * the brief allows, but a word for the identifier is copy and copy is Sci's
 * (legal brief §5). That string is **D43**, and until it exists the number
 * stands on its own and claims nothing.
 *
 * ## Why the id stays outside the button
 *
 * `CopyId`'s reasoning, unchanged and still right: a click or a drag inside a
 * `<button>` does not select its text, and selecting by hand is the fallback
 * when the Clipboard API is unavailable — an insecure origin, an old browser,
 * a denied permission. That is also why the failure path is silent: nothing was
 * lost, the number is still on screen to select.
 */
export function CopyCompra({ id }: { id: string }) {
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
    <button
      type="button"
      onClick={onCopy}
      data-testid="copy-compra"
      className="-my-1 inline-flex min-h-6 shrink-0 items-center gap-1 rounded-badge px-1 text-meta text-muted transition-colors hover:bg-fill-muted hover:text-ink"
    >
      <Icon name={copied ? 'check' : 'copy'} size={14} />
      <span aria-live="polite">{copied ? common.copied : common.copy}</span>
      <span className="sr-only"> {id}</span>
    </button>
  )
}
