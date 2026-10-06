'use client'

import { useCallback, useState } from 'react'
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
 * ## A visitor is told, not ignored
 *
 * `POST` answers 401 for anybody without an account, because a favourite is a
 * row keyed on `users.id`. The star is still drawn — §8's rule is that an
 * account adds capability, and a control that is simply absent teaches nothing
 * — and on the refusal it says so, in `title` as well as in its accessible
 * name, so the message is reachable with a pointer and not only with a screen
 * reader. **What it cannot do on a card is say it loudly**: the opportunity
 * screen has a bar to put a sentence in and a card in a list of twenty has not.
 * **D54** is the card for that, because where the sentence goes is a design
 * decision and a new string, not a line in this file.
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

  const toggle = useCallback(() => {
    // `marked` is read here, in the handler, so the revert restores what this
    // button was showing when it was pressed rather than whatever the set holds
    // when the answer arrives.
    const before = marked
    const revert = () => onChange(tenderId, before)

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
  }, [marked, onChange, tenderId])

  const label = refused ? copy.signedOut : marked ? copy.added : copy.add

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      aria-pressed={marked}
      title={label}
      className={cn(
        // The 44px target `AppBarAction` uses, spelled out rather than imported:
        // this button is not in a bar, and `AppBarAction`'s hover fill is drawn
        // for a bar background, not over a card.
        'inline-flex size-touch items-center justify-center rounded-pill border-0 bg-transparent',
        'text-muted transition-colors hover:bg-fill-muted',
        marked && 'text-blue',
      )}
    >
      <Icon name="star" size={22} filled={marked} />
    </button>
  )
}
