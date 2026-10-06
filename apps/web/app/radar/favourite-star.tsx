'use client'

import { useCallback, useRef, useState } from 'react'
import { Icon } from '@/components'
import { cn } from '@/lib/cn'
import { messages } from '@/lib/messages'
import { tenderApiPath } from '@/lib/radar/client'
import { useFavouriteNotice } from './favourite-notice'
import { tenderTitleId } from './tender-card'

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
 * the desired state rather than a toggle, and it is **D59**.
 *
 * ## A visitor is told, out loud and on the screen — D56
 *
 * `POST` answers 401 for anybody without an account, because a favourite is a
 * row keyed on `users.id`. The star is still drawn — §8's rule is that an
 * account adds capability, and a control that is simply absent teaches nothing.
 *
 * What it does **not** do any more is report the refusal by renaming itself. It
 * did, in `aria-label` and `title` and nowhere else, and both are *present*
 * rather than *said*: renaming an already-focused button does not reliably fire
 * an announcement, and a thumb on a phone never produces a hover. The sentence
 * now goes to the list's one live region (`favourite-notice.tsx`), which is
 * visible, announced, and the same place every other failure lands.
 *
 * **Every failure lands there, not only the 401.** `refused` used to be set on
 * 401 alone, so a 429 (this route allows 60 a minute), a 400, a 500 and a
 * dropped connection all reverted in identical silence. Three sentences now
 * cover them: the approved `signedOut` for 401, `tooMany` for 429 — where
 * *"tente de novo"* on its own would be wrong advice, because an immediate retry
 * fails again — and `failed` for everything else, including a body that is not
 * `ready`, which used to revert saying nothing at all.
 *
 * `tooMany` and `failed` are **drafts awaiting Sci** (their `_note` lines in
 * `pt-BR.json` say so). `signedOut` is his.
 *
 * ## One name per star, and it names the edital — D57
 *
 * Every star on the list used to be `aria-label="Favoritar"`: on the opportunity
 * screen that is right, and in a list of twenty it is twenty buttons with one
 * name, unusable to list and ambiguous to voice control. The name is now
 * composed by `aria-labelledby` from two nodes that already exist — this
 * button's own `sr-only` action word and the **card's title** — so the computed
 * name is *"Favoritar Baterias e pilhas"* with **no new string**: both halves are
 * text the screen is already showing, joined by the accessible name computation
 * and not by a sentence anybody wrote. `tenderTitleId` is derived on both sides
 * from the tender id, so the reference cannot dangle.
 *
 * The action comes first because that is what the control *does* and what a
 * reader skimming a list of buttons needs in the first word; the subject
 * disambiguates it. A composed sentence (*Favoritar "Baterias e pilhas"*) reads
 * better and is a new user-facing sentence, which is Sci's.
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

/**
 * The id of the `sr-only` span this button names itself from.
 *
 * It is a node *inside* the button rather than `aria-label` beside it, so that a
 * card whose title node is somehow absent still yields "Favoritar" instead of an
 * empty accessible name — the failure mode of an `aria-labelledby` whose every
 * reference dangles.
 */
function actionId(tenderId: string): string {
  return `favourite-action-${tenderId.replace(/[^A-Za-z0-9_-]+/g, '-')}`
}

export function FavouriteStar({ tenderId, marked, onChange }: FavouriteStarProps) {
  const announce = useFavouriteNotice()
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

    // The sentence from the last failure, if one is up, is about a press that
    // is now over. Cleared here rather than left to expire.
    announce(null)
    onChange(tenderId, !before)

    const fail = (message: string) => {
      announce(message)
      revert()
    }

    fetch(`/api/tenders/${tenderApiPath(tenderId)}/favorito`, { method: 'POST' })
      .then(async (answer) => {
        // 401: no account. The one approved sentence, and the only failure that
        // is not a failure — the route is working exactly as §8 says it should.
        if (answer.status === 401) return fail(copy.signedOut)
        // 429: the route allows 60 a minute, which a reader working down a long
        // list can reach. "Tente de novo" alone would be wrong advice here.
        if (answer.status === 429) return fail(copy.tooMany)
        const body: unknown = await answer.json().catch(() => null)
        const state = body as { state?: string; favourite?: boolean } | null
        if (answer.ok && state?.state === 'ready') {
          onChange(tenderId, state.favourite === true)
          return
        }
        // A 400, a 500, or a 200 whose body is not `ready`. The last one used to
        // revert in complete silence, which looked identical to the star not
        // having been pressed.
        fail(copy.failed)
      })
      // Offline, DNS, a dropped connection: the press never reached the route.
      .catch(() => fail(copy.failed))
      .finally(settle)
  }, [announce, marked, onChange, tenderId])

  const label = marked ? copy.added : copy.add
  const action = actionId(tenderId)

  return (
    <button
      type="button"
      onClick={toggle}
      /* D57: the action word plus the card's own title, in that order. Never
         `aria-label` — twenty stars with one name is the defect. */
      aria-labelledby={`${action} ${tenderTitleId(tenderId)}`}
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
      {/* The action half of the name. `sr-only` and not `aria-label`, so the
          composed name below can never come out empty. */}
      <span id={action} className="sr-only">
        {label}
      </span>
      <Icon name="star" size={22} filled={marked} />
    </button>
  )
}
