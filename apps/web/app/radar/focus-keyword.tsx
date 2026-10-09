'use client'

import { useEffect } from 'react'

/**
 * Puts the cursor in the Radar's keyword field once, when it mounts.
 *
 * A component of its own because `RadarView` is also rendered by the server
 * page as the Suspense fallback, so it cannot hold an effect itself; this is
 * the client boundary. It renders nothing. `FilterRow` mounts it only while
 * `asksForKeyword` is true, which is a state that arrives **after** the first
 * paint (the CNPJ post has to answer first) — so `autoFocus` on the input,
 * which only acts at mount and the input mounted long before, would do nothing.
 *
 * `preventScroll`: the field is in the search block at the top of the screen,
 * a few rows under the header; letting the browser scroll to it would jump the
 * page past the card that explains why the cursor moved.
 */
export function FocusKeyword() {
  useEffect(() => {
    const input = document.getElementById('radar-q')
    if (input instanceof HTMLInputElement) input.focus({ preventScroll: true })
  }, [])
  return null
}
