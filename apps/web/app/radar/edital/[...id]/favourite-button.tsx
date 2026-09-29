'use client'

import { useCallback, useEffect, useState } from 'react'
import { AppBarAction } from '@/components/app-bar'
import { messages } from '@/lib/messages'
import { tenderApiPath } from '@/lib/radar/client'

/**
 * *Favoritar* — mark this edital, or take the mark off (card **D23**).
 *
 * Sci, 2026-09-29: *"Favoritar is the act to select the tenders as
 * Favorate/Follow it"*.
 *
 * ## What it replaced, and why that matters
 *
 * This slot held an `AppBarActionLink` labelled **"Seguir edital"** pointing at
 * `ALERTS_HREF` — the *alerts preferences* screen. It did not follow the
 * edital, and it could not: alerts are weekly, keyword- and CNAE-based, and
 * know nothing about the tender you were looking at. An approved string
 * promising to follow **this** edital, rendering a link to a page about
 * something else.
 *
 * Found while placing this button, not by a test — nothing asserts that a
 * label and its destination agree. It is the sixth instance of the shape
 * CLAUDE.md lists, and the reason `grep` missed it earlier is that D23's
 * survey looked for *acompanhar* and *favorit*, and this one says *seguir*.
 *
 * ## The id has a slash in it, and that is why this uses `tenderApiPath`
 *
 * A `numeroControlePNCP` is `51327708000192-1-000084/2026`. This first used
 * `encodeURI`, which does **not** encode `/` — so the request went to
 * `/api/tenders/51327708000192-1-000084/2026/favorito`: two segments where the
 * route declares one. Every call 404'd, the button stayed absent for ever, and
 * absent is exactly what "still loading" looks like.
 *
 * `client.ts` has had `tenderApiPath` since the band route hit this, carrying
 * the comment *"The single-segment spelling `/api/tenders/[id]` matches"*. I
 * wrote my own encoding rather than using the helper that existed.
 *
 * ## It renders nothing until it knows
 *
 * A toggle that paints "not marked" and then corrects itself is a toggle that
 * lies for a moment, and on the one control whose entire job is reporting a
 * state. So the button is absent until `GET` answers. That is a deliberate
 * choice against a flash of the wrong state, and it is cheap: the request is a
 * primary-key lookup.
 *
 * ## A visitor is told, not ignored
 *
 * `POST` answers 401 for anybody without an account, because a favourite is a
 * row keyed on `users.id` and there is nowhere to put one otherwise. The
 * button then says so rather than appearing to work — a tap that vanishes is
 * worse than a refusal that explains itself.
 */

const copy = messages.radar.favourites

type State = { known: false } | { known: true; favourite: boolean }

export function FavouriteButton({ tenderId }: { tenderId: string }) {
  const [state, setState] = useState<State>({ known: false })
  const [refused, setRefused] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    fetch(`/api/tenders/${tenderApiPath(tenderId)}/favorito`, { signal: controller.signal })
      .then((answer) => (answer.ok ? answer.json() : null))
      .then((body) => {
        if (body?.state === 'ready') setState({ known: true, favourite: body.favourite === true })
      })
      .catch(() => {
        // Offline, aborted, or a 500. The button stays absent rather than
        // claiming a state it does not have.
      })
    return () => controller.abort()
  }, [tenderId])

  const toggle = useCallback(() => {
    // Optimistic, and reverted on refusal. The round trip is a write to one
    // row; making somebody watch a spinner for it would be worse than being
    // briefly wrong, which the revert corrects.
    setState((was) => (was.known ? { known: true, favourite: !was.favourite } : was))
    setRefused(false)

    fetch(`/api/tenders/${tenderApiPath(tenderId)}/favorito`, { method: 'POST' })
      .then(async (answer) => {
        if (answer.status === 401) {
          setRefused(true)
          setState((was) => (was.known ? { known: true, favourite: !was.favourite } : was))
          return
        }
        const body = await answer.json()
        if (body?.state === 'ready') setState({ known: true, favourite: body.favourite === true })
        else setState((was) => (was.known ? { known: true, favourite: !was.favourite } : was))
      })
      .catch(() => {
        setState((was) => (was.known ? { known: true, favourite: !was.favourite } : was))
      })
  }, [tenderId])

  if (!state.known) return null

  return (
    <AppBarAction
      icon="star"
      label={refused ? copy.signedOut : state.favourite ? copy.added : copy.add}
      onClick={toggle}
      aria-pressed={state.favourite}
    />
  )
}
