import type { ReactNode } from 'react'

import { Button } from './button'

/**
 * The action bar at the bottom of a tender screen (D25 (3)).
 *
 * ## Why it exists
 *
 * Sci's journey, 2026-09-29: *"the decision is below the fold"*. On a phone the
 * tender screen is the banner, the title, the badges, the deadline card, the
 * Objeto and then — somewhere past all of it — the one button the screen is
 * for. Every "Mostrar mais" in the Itens panel pushes it further away, so the
 * control that helps someone evaluate is the control that buries the action.
 * The bar takes the action out of the scroll.
 *
 * ## `sticky`, not `fixed` — and that is a correction, not a preference
 *
 * The card says "a fixed bottom action bar", and the first version was one:
 * `fixed` plus a `BAR_CLEARANCE` constant that every screen added to its
 * `main` so the bar covered nothing. **No such constant exists.** Measured on
 * the built page, this bar is between **69px and 144px** tall depending on
 * three things none of which the caller knows: whether there is a caption
 * (+23.5px), whether the primary's label wraps — "Ver a triagem que você
 * pediu" wraps at 360px and below, +32px — and the viewport width itself
 * (+12.5px at 320px). `pb-28` is 112px, so a returning signed-in reader on a
 * 360px Android had the last 12.5px of the page under the bar, and 32px at
 * 320px. A bigger number would only move the width at which it is wrong.
 *
 * `sticky bottom-0` removes the arithmetic instead of restating it. A sticky
 * element stays **in the flow**, so it reserves exactly its own height,
 * whatever that turns out to be, at every width and in every state — and it
 * still pins to the bottom of the viewport while the page scrolls under it.
 * Nothing can be covered, so there is nothing to measure and no constant to
 * get wrong later. This is CLAUDE.md §4d: when the limit turns out not to
 * exist, change the shape.
 *
 * It requires only that the caller render it as the **last child of the
 * `min-h-dvh` column**, after `<main>` — which is where all three screens put
 * it, and where `main`'s own `grow` keeps it at the bottom of a short page.
 *
 * ## Stacking
 *
 * `z-40`, which `components/sheet.tsx` reserved for exactly this: the drawer
 * is `z-50` and must stay over the bar, and the only other `z-` in `app/` and
 * `components/` is a skip link's `focus:z-10`. So the whole stack is three
 * numbers and they are all written down. A sticky element paints over the
 * content scrolling beneath it, which is the part `fixed` was wanted for.
 *
 * ## It renders at every width, and that is new
 *
 * It used to be `lg:hidden`, for a reason that no longer exists: a **fixed**
 * bar is positioned against the viewport, and at `lg` the rail takes 56px or
 * 264px of *layout* whose state is `localStorage`, so no left edge was correct
 * in both and no media query could read which one it was in. A **sticky** bar
 * sits inside the column and is laid out by it, so the rail is not its problem
 * in either state.
 *
 * With the breakpoint gone the screens keep **one** call to action instead of
 * two. Sci, 2026-09-30, looking at the edital screen: *"the CTA is at the
 * bottom so this CTA is not more necessary… both CTA jump to the same
 * location, and the button at the bottom is the primary cta."* The in-page
 * buttons are deleted rather than hidden, which also ends the duplicate
 * accessible names the bar had introduced below `lg`.
 *
 * ## What is deliberately not here
 *
 * `env(safe-area-inset-bottom)`. The first version padded by it, with a
 * comment about the iPhone home indicator — and `app/layout.tsx` sets no
 * `viewportFit: 'cover'`, so the variable is `0px` (measured) and the rule did
 * nothing. Without `cover` the browser insets the viewport itself and the
 * indicator never overlaps the page, so there is nothing to correct. If
 * `cover` is ever wanted, the inset belongs in the same change.
 */

export type BarAction = {
  label: string
  href: string
}

export function ActionBar({
  primary,
  secondary = null,
  caption = null,
}: {
  /** The next thing to do on this screen. The verb changes by state. */
  primary: BarAction
  /** The other place worth going from here, or nothing. */
  secondary?: BarAction | null
  /**
   * D25 (4): the count of triagens left, **under** the button.
   *
   * Never inside the label. A primary action that is also a status readout
   * resizes under itself as the number changes, and it cannot be translated —
   * the label and the count are two sentences with two different plural rules.
   *
   * A node rather than a string: the count lives behind a client boundary of
   * its own (`components/screenings-left.tsx`), because these views are
   * rendered by a server component as well as a client one, and a client hook
   * called from the shared one is a runtime error no unit test here can see.
   * `null`, and a component that renders `null`, both produce no caption —
   * which is what an unlimited plan, a missing summary and the server pass
   * all produce.
   */
  caption?: ReactNode
}) {
  return (
    <div className="sticky bottom-0 z-40 border-t border-line bg-surface">
      <div className="mx-auto flex w-full max-w-[960px] flex-col gap-1 px-gutter py-2.5">
        <div className="flex items-center gap-2">
          {/* `grow` on the primary and intrinsic width on the secondary: at
              390px that is a full-width-feeling action beside a word, rather
              than two half-width buttons neither of which reads as the one to
              press.

              `min-w-0` lets a long label **wrap** rather than be truncated —
              `Button`'s base has no `truncate` and no `whitespace-nowrap`, so
              wrapping is what happens and the bar simply gets taller. That is
              safe now that the bar reserves its own height; under the `fixed`
              version it was the 32px that made the clearance wrong. */}
          <Button href={primary.href} className="min-w-0 grow" iconEnd="arrowRight">
            {primary.label}
          </Button>
          {secondary === null ? null : (
            <Button href={secondary.href} variant="secondary" className="shrink-0">
              {secondary.label}
            </Button>
          )}
        </div>
        {caption}
      </div>
    </div>
  )
}
