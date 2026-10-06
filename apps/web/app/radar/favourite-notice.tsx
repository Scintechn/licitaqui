'use client'

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { Icon } from '@/components'
import { cn } from '@/lib/cn'
import { messages } from '@/lib/messages'

/**
 * **Where a failed *Favoritar* goes** — card **D56**.
 *
 * ## The hole this closes
 *
 * `POST /api/tenders/:id/favorito` answers **401** for anybody without an
 * account, and until this file existed the star reported that by swapping its
 * own `aria-label` and `title`. Both are *present* and neither is *said*:
 * changing the accessible name of an already-focused button does not reliably
 * fire an announcement, and a thumb on a phone never produces a hover at all.
 * So a visitor got a star that filled, bounced back, and explained nothing.
 *
 * The same silence swallowed **every other failure** — the route allows 60 a
 * minute, so a 429 is reachable by a reader working down a list, and a 400, a
 * 500 and a dropped connection all reverted identically. `refused` was set on
 * 401 only.
 *
 * ## Why a region the list owns, and not something on the card
 *
 * D56 named three candidate surfaces: a toast the list owns, an inline line
 * under the pressed card, or the Landing's account prompt. The card has no room
 * — the star lives in a 44px box absolutely positioned over the card's top
 * right corner (`tender-card.tsx`), so a sentence hung off it is drawn over the
 * title, and one in the flow would have to restructure the wrapper every card in
 * three screens shares. A list of twenty cards wants **one** place a sentence
 * can appear, near the thumb that just pressed something.
 *
 * ## The region is always in the DOM, and that is the whole mechanism
 *
 * An `aria-live` region that is *inserted* carrying its text is announced
 * unreliably — the announcement is a mutation of an existing region, so the
 * region has to exist first. The `<p role="status">` below therefore renders on
 * every paint of the list, empty, and only its text changes. The bubble's
 * chrome (background, padding, the close button) is what appears and vanishes.
 *
 * `role="status"` carries an implicit `aria-live="polite"`, which is spelled out
 * beside it so a reader of the markup does not have to know the mapping. Its
 * other implicit value, `aria-atomic="true"`, is **left implicit and wanted**:
 * a one-sentence region should be re-read whole. `signup-form.tsx` is the
 * opposite case and worth knowing about — it sets `aria-atomic="false"`
 * explicitly, because a confirmation block containing a *Copiar* → *Copiado*
 * button was being re-read in full on every flip.
 *
 * ## Position, and the trap next door
 *
 * `fixed`, so it is at the bottom of the **window** rather than the bottom of a
 * long list. That only works because this region renders as a **sibling** of
 * the list's `@container` wrapper and not inside it: `container-type:
 * inline-size` makes an element a containing block for `position: fixed`
 * descendants, which is the trap `components/sheet.tsx` documents and the reason
 * `radar-view.test.tsx` pins where that wrapper sits. A region nested inside it
 * would anchor to the bottom of the grid, which on a full page is off screen.
 *
 * `z-40` is the layer `sheet.tsx` names for a bar below the drawer's `z-50`,
 * and it is **already occupied**: `components/action-bar.tsx` ships on the
 * opportunity, triagem and preço screens at `sticky bottom-0 z-40`. D25 (3) is
 * done, and it is *sticky* rather than fixed on purpose — its own docstring
 * cites §4d for choosing a bar that reserves its own height over one whose
 * offset has to be restated everywhere.
 *
 * On the Radar list there is no `ActionBar`, so the two never meet and this
 * region is alone at the bottom of the window. **They would meet the moment
 * this region is reused on a screen that has one** — which is exactly what D66
 * proposes — and a `fixed` element does not participate in the flow a sticky
 * bar reserves, so it would land on the primary CTA whatever `bottom-*` says.
 * `ActionBar` is 69–144px tall depending on its contents, which a caller cannot
 * know. D66's row says so; do not lift this file without reading it.
 *
 * No `env(safe-area-inset-bottom)`, and that is measured rather than forgotten:
 * `action-bar.tsx` found it resolves to `0px` here because `app/layout.tsx`
 * declares no `viewportFit: 'cover'`.
 *
 * ## No timer
 *
 * It clears on the next press and on the close button, and otherwise stays.
 * A sentence that erases itself after some seconds is a sentence a slow reader
 * does not get, and a timer is browser-only behaviour that
 * `environment: 'node'` cannot test (CLAUDE.md §4c) in exchange for nothing.
 * `common.close` ("Fechar") is already approved, so the affordance costs no
 * string.
 */

const common = messages.common

/** Publish a sentence, or `null` to clear the one that is up. */
export type Announce = (message: string | null) => void

/**
 * A no-op by default, and that is a **silent** failure: a star rendered outside
 * the provider would announce into nothing with a green suite, which is the
 * "reachable and inert" shape CLAUDE.md lists five instances of, inverted.
 *
 * It is a no-op rather than a throw because the alternative is crashing a
 * reader's page over a developer's mistake. What holds the two together instead
 * is that the star and the region are gated on **the same condition** —
 * `Boolean(onFavourite)` in `radar-view.tsx` — and
 * `favourite-feedback.test.tsx` asserts both directions of it: the region is
 * there wherever the grid draws stars, and absent where it draws none.
 *
 * **D66 is the change that would break that pairing**, by rendering a star on a
 * second screen. Whoever does it moves the gate, not just the component.
 */
const NoticeContext = createContext<Announce>(() => {})

export function useFavouriteNotice(): Announce {
  return useContext(NoticeContext)
}

/**
 * Wraps the card grid, and renders the one region every star announces into.
 *
 * The region is a sibling of `children`, after it — see the docstring on why
 * that placement is load bearing rather than tidy.
 */
export function FavouriteNotices({
  active,
  listKey,
  children,
}: {
  /**
   * Whether this list draws stars at all — `Boolean(onFavourite)`.
   *
   * `false` renders the children and **nothing else**: the Landing's example
   * panel and the Radar's server fallback have no control that can fail, so they
   * must not grow a `fixed` element and an empty live region. A region that can
   * never be filled is the "a string nothing renders" shape in another costume.
   */
  active: boolean
  /**
   * Which list the sentence belongs to — `lib/radar/list-cache.ts`'s `listKey`,
   * the same string the snapshot is filed under.
   *
   * **A sentence outlives the list it was about, otherwise.** A group chip, a
   * sort and a filter are all `next/link`/`router.push` inside the same route
   * segment, so `RadarScreen` and this subtree stay mounted — and when the new
   * list restores from a fresh snapshot the status never leaves `ready`, so
   * `Body` keeps returning the grid branch and this provider is never
   * remounted. A visitor who pressed a star on *Compatíveis* would find *"Crie a
   * conta grátis"* still pinned to the window over *Verificar*, and it would
   * clear only if the new tab happened to be empty — inconsistent as well as
   * stale.
   *
   * Reset by the documented "adjust state when a prop changes" comparison
   * rather than an effect, because `environment: 'node'` runs no effects and the
   * reset would have been invisible to the unit suite (CLAUDE.md §4c).
   */
  listKey: string
  children: ReactNode
}) {
  const [notice, setNotice] = useState<string | null>(null)
  const [shownFor, setShownFor] = useState(listKey)
  const announce = useCallback<Announce>((message) => setNotice(message), [])

  if (shownFor !== listKey) {
    setShownFor(listKey)
    setNotice(null)
  }

  if (!active) return children

  return (
    <NoticeContext.Provider value={announce}>
      {children}
      <FavouriteNoticeRegion notice={notice} onClose={() => announce(null)} />
    </NoticeContext.Provider>
  )
}

/**
 * The region itself, with its text as a prop.
 *
 * Exported separately so the unit suite can assert what each sentence renders
 * as without a click: nothing clicks in `environment: 'node'`, so the state
 * machine is pinned in the browser (`e2e/journeys/favourite-feedback.spec.ts`)
 * and the markup is pinned here.
 */
export function FavouriteNoticeRegion({
  notice,
  onClose,
}: {
  notice: string | null
  onClose?: () => void
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-gutter pb-4">
      <div
        className={cn(
          'flex max-w-[420px] items-start gap-1',
          // The chrome, not the region, is what appears: see the docstring.
          notice === null ? undefined : 'pointer-events-auto rounded-card bg-ink py-1.5 pl-3.5',
        )}
      >
        {/* Always rendered, always `role="status"`, empty until something
            fails. This element is the announcement; everything around it is
            decoration. */}
        <p role="status" aria-live="polite" className="py-2 text-body leading-[1.4] text-on-ink">
          {notice}
        </p>
        {notice === null ? null : (
          <button
            type="button"
            onClick={onClose}
            aria-label={common.close}
            title={common.close}
            className="inline-flex size-touch shrink-0 items-center justify-center rounded-pill border-0 bg-transparent text-on-ink-muted transition-colors hover:text-on-ink"
          >
            <Icon name="close" size={18} />
          </button>
        )}
      </div>
    </div>
  )
}
