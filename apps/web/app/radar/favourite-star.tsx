'use client'

import { useCallback, useRef, useState } from 'react'
import { Icon } from '@/components'
import { cn } from '@/lib/cn'
import { messages } from '@/lib/messages'
import { tenderApiPath } from '@/lib/radar/client'

/**
 * *Favoritar*, on a Radar card — the second half of card **D23**.
 *
 * Sci, 2026-10-06, from a screenshot of `/radar?q=canvas&group=compatible`:
 * *"The favourite button should be able to mark the Tenders from the page 1,
 * and see if we already marked as Favourite"*. The opportunity screen's button
 * (`edital/[...id]/favourite-button.tsx`) shipped on 29/09; this is the same
 * gesture where the list is.
 *
 * ## It is seeded, and it does not fetch on mount
 *
 * The opportunity-screen button renders **nothing** until its `GET` answers,
 * which is right for one control on one screen and wrong for thirteen: it would
 * be thirteen holes in a list, filled one round trip at a time, and thirteen
 * requests describing the list that had just been read. So the marked ids come
 * back **in the list envelope** — `TenderListOk.favourites`, one `exists`
 * projected over the page — and this control is told what it is before it
 * paints. It therefore has no "unknown" state and never shows the wrong one.
 *
 * That is also why `marked` is a prop and not state here. The owner of the
 * truth is `RadarScreen`, because the set has to outlive this component: the
 * list snapshot (`lib/radar/list-cache.ts`) carries it, or pressing Back would
 * restore the list with every star empty.
 *
 * ## The round trip
 *
 * `POST /api/tenders/:id/favorito` toggles, and the parent is told
 * **optimistically** — a write to one row is not worth a spinner — then told
 * again with whatever the route actually says. A refusal or a dropped
 * connection reverts to the value this button was showing when it was pressed,
 * which is `marked` at the moment of the click and not whatever the set holds
 * by the time the answer lands.
 *
 * `tenderApiPath`, not a hand-rolled `encodeURI`: a `numeroControlePNCP` is
 * `51327708000192-1-000084/2026`, and the unescaped `/` made every call on the
 * opportunity screen 404 into a route declaring one segment. The same mistake
 * here would be silent in the same way.
 *
 * ## One request at a time, per tender
 *
 * A press while a `POST` for this tender is still open is **ignored**, and that
 * is a correctness rule rather than a politeness. Two open toggles answer in
 * whatever order the network returns them, and applying the second answer to
 * arrive leaves the screen saying one thing and the row saying another — which
 * the list's save effect then writes into `sessionStorage`, so the wrong star
 * survives a Back. Serialising makes the last answer the only answer.
 *
 * Ignoring, not disabling: a button that greys out for 200 ms on every press
 * draws attention to the round trip, and the outcome of a double tap inside one
 * round trip is the same as the outcome of the idempotent single tap this
 * control already promises. `aria-busy` says so for anybody who is listening.
 *
 * **What this does not fix**: two *tabs* toggling the same tender at the same
 * moment. `toggleFavourite` is `delete … returning` then `insert`, which closes
 * the lost-**row** window and not the lost-**intent** one — both find nothing to
 * delete, both insert, and two taps produce one mark. That needs a `PUT` with
 * the desired state rather than a toggle, and it is **D57**.
 *
 * ## A visitor is told, not ignored
 *
 * `POST` answers 401 for anybody without an account, because a favourite is a
 * row keyed on `users.id`. The star is still drawn — §8's rule is that an
 * account adds capability, and a control that is simply absent teaches nothing
 * — and on the refusal the string goes into `title` and into the accessible
 * name, which is reachable with a pointer and with a screen reader's own
 * inspection.
 *
 * **It is not announced, and that is stated rather than assumed**: changing the
 * `aria-label` of an already-focused button does not reliably fire an
 * announcement, there is no live region on this screen, and nothing here has
 * been tested with a screen reader. So on a card the refusal is *present*, not
 * *said*. The opportunity screen has a bar to put a sentence in and a card in a
 * list of twenty has not; where that sentence goes is a design decision and a
 * new string, which is **D54**.
 *
 * **Every other failure reverts in silence** — a 429 (this route allows 60 a
 * minute), a 400, a 500, a dropped connection. The star flips, bounces back and
 * says nothing, because the only approved sentence here is about not having an
 * account and it would be a lie about a 500. Same missing surface, same card.
 */

const copy = messages.radar.favourites

export type FavouriteStarProps = {
  tenderId: string
  /** From the list envelope, through `RadarScreen`'s set. Never guessed. */
  marked: boolean
  /**
   * Tell the owner what this tender's mark is now. Called optimistically on the
   * press, then again with the route's answer — or with the pre-press value when
   * the route refuses.
   */
  onChange: (tenderId: string, marked: boolean) => void
}

export function FavouriteStar({ tenderId, marked, onChange }: FavouriteStarProps) {
  const [refused, setRefused] = useState(false)
  /**
   * A `POST` for this tender is open. A ref and not state, deliberately: it
   * gates the handler rather than the render, and `aria-busy` below reads the
   * same fact from `busy`, which does render.
   */
  const open = useRef(false)
  const [busy, setBusy] = useState(false)

  const toggle = useCallback(() => {
    // Serialised, so the last answer is the only answer. See the docstring: two
    // open toggles can answer out of order, and the loser is written into the
    // list snapshot.
    if (open.current) return
    open.current = true
    setBusy(true)

    // `marked` is read here, in the handler, so the revert restores what this
    // button was showing when it was pressed rather than whatever the set holds
    // when the answer arrives.
    const before = marked
    const revert = () => onChange(tenderId, before)
    const settle = () => {
      open.current = false
      setBusy(false)
    }

    setRefused(false)
    onChange(tenderId, !before)

    fetch(`/api/tenders/${tenderApiPath(tenderId)}/favorito`, { method: 'POST' })
      .then(async (answer) => {
        if (answer.status === 401) {
          setRefused(true)
          revert()
          return
        }
        const body: unknown = await answer.json().catch(() => null)
        const state = body as { state?: string; favourite?: boolean } | null
        if (state?.state === 'ready') onChange(tenderId, state.favourite === true)
        else revert()
      })
      .catch(revert)
      .finally(settle)
  }, [marked, onChange, tenderId])

  const label = refused ? copy.signedOut : marked ? copy.added : copy.add

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      aria-pressed={marked}
      aria-busy={busy || undefined}
      title={label}
      className={cn(
        // The 44px target `AppBarAction` uses, spelled out rather than imported:
        // this button is not in a bar, and `AppBarAction`'s hover fill is drawn
        // for a bar background, not over a card.
        'inline-flex size-touch items-center justify-center rounded-pill border-0 bg-transparent',
        'transition-colors',
        // The hover is a colour and not a fill: `fill-muted` (#f3eee8) on the
        // card's white `surface` measures 1.05:1, which is a hover nobody can
        // see. muted → ink is 5.3:1 → 17.9:1 and says the same thing.
        //
        // One expression rather than a `hover:` utility beside `text-blue`,
        // because `.hover\:text-ink:hover` outranks `.text-blue` and a marked
        // star would lose its colour under the pointer.
        marked ? 'text-blue' : 'text-muted hover:text-ink',
      )}
    >
      <Icon name="star" size={22} filled={marked} />
    </button>
  )
}
