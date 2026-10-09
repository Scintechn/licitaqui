'use client'

import { useEffect } from 'react'

/**
 * The CNPJs whose keyword field has already been given the cursor, in this
 * document. Module state rather than component state because the component
 * does not survive what it has to survive: every tab, UF, order or retry puts
 * the Radar through its loading status, which unmounts this and mounts it again
 * when the answer comes back — and an effect that ran "once per mount" then
 * pulled the cursor back to the field (and, on Android, the keyboard up) on every
 * one of those presses. Found in review before the PR.
 */
const focusedFor = new Set<string>()

/**
 * Puts the cursor in the Radar's keyword field once per CNPJ, when it mounts.
 *
 * A component of its own because `RadarView` is also rendered by the server
 * page as the Suspense fallback, so it cannot hold an effect itself; this is
 * the client boundary. It renders nothing. `FilterRow` mounts it only while
 * `asksForKeyword` is true, which is a state that arrives **after** the first
 * paint (the CNPJ post has to answer first) — so `autoFocus` on the input,
 * which only acts at mount and the input mounted long before, would do nothing.
 *
 * `preventScroll`: a restored list may put the reader further down the page,
 * and moving the cursor should not move them.
 */
export function FocusKeyword({ cnpj }: { cnpj: string | null }) {
  useEffect(() => {
    const key = cnpj ?? ''
    if (focusedFor.has(key)) return
    const input = document.getElementById('radar-q')
    if (!(input instanceof HTMLInputElement)) return
    focusedFor.add(key)
    input.focus({ preventScroll: true })
  }, [cnpj])
  return null
}
