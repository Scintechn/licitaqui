import type { Metadata } from 'next'
import { getImageProps } from 'next/image'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { Button, Card, CardRow, Icon, Logo, SectionLabel, Status, TagList } from '@/components'
import type { IconName } from '@/components'
import { cn } from '@/lib/cn'
import { messages } from '@/lib/messages'
import radarPreviewMobile from './radar-preview-mobile.png'
import radarFull from './radar-full.png'
import radarPreview from './radar-preview.png'
import { SignupButton, SignupSheet, SignupTextButton } from './signup-sheet'

/**
 * `/fundadores` — the founders offer page (task D2).
 *
 * A port of `paginas/oferta_fundadores.html`, which is the approved copy and
 * layout. Two deliberate differences from that file:
 *
 *  1. the "Prévia" banner is gone (the card asks for it: the page is real now);
 *  2. the form's fake success block is gone with it — the confirmation screen
 *     belongs to task F1, together with the endpoint that would earn it.
 *
 * Everything else is transcribed section by section, in the same order, with
 * the same breakpoints (560px and 900px) as the source stylesheet.
 */

const page = messages.foundersPage

/**
 * The three sections the sticky header links to.
 *
 * Ids in English, like every other identifier in this repository
 * (`CLAUDE.md`) — an anchor is code, even though it shows in the address bar.
 * The labels beside them are the sections' own approved eyebrows, so the
 * header invents no copy: `nav` holds three strings and none names a section.
 */
/**
 * Exported for `page.test.tsx`, which asserts the header's in-page anchors are
 * this exact set rather than a count — a count passes when one anchor is
 * swapped for another, which is the likeliest accident here.
 */
export const ANCHORS = {
  pillars: 'tool',
  screening: 'screening',
  faq: 'faq',
} as const

const NAV_LINKS = [
  { id: ANCHORS.pillars, label: page.pillars.label },
  { id: ANCHORS.screening, label: page.screening.label },
  { id: ANCHORS.faq, label: page.faq.label },
]

export const metadata: Metadata = {
  title: page.meta.title,
  description: page.meta.description,
  alternates: { canonical: '/fundadores' },
  openGraph: {
    type: 'website',
    locale: 'pt_BR',
    siteName: messages.brand.name,
    title: page.meta.title,
    description: page.meta.description,
  },
}

/**
 * Spec §3.3: public pages render statically and revalidate every 10–30 min.
 * Nothing on this page is per-visitor, so it is served from the CDN and rebuilt
 * at most every half hour.
 */
export const dynamic = 'force-static'
export const revalidate = 1800

/* ------------------------------------------------------------------ layout */

/** The source's `.wrap`: one 1120px column with the 20px gutter. */
function Wrap({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('mx-auto w-full max-w-[1120px] px-gutter', className)}>{children}</div>
  )
}

/**
 * The public-page rhythm, **48 / 64 / 80** on `/fundadores` since 2026-09-24.
 *
 * This is a local `Section`, and it now diverges from `app/(public)/
 * page-parts.tsx`, which is shared with the Landing and stays at 40/48. Sci
 * stepped the shared one down to 40/48 earlier in the week and has chosen to
 * step this page back up knowing that — the divergence is deliberate and is
 * recorded in the PR. The shared file is not edited here: `CLAUDE.md`'s
 * parallel-lane rule, and a rhythm change on the Landing is not this card.
 */
function Section({
  children,
  ground = 'ivory',
  id,
  labelledBy,
  className,
}: {
  children: ReactNode
  /**
   * The full-bleed ground this section paints, alternating down the page.
   *
   * Sci, 2026-09-24: *"between the section, the background color is the same —
   * when I said increase the contrast it is about this."* The hairline that was
   * doing the work measures **1.22:1**, and no ground dark enough to read as a
   * boundary on its own is available: a fill at ~1.20:1 against Ivory drags
   * `--color-muted` body text to **4.12:1**, under AA. So no token was added.
   *
   * What makes a 1.07:1 change read anyway is that it is *full-bleed* — a
   * continuous straight edge across the whole viewport, which the eye resolves
   * far below the ratio it needs for a patch. That is why this is on the
   * `<section>` and not on `Wrap`.
   *
   * **The `border-t border-line` hairline is gone, and so are `divided` and
   * `attached` with it.** A rule *and* a ground change at the same edge is
   * belt and braces and reads as chrome — and because the grounds alternate,
   * **every** boundary on this page is a ground change, so there is no edge
   * left for a rule to do work at. The first attempt kept the rule on the
   * ivory sections and gated it `divided && ground === 'ivory'`, which drew
   * exactly the doubled edge it was written to remove, at four of the eight
   * boundaries; its test looked only at the muted sections and so could never
   * fail. `attached` went at the same time: it had no call site anywhere.
   *
   * **`fill-muted` and not `surface`, measured.** `surface` is white, and it
   * was tried first: three of the eight sections — the promises band, the
   * price chain and the closing offer — carry a white panel of their own, and
   * on a white ground those panels vanished into it, leaving only a 1.55:1
   * hairline. `fill-muted` is the same order of change against Ivory
   * (**1.082:1**, against `surface`'s 1.066:1) so the full-bleed edge reads at
   * least as well, and it puts the panels *above* their ground instead of
   * inside it. Both are existing tokens; no new one was added, and none could
   * be — a fill dark enough to read as a boundary on its own drags
   * `--color-muted` body text to 4.12:1, under AA.
   */
  ground?: 'ivory' | 'muted'
  /**
   * The target of a header anchor. `scroll-mt-20` comes with it: the header is
   * sticky and 64px tall, so a bare `#id` jump parks the heading underneath it.
   */
  id?: string
  /**
   * The id of the element naming this section, for the one section that has no
   * `<h2>` — the promises band, whose heading (`pillars.title`) is orphaned by
   * Sci's decision. A landmark that a nav link points at and that announces as
   * a bare "section" is worse than no landmark; this names it with the eyebrow
   * already on screen rather than with new copy.
   */
  labelledBy?: string
  className?: string
}) {
  return (
    <section
      id={id}
      aria-labelledby={labelledBy}
      className={cn(
        'py-12 min-[560px]:py-16 min-[900px]:py-20',
        id && 'scroll-mt-20',
        ground === 'muted' && 'bg-fill-muted',
        className,
      )}
    >
      {children}
    </section>
  )
}

function H2({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h2
      className={cn('font-display text-section font-bold tracking-[-0.01em] text-balance', className)}
    >
      {children}
    </h2>
  )
}

function H3({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h3
      className={cn(
        'font-display text-subsection font-bold tracking-[-0.01em] text-balance',
        className,
      )}
    >
      {children}
    </h3>
  )
}

/** `.secao-cab` — eyebrow, heading and an optional standfirst, max 720px wide. */
function SectionHead({
  label,
  title,
  children,
  aside,
  wideAside = false,
  asideAlign = 'start',
  className,
}: {
  /**
   * Optional, and mostly should be omitted.
   *
   * A 12px tracked uppercase mono line above a 26px display heading only
   * earns its place when it says something the heading does not — scoping the
   * price to founders, naming the commodity a chart is about, labelling a
   * table that has no heading of its own. Six of the nine on this page just
   * restated the heading below in worse type, the clearest being "PERGUNTAS"
   * above "Antes de reservar" in a section that is visibly a list of
   * questions. Those are gone.
   */
  label?: string
  title: string
  children?: ReactNode
  /**
   * Opt-in second column: heading on the left, this on the right.
   *
   * The default is one 720px stack with the section's content dropped
   * underneath it, and on a 1120px page that leaves every `<h2>` on a measure
   * nearly twice the width its type was drawn for — `--text-section` tops out
   * at 38px, so a two-line heading spans ~700px and reads as a caption over a
   * wide empty band. Pass `aside` and the heading takes ~45% of the row while
   * the section's supporting material takes the rest: the same 38px then wraps
   * to three tight lines in a ~500px measure, which is where it has presence.
   *
   * **The type scale is unchanged.** The heading only looks larger because the
   * column is narrower; `--text-section` is the same token either way.
   *
   * One column again below 900px — the same breakpoint the hero, the price
   * chain and the screening example already collapse at, so the whole page
   * becomes a single column at one width rather than four.
   */
  aside?: ReactNode
  /**
   * Widens the `aside` column from 55% to 62% of the row.
   *
   * The default split is a *measure* decision: ~45% keeps a 38px `<h2>` on a
   * ~500px line, which is where it has presence. One section's aside is not
   * text, though — the price chain is four boxes in a row, and a row has a
   * width it either has or has not got. Measured, in IBM Plex Mono at the
   * sizes the chain uses: `R$ 14,60` at `--text-stat` is **163px** and the
   * three quiet values are **87px**, so with 16px of padding a side and three
   * 16px gaps the row needs **600px**. The default aside is 567px at the
   * page's maximum width — 33px short, which is why the chain was stacking.
   * At 62% it is 640px and the row fits with 40px to spare.
   *
   * The heading keeps a 392px measure at full width, which this particular
   * heading ("Parecia lucro. Era prejuízo.") sits inside comfortably: its
   * longest line is 266px at 38px.
   */
  wideAside?: boolean
  /**
   * Bottom-align the aside instead of top-aligning it.
   *
   * `items-start` is right when the aside is *content* — `Screening`'s edital
   * panel is taller than its heading and has to begin where the heading
   * begins. It is wrong when the aside is a **standfirst**: a three-line
   * paragraph pinned to the top of a four-line heading leaves a hole under it
   * and reads as something that failed to load, which is what Sci saw in
   * `Pain` ("the position on that. We can do better").
   *
   * Bottom-aligned, the paragraph's last line sits level with the heading's
   * last line, so the two blocks share a baseline and the whitespace moves
   * above the paragraph where it belongs — as air over a short column rather
   * than a gap under a stranded one.
   *
   * Only below 900px is this moot: one column, and the paragraph follows the
   * heading anyway.
   */
  asideAlign?: 'start' | 'end'
  className?: string
}) {
  const head = (
    <>
      {/* `accent` (blue) rather than `muted`, on Sci's instruction, 2026-09-24.
          Every eyebrow this renders sits on Ivory, where `--color-blue`
          measures **5.78:1** — AA for normal text at the 12px `caption` size,
          with room to spare (`styles/contrast.test.ts` pins it).

          It is a prop and not a `text-blue` in `className`: `lib/cn.ts` is a
          plain join, so a colour utility from the caller would sit beside
          `SectionLabel`'s own and be settled by stylesheet order — which is how
          an eyebrow shipped graphite once already.

          The two eyebrows inside the brand-blue offer panel do not come
          through here; they stay `tone="inverse"`, because `accent` there is
          blue on its own background. */}
      {label ? (
        <SectionLabel tone="accent" size="caption">
          {label}
        </SectionLabel>
      ) : null}
      <H2>{title}</H2>
      {children}
    </>
  )

  if (!aside) {
    return <div className={cn('flex max-w-[720px] flex-col gap-3', className)}>{head}</div>
  }

  return (
    <div
      className={cn(
        'grid grid-cols-1 gap-x-12 gap-y-6 [&>*]:min-w-0',
        asideAlign === 'end' ? 'min-[900px]:items-end' : 'items-start',
        wideAside
          ? 'min-[900px]:grid-cols-[minmax(0,0.38fr)_minmax(0,0.62fr)]'
          : 'min-[900px]:grid-cols-[minmax(0,0.45fr)_minmax(0,0.55fr)]',
        className,
      )}
    >
      <div className={cn('flex flex-col gap-3', wideAside ? 'max-w-[440px]' : 'max-w-[500px]')}>
        {head}
      </div>
      <div>{aside}</div>
    </div>
  )
}

/** `.fonte` — the provenance line under a figure. */
function Source({ children, className }: { children: ReactNode; className?: string }) {
  // 13px, not 12px. These name where a figure came from — they are trust
  // signals, and the quietest text on the page was carrying them.
  return <p className={cn('text-meta leading-[1.55] text-muted', className)}>{children}</p>
}

/* -------------------------------------------------------------------- hero */

/**
 * The hero: the argument on the left, the product on the right.
 *
 * The form used to sit in column two, which made the first screen a headline
 * and a set of five inputs. The approved draft gives that column to a wide
 * shot of the Radar and puts the ask behind a call to action: the form opens
 * as a dialog (`signup-sheet.tsx`), from here and from the three other CTAs on
 * the page.
 *
 * Two calls to action, because they answer different readers. The primary one
 * opens the form. The secondary is a real link to `/radar` — the product is
 * public and free to try, and a visitor who wants to see it working rather
 * than read about it should not have to give a WhatsApp number first. Its
 * label is `account.screen.radar`, an approved string reused; see the PR for
 * the note that a `foundersPage` key of its own would read better.
 *
 * **Both images are decorative and their `alt` is empty on purpose.** The
 * headline and the subtitle beside them already say what the product does; a
 * description of the screenshot would be new user-facing copy, and copy on
 * this page is Sci's under the legal brief.
 *
 * ## The proportions, and why they changed (2026-09-24)
 *
 * Sci, at ~1270px: *"the proporcional is not right"* — the `<h1>` wrapped to
 * **five lines at 60px** while the shot sat at **464px** beside it, so the
 * headline read as the page and the product read as a footnote.
 *
 * The two levers pull against each other: narrowing the text column to widen
 * the shot *adds* headline lines at a fixed size. `text-wrap: balance` gives
 * the minimum line count for a measure, and measured on this string that
 * minimum is four lines only from about **11.4em** of measure — 464px needs
 * the headline at 40px, 568px at 48px. So both moved, together:
 *
 *  - **`--text-hero`'s clamp steps down to `clamp(2.125rem, 3.6vw, 2.5rem)`**
 *    (34 → 40px, at its cap from 1112px up). Not a new token: this is the
 *    page's one `<h1>` and the only thing `--text-hero` dresses. 60px was
 *    sized for a headline that had the wider half of the row; at 40px the
 *    same sentence lands in four lines on 464px and the block is 163px tall
 *    against the shot's 356px, where it used to be 306px against 291px.
 *  - **The grid splits in two steps, not one.** From 900px it is even
 *    (`1fr 1fr`, 32px gap): below 1120px the `Wrap` is viewport-bound and
 *    both columns are already tight, and the subtitle needs ~440px to hold
 *    four lines. From 1120px the `Wrap` is fixed at 1120 and there is room to
 *    favour the shot: `0.85fr 1.15fr` with the 48px gap, which is 439/593.
 *
 * Sci's stated budget was *"the content below can be in 4 lines"* — the
 * subtitle runs to four at 1280, 1120 and 900, and the headline to four at
 * all three.
 *
 * **`0.85/1.15` is the end of this lever, measured.** One notch further
 * (`0.82/1.18`) buys the shot 16px and costs the headline its fifth line;
 * `0.78/1.22` costs the subtitle one as well. The shot's remaining size is
 * bounded by `Wrap`'s 1120px measure, not by the split — at a 1280px measure
 * the same `0.85/1.15` would draw it at 685×428 with the headline still on
 * four lines, but the hero would then sit 80px wider a side than the sticky
 * header and every section under it. That is a page-wide decision, and it is
 * in the PR for Sci rather than taken here.
 *
 * ## Two sources, one download
 *
 * The 1800×1125 desktop shot is a three-column app UI; rendered below about
 * **500px** it stops being a screenshot and becomes texture — measured on the
 * asset itself, where 700px and 520px still read and 400px does not. In the
 * one-column layout the shot is drawn at `100vw − 40px`, so 500px of it is a
 * **540px viewport**: that is the breakpoint, and it is where the phone shot
 * (`radar-preview-mobile.png`, 780×1688, the Radar at native 2×) takes over.
 * Not a round number — the number legibility gives.
 *
 * `<picture>` with a `<source media>` rather than two `next/image` elements
 * toggled with `hidden`: a `display:none` `<img>` is still fetched by Chrome,
 * so the `hidden` pair ships both files at every viewport. `<picture>` selects
 * exactly one, and `e2e/journeys/fundadores.spec.ts` counts the requests
 * rather than trusting this paragraph.
 *
 * `getImageProps` is Next's own art-direction recipe (`next/image` docs, "Art
 * direction"): both sources still go through the optimiser with a `sizes` that
 * names the box each is actually drawn in. One difference from the `<Image>`
 * it replaces, stated plainly: there is **no** `<link rel=preload>`, because a
 * preload cannot be made viewport-conditional without fetching both files.
 * The shot is eager and high priority; it is discovered by the parser instead
 * of by the preload scanner.
 *
 * The aspect ratio is set in CSS at the same breakpoint, not left to the
 * `width`/`height` attributes: those come from the mobile source (the `<img>`
 * fallback), so on a desktop viewport the reserved box would be 780/1688 until
 * the bytes land and 1180/1120 after — a hero-sized layout shift.
 *
 * ## Why the desktop shot is a crop and not the whole screen
 *
 * It was the full 2880×1800 Radar, and Sci said three times that it looked
 * blurred and small. It was neither compressed nor low-resolution — `q=90` and
 * a 2880px master were both already in place. It was **scale**: 2880px at 2×
 * is a 1440 logical-pixel application, and the hero shows it at 593px. That is
 * 0.41×, so the app's 13px text rendered at about 5px. No source resolution
 * fixes a UI shrunk to a third of the size it was drawn at.
 *
 * So the shot is now a 1180×1120 crop of that master — 590 logical pixels wide,
 * displayed at 593, which is **1.01×**. The app's text renders at its own size
 * and is genuinely readable. What the crop keeps is the argument: the
 * compatibility read-out with its page references, and `PREÇO-ALVO DE COMPRA ·
 * R$ 14,60` with the sentence that defines it (brief §2.2 rule 3). What it
 * loses is the sidebar and the left half of the list, which were decoration at
 * this size and illegible anyway.
 */
function Hero() {
  const { hero } = page
  const shot = productShot()
  return (
    <div className="pt-7 pb-14">
      <Wrap className="grid items-center gap-8 [&>*]:min-w-0 min-[900px]:grid-cols-2 min-[900px]:gap-x-8 min-[1120px]:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] min-[1120px]:gap-x-12">
        <div className="flex flex-col gap-[22px] pt-3">
          <span className="inline-flex items-center gap-2 self-start rounded-badge bg-attention-soft px-2.5 py-1.5 font-mono text-caption font-medium tracking-[0.06em] text-attention uppercase">
            <span aria-hidden className="inline-block size-[7px] rounded-pill bg-attention" />
            {hero.badge}
          </span>

          <h1 className="font-display text-hero font-extrabold tracking-[-0.01em] text-balance">
            {hero.title}
          </h1>

          <p className="max-w-[34em] text-intro text-ink-soft">{hero.subtitle}</p>

          {/* The two things to do, from the first screen: reserve a seat, or
              go and use the thing. Both labels are catalogue strings —
              `founders.offer.cta` is the same ask the offer panel and the
              form's own submit carry, and `account.screen.radar` is the
              existing "Ir para o Radar". Nothing new is written here.

              Stacked and full width below 560px, primary first: on a phone a
              row of two would give each about 150px. */}
          <div className="mt-1 flex flex-col gap-3 min-[560px]:flex-row min-[560px]:items-center">
            <SignupButton
              className="w-full min-[560px]:w-auto"
              label={messages.founders.offer.cta}
            />
            <Button variant="outline" href="/radar" className="w-full min-[560px]:w-auto">
              {messages.account.screen.radar}
            </Button>
          </div>
        </div>

        {/* `w-full` inside a `min-w-0` grid child: the intrinsic 1800px never
            becomes the column's minimum, which is the shape that put the brand
            panel past the viewport at 440px two days ago. The phone shot is
            capped at its own native 390px and centred, so that between 430 and
            540px it reads as a device rather than as a stretched poster. */}
{/*
          **Two layers, because one flat image cannot be both at 593px.**

          The whole Radar is 1440 logical px of application. At 593 that is
          0.41x and its 13px text renders at ~5px: recognisable as a product,
          unreadable as one. A 1:1 crop is the opposite — every word legible,
          but it reads as a torn fragment. Sci hit both in turn, and they are
          not a matter of taste: they are the arithmetic of putting a 1440px UI
          in a 593px box.

          So the base carries the silhouette and the inset carries the content.
          A reader recognises an application from the sidebar and the three
          columns without reading a word, then reads `R$ 14,60`, the four
          compatibility checks and their page references at full size beside it.

          The inset is cut to 344 logical px because that is what 58% of 593
          is — the crop is sized to the box, not the box to the crop, which is
          what makes it exactly 1:1 rather than approximately.

          Below 540px neither renders: the phone shot does, at its own native
          size, where the question does not arise.
        */}
        {/*
          **A link, not a lightbox.** Sci asked whether tapping the shot should
          expand it. Someone who clicks a product screenshot is asking to see
          more of the product — and the better answer to that is their own
          editais, live, which is what `/radar` is. A 2x JPEG is not.

          `aria-hidden` with `tabIndex={-1}`: the "Ir para o Radar" button a few
          pixels away is already the accessible control for this exact action,
          so a second one would add a duplicate tab stop and announce the same
          destination twice. This is a mouse convenience over decorative
          artwork (`alt=""`), and it is deliberately invisible to the keyboard
          and to assistive technology rather than half-exposed to them.

          Not a dialog, which is the other thing it could have been: that needs
          a real accessible name, a role, a focus trap and an Escape — and a
          label string, which is Sci's to write. The cost is not the `Sheet`;
          it is the copy and a third interactive element in a hero whose whole
          job is two actions.
        */}
        <Link
          href="/radar"
          aria-hidden
          tabIndex={-1}
          className="relative mx-auto block w-full max-w-[390px] no-underline min-[540px]:max-w-none">
          <picture>
            <source media={SHOT_DESKTOP_MEDIA} srcSet={shot.baseSrcSet} sizes={shot.baseSizes} />
            <img
              {...shot.img}
              alt=""
              className="aspect-[780/1688] w-full rounded-feature border border-line object-cover shadow-[0_24px_50px_-36px_rgba(23,23,23,0.45)] min-[540px]:aspect-[1600/1000]"
            />
          </picture>

          {/*
            Its own `<picture>` with a transparent fallback rather than an
            `<img>` hidden by CSS: `hidden` stops it being painted and not
            being fetched, so a phone would pay for a desktop-only crop. With
            no matching `<source>` below 540px the 70-byte pixel loads instead.

            `aria-hidden`: a second view of the same decorative screenshot
            (`alt=""`) — announcing it would add an empty image to the reading
            order.
          */}
          <picture aria-hidden className="absolute right-[-3%] bottom-[-6%] block w-[58%]">
            <source media={SHOT_DESKTOP_MEDIA} srcSet={shot.insetSrcSet} sizes={shot.insetSizes} />
            <img
              src={TRANSPARENT_PIXEL}
              alt=""
              loading="eager"
              decoding="async"
              className="hidden aspect-[688/620] w-full rounded-card border border-line object-cover shadow-[0_18px_44px_-20px_rgba(23,23,23,0.5)] min-[540px]:block"
            />
          </picture>
        </Link>
      </Wrap>
    </div>
  )
}

/**
 * Where the desktop shot stops being legible: see `Hero`'s docstring. Kept as
 * one constant because the `<source media>` and the CSS aspect ratio have to
 * switch on the same number — two sources agreeing by coincidence is how a
 * hero ends up drawing one image inside the other's box.
 */
/**
 * A 1x1 transparent GIF, 70 bytes inline.
 *
 * It is the inset `<picture>`'s fallback `<img src>`, so a phone does not
 * download a desktop-only crop it will never see. `hidden` stops an image
 * being painted, not fetched — the two are routinely confused, and confusing
 * them here would undo the art direction it sits inside.
 */
const TRANSPARENT_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

const SHOT_BREAKPOINT = 540
const SHOT_DESKTOP_MEDIA = `(min-width: ${SHOT_BREAKPOINT}px)`

/**
 * The two `<source>`s of the hero shot, each with the `sizes` of the box it is
 * actually drawn in — measured, not guessed. `Wrap` is `min(vw, 1120)` with a
 * 20px gutter a side:
 *
 *   ≥1120px   two columns, 0.85fr/1.15fr, 48px gap → (1120 − 40 − 48) × 0.575 = 593px
 *   900–1119  two columns, 1fr/1fr, 32px gap       → (100vw − 40 − 32) / 2
 *   540–899   one column                            → 100vw − 40
 *   <540      one column, the phone shot, capped at its native 390px
 *
 * A `sizes` that over-claims is not free: a `52vw` guess here once fetched the
 * 1080px variant for a 464px box and, with `priority`, preloaded it as the LCP
 * resource. That argument is about the **box**, so replacing the 1800px master
 * with the untouched 2880×1800 original did not change any number above — what
 * it changed is which variants exist to be chosen from, and how sharp the
 * chosen one is.
 */
function productShot() {
  /*
   * **`loading: 'eager'` + `fetchPriority: 'high'`, not `priority`.**
   *
   * `priority` is deprecated in Next 16 in favour of `preload`, and through
   * `getImageProps` it set *neither* attribute on the emitted `<img>` — no
   * `loading`, no `fetchpriority`. The shot was therefore eager only by the
   * browser's default and was never marked high priority. These two say it in
   * the spelling Next 16 uses, and `page.test.tsx` asserts both.
   *
   * `preload` is deliberately left off. Next's own guidance says not to use it
   * "when you have multiple images that could be considered the LCP element
   * depending on the viewport", which is exactly what art direction is: a
   * `<link rel=preload>` cannot be made viewport-conditional without fetching
   * both files, and one download is the hard requirement here.
   */
  const common = { alt: '', loading: 'eager', fetchPriority: 'high' } as const

  /*
   * The base layer: the whole screen, whose job is the silhouette. Deliberately
   * **not** `quality: 90` — at 0.41x nothing in it is legible at any quality, so
   * the bytes would buy sharpness no reader can resolve. The budget goes to the
   * inset, which is the layer anybody reads.
   */
  const {
    props: { srcSet: baseSrcSet, sizes: baseSizes },
  } = getImageProps({
    ...common,
    src: radarFull,
    sizes: '(min-width: 1120px) 593px, (min-width: 900px) calc(50vw - 36px), calc(100vw - 40px)',
  })

  /* The inset: the crop, drawn at 58% of the base and cut so that 58% is 1:1. */
  const {
    props: { srcSet: insetSrcSet, sizes: insetSizes },
  } = getImageProps({
    ...common,
    src: radarPreview,
    /*
      **`quality={90}`, not the default 75.** 75 is tuned for photographs, and
      this is a screenshot of a UI whose smallest type is about 11px: at 75 the
      chrominance subsampling and the quantiser visibly mush exactly the glyph
      edges that make it read as a product rather than as a texture. Sci,
      2026-09-24: *"the head image still blur"*. The mobile shot stays at the
      default — it is drawn at its own native size, so nothing is being
      resampled into it.
    */
    quality: 90,
    // 58% of the base box, which is what the CSS draws it at. Claiming the
    // base's width here would fetch a variant nearly twice the box — the exact
    // over-claim the docstring above warns about.
    sizes: '(min-width: 1120px) 344px, (min-width: 900px) calc(29vw - 21px), calc(58vw - 23px)',
  })
  const {
    props: { ...img },
  } = getImageProps({
    ...common,
    src: radarPreviewMobile,
    sizes: '(min-width: 430px) 390px, calc(100vw - 40px)',
  })
  return { baseSrcSet, baseSizes, insetSrcSet, insetSizes, img }
}

/* ------------------------------------------------------------------- band */

/**
 * The four promises, under the hero, as one panel.
 *
 * This is the hero's old bullet list and the old `Pillars` section, which were
 * the same four claims rendered twice about ten thousand characters apart —
 * card **D12**. The draft has one band and no separate four-card section, so
 * there is one: the bullets' titles, the section's bodies, and the section's
 * plan attributions, each string rendered exactly once and a test that holds
 * it there.
 *
 * **One catalogue array now, not two paired by position.** Both the title and
 * the body come from `pillars.items[i]`, which Sci rewrote on 2026-09-24 into
 * four shorter pairs. It used to take the title from `hero.promises[i]` and
 * only the body from here, which is why those four promise strings are now
 * rendered nowhere — carded in `DEVELOPMENT_PLAN.md` §5 **D14**, not deleted,
 * because the wording is Sci's under the legal brief.
 *
 * **`item.plan` is no longer rendered**, on Sci's instruction. The four
 * strings stay in `messages/pt-BR.json` for the same reason, and are on the
 * same card.
 *
 * **No heading of its own.** It sits above the page's first `<h2>`, so an
 * `<h3>` per cell would take the document from `h1` straight to `h3`; the
 * titles are `<b>`, the idiom `FounderValue` already uses for a bold lead-in.
 *
 * **An icon per cell, not four copies of one tick.** Sci, 2026-09-24: the
 * repeated check said nothing about which cell it sat on. It is drawn in the
 * tinted rounded square `Pain`'s numbered cards already use, rather than in a
 * second icon frame invented for this one band.
 *
 * `id` is the header's `#tool` anchor, which used to point at `Pillars`; the
 * nav's label for it is `pillars.label`, and this is now the section it names.
 *
 * `role="list"`: Tailwind v4's preflight sets `list-style: none`, and Safari
 * drops the list semantics along with the marker.
 */
/**
 * One icon per cell, in the band's order: the CNAE match, the AI reading with
 * its page reference, the price ceiling, the Telegram alerts. All four names
 * are on the design-system board (`components/icon.tsx`).
 *
 * **Not the retired `Pillars` pairing** (`search · tender · money`). `Pain`
 * leads with exactly those three, in that order, one scroll below this band
 * and in an identical blue square — the strongest "these are the same thing"
 * signal on the page. `company` says *your* firm, which is what matching a
 * CNAE is about, and `margin` is what this cell's copy says in as many words
 * (*"manter sua margem de lucro"*). That last swap is the code's own argument
 * running the other way: `PAIN_ICONS` chose `money` over `margin` because the
 * problem there is losing money on a contract rather than reading a margin
 * sheet — which leaves `margin` free for the cell that *is* the margin sheet.
 * Three glyphs of overlap become one.
 *
 * Typed `IconName[]`, so a rename in the icon set is a typecheck failure here
 * rather than an empty square on the page taking sign-ups.
 */
/** The band's eyebrow, which is also the section's accessible name. */
const BAND_LABEL_ID = 'tool-label'

const BAND_ICONS: readonly IconName[] = ['company', 'tender', 'margin', 'alert']

function Promises() {
  const { pillars } = page
  return (
    <Section id={ANCHORS.pillars} ground="muted" labelledBy={BAND_LABEL_ID}>
      <Wrap>
        {/* The only section on the page that used to open with nothing: no
            eyebrow, no heading. `pillars.label` already renders in the header's
            anchor nav — this introduces no copy. The `<h2>` it used to have
            (`pillars.title`) stays orphaned under D14, by Sci's decision.

            It carries the section's accessible name instead, through
            `aria-labelledby`: the header's *"O que você vai usar"* link lands
            here, and a landmark a nav points at with no name announces as a
            bare "section". No new string — the same eyebrow, referenced. */}
        <div id={BAND_LABEL_ID} className="mb-6">
          <SectionLabel tone="accent" size="caption">
            {pillars.label}
          </SectionLabel>
        </div>

        {/*
          One panel, not four cards. The four are a single claim — *da busca à
          proposta* — and four bordered surfaces make them compete, each with
          its own edge and its own shadow of white against the ivory.

          Gaps are zero, so the dividers are borders on the items themselves,
          and which edge they sit on depends on how many columns there are:

            <560px   one column   → a rule above every item but the first
            560px    two columns  → a rule left of the right-hand items (1, 3)
                                    and above the second row (2, 3)
            1120px   four columns → a rule left of every item but the first

          **Four across from 1120px, not from 900.** Sci wants the four on one
          line and this is the width at which that is readable: the four-up
          measure is ~221px there (about 28 characters), against **166px — 21
          characters** at 900, which is what the row used to do and is why the
          cells read as cramped. Between 560 and 1119 it stays 2×2, so the
          21-character tier does not exist at any width.

          Padding cannot rescue a measure here and makes it worse: the cells
          have no gap, so the padding *is* the gutter and every 4px added costs
          8px of measure. That is why it stops at `p-7`: a `p-8` step at 1120
          was specified while 1120 was still a *two-column* tier with a 475px
          measure, and on the four-up row it applies to the narrowest cells on
          the page — 206px of measure against 214px.

          `p-7` rather than `Pain`'s `p-6` for the same reason: the gap from
          one cell's copy to its neighbour's is twice the padding here, where
          the numbered cards have a real gap between them. At `p-6` that
          measured 41px against `Pain`'s 58px; `p-7` makes it 57px.

          A tier only ever *clears* a rule a lower tier set; it never sets one
          the same variant also clears. `min-[560px]:border-t` and
          `min-[560px]:border-t-0` are the same property under the same media
          query, settled by stylesheet order rather than by the order they are
          written here — which is why the rule between the two rows was missing
          the first time round, at 560–899px only, on a tier nobody screenshots.
        */}
        <ul
          role="list"
          className="grid grid-cols-1 overflow-hidden rounded-panel border border-line bg-surface min-[560px]:grid-cols-2 min-[1120px]:grid-cols-4"
        >
          {pillars.items.map((item, index) => (
            <li
              key={item.title}
              className={cn(
                'flex min-w-0 flex-col gap-2 p-6 min-[560px]:p-7',
                // Stacked: a rule above every item but the first. It also
                // carries the colour every other rule below inherits.
                index > 0 && 'border-t border-line',
                // Two columns: the second item joins the first row…
                index === 1 && 'min-[560px]:border-t-0',
                // …and the right-hand item of each row is divided vertically.
                index % 2 === 1 && 'min-[560px]:border-l',
                // Four columns: one row, so the second row's rule goes…
                index >= 2 && 'min-[1120px]:border-t-0',
                // …and the only item still missing a vertical rule gets one.
                index === 2 && 'min-[1120px]:border-l',
              )}
            >
              {/* `mb-1.5` on the icon, not a bigger container gap: 14px above
                  the title and 8px below it groups the title with the body it
                  belongs to, where a flat 10px grouped it with neither.
                  Nothing else sets a margin here, so `cn`'s plain join is
                  safe. The square itself stays `size-10` with a 22px glyph —
                  the band, `Pain` and `Timeline` all draw it, and changing one
                  breaks the family. */}
              <span className="mb-1.5 grid size-10 place-items-center rounded-swatch bg-blue-soft text-blue">
                <Icon name={BAND_ICONS[index] ?? 'check'} size={22} />
              </span>
              <b className="font-display text-subhead font-bold text-balance">{item.title}</b>
              <p className="text-base leading-[1.6] text-ink-soft">{item.body}</p>
            </li>
          ))}
        </ul>
      </Wrap>
    </Section>
  )
}

/* ------------------------------------------------------------- refunds */

/**
 * The two refunds, pasted from `docs/legal/faq-cobranca.md` rather than
 * paraphrased — that file says so itself, and a customer who reads one rule
 * here and another in the contract files a chargeback.
 *
 * **This is now the FAQ's first row, not a section of its own** (Sci,
 * 2026-09-24). Recorded rather than argued: `docs/legal/faq-cobranca.md:70`
 * carries a placement table asking for *devolução* on the Offer page **below
 * the price**, and an accordion is not that — the CDC art. 49 seven-day
 * withdrawal right is invisible until somebody clicks. Sci was shown the table
 * and chose the FAQ; the legal document is unchanged, and this comment exists
 * so the next reader finds the contradiction here rather than in a chargeback.
 *
 * `refunds.ctaLine` did not move with it. It is still beside the price in the
 * signup dialog, which is the point of purchase and the one place a refund
 * statement has to be.
 *
 * Not one word of the copy changed in the move — `faq-cobranca.md:75` asks for
 * the same wording in all three places, and §5 reserves it to Sci anyway. That
 * is why this row carries an intro, a list and a footnote where every other
 * row carries one string: flattening it into a paragraph would be rewriting it.
 *
 * `**bold**` is resolved here rather than rendered as Markdown: the catalogue
 * holds the sentences verbatim so they can be diffed against the legal file,
 * and this is the only place that needs to display them.
 */
function RefundsAnswer() {
  const { refunds } = page
  return (
    <div className="pb-4">
      <p className="text-base leading-[1.6] text-ink-soft">{refunds.intro}</p>
      {/* `role="list"`, like every other list on this page: Tailwind v4's
          preflight sets `list-style: none` and Safari drops the list
          semantics with the marker. It matters most here — `refunds.intro` is
          *"Em dois casos:"*, so without it the two guarantees announce as two
          unassociated runs of text with nothing saying there are two, and one
          of them is the CDC art. 49 withdrawal right. */}
      <ul role="list" className="mt-4 flex flex-col gap-3">
        {refunds.items.map((item) => (
          <li key={item} className="flex items-start gap-2.5 text-base leading-[1.6]">
            <Icon name="check" size={18} strokeWidth={2} className="mt-1 shrink-0 text-blue" />
            <span>{bold(item)}</span>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-meta leading-[1.5] text-muted">{refunds.outro}</p>
    </div>
  )
}

/** `**x**` → `<strong>x</strong>`, for the verbatim legal sentences above. */
function bold(text: string) {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) =>
    i % 2 === 1 ? <strong key={i}>{part}</strong> : part,
  )
}

/* ---------------------------------------------------------------- why now */

/**
 * Same order as `pain.items`: find it, read it, do the sum.
 *
 * `money` rather than `margin` for the third: the problem described is losing
 * money on the contract, not reading a margin sheet, and `money` is already
 * what `Trust` and `Pillars` give the same idea two sections apart.
 */
const PAIN_ICONS = ['search', 'tender', 'money'] as const

function Pain() {
  const { pain } = page
  return (
    <Section>
      <Wrap>
        {/*
          Heading left, the standfirst right — `SectionHead`'s `aside`, the
          arrangement this section introduced.

          The second column used to hold the two market figures. It now holds
          `pain.standfirst`, which Sci wrote for exactly this position; the
          figures and the source line that named them stay in the catalogue and
          render nowhere, carded as **D14** because deleting copy is his under
          legal brief §5.
        */}
        <SectionHead
          label={pain.label}
          title={pain.title}
          className="mb-10"
          aside={<p className="text-base leading-[1.6] text-ink-soft">{pain.standfirst}</p>}
          asideAlign="end"
        />

        {/*
          Numbered, and an `<ol>`, because *Encontrar → Entender → Não perder
          dinheiro* is the order the work actually happens in — not three
          parallel complaints. The numerals are `aria-hidden`: the list element
          already carries the sequence, and a screen reader reading "zero um"
          before every heading would say it twice.
        */}
        {/*
          `role="list"` is not redundant. Tailwind v4's preflight sets
          `list-style: none` on every `ol`/`ul`, and Safari drops the list role
          when it sees that — measured here, every list on this page computes
          `list-style-type: none`. Without the role the element announces
          nothing, and since the numerals are `aria-hidden` on the strength of
          "the list carries the order", the order would reach nobody on an
          iPhone. That is the same shape as the table bug in the commit before
          this one: semantics asserted without checking the browser kept them.
        */}
        <ol role="list" className="grid grid-cols-1 gap-4 min-[900px]:grid-cols-3">
          {pain.items.map((item, index) => (
            <li key={item.title} className="flex min-w-0">
              {/* `padding="none"` plus the padding here rather than an `lg`
                  step in `components/card.tsx`: that file is shared, and
                  `CLAUDE.md`'s parallel-lane rule keeps this page out of it. */}
              <Card padding="none" className="flex w-full flex-col gap-2 p-6 min-[1120px]:p-7">
                <div className="mb-1.5 flex items-center gap-3">
                  <span className="grid size-10 place-items-center rounded-swatch bg-blue-soft text-blue">
                    <Icon name={PAIN_ICONS[index]} size={22} />
                  </span>
                  <span
                    aria-hidden
                    className="font-mono text-lead font-medium tabular-nums text-muted"
                  >
                    {`0${index + 1}`}
                  </span>
                </div>
                <H3>{item.title}</H3>
                <p className="text-base leading-[1.6] text-ink-soft">{item.body}</p>
              </Card>
            </li>
          ))}
        </ol>
      </Wrap>
    </Section>
  )
}

/* ------------------------------------------------------------- price chain */

/**
 * The four prices, as a chain of labelled steps in reading order.
 *
 * ## What it replaced, and why
 *
 * A horizontal bar with four marks hung above and below it, over a
 * green→red gradient. Three measured problems, all of them worst on the phone
 * this audience reads on:
 *
 *  1. at 390px the "you can still profit" zone was **47px of 308** — a nub.
 *     The gradient's whole job was to divide the scale at R$ 14,60, and at
 *     that width the green end read as part of the pink, so the colour
 *     semantics inverted: the bar looked like one warm band with the good
 *     news lost in its left edge;
 *  2. `R$ 14,60` — the number the product exists to produce — was set at 16px,
 *     while a competitor's price in the comparison table below is 34px;
 *  3. the marks were positioned by percentage on a R$ 10–R$ 40 scale, so the
 *     reading order was spatial (15.3%, 33.3%, 63.3%, 86.7%) and not the order
 *     of the argument. A screen reader got none of it: the whole figure was
 *     one `role="img"` with a sentence for an `aria-label`.
 *
 * The chain fixes all three by not being a chart. Four steps, in the order the
 * argument is made — what the tender estimated, what the winner actually bid,
 * what retail costs, and therefore the most you can pay your supplier — with
 * the last one on the brand panel at `--text-stat`. It is an `<ol>` of real
 * text, so it reads in order with no alt text to maintain.
 *
 * ## Colour
 *
 * No green, and no gradient. Green is `success` in this product — the
 * compatible badge, "Não exige", "Oportunidade encontrada" — and a fourth
 * meaning for it here ("this price is safe") would spend that. The emphasis is
 * `--color-brand-panel` with the measured `on-brand*` ramp, the same device as
 * the founder panel. The red stays exactly where it already was: on the
 * verdict, which is a warning about a loss and the one thing in this section
 * that `error` correctly describes.
 */
function PriceChain() {
  const { ruler } = page
  const steps = [
    { label: ruler.tender, value: ruler.tenderValue },
    { label: ruler.winner, value: ruler.winnerValue },
    { label: ruler.retail, value: ruler.retailValue },
    { label: ruler.maxPurchase, value: ruler.maxPurchaseValue, emphasis: true },
  ]

  return (
    <Section ground="muted">
      <Wrap>
        {/*
          Heading left, the chain right — `SectionHead`'s `aside`, the
          arrangement `Pain` already uses, with `wideAside` because this column
          holds a row of boxes rather than text. (`Screening` reads the same
          way but hand-rolls its own grid on the `Wrap`, and so does `Signup`;
          folding those two into `aside` is a bigger change than this card.)

          The verdict strip and the source line stay in this column, directly
          under the chain: the verdict *is* the chain's conclusion — it names
          the sum that does not close — and the source names where those four
          figures came from. Both read as a footnote to a heading if they are
          left in the left-hand column, and neither is about the heading.

          **The eyebrow no longer names the commodity, and nothing else does.**
          It used to read *"Exemplo real · papel sulfite A4, por resma"* and
          earned its place on exactly that ground; Sci shortened it to
          *"Exemplo real"* on 2026-09-24. After that edit `≈ R$ 36`, `≈ R$ 20`,
          `≈ R$ 29` and `R$ 14,60` sit under a source line reading *"Medianas
          de 8 editais encerrados"* with nothing on this page saying what was
          bought — `papel A4` survives only in `radar.landing.opportunity.body`,
          `radar.price.example` and `radar.price.exampleLead`, which are other
          pages. It is not a false claim, so it is not a blocker, but it is
          unattributed figures on the page taking money and it is in the PR and
          the STATUS row for Sci. The wording is his under the legal brief:
          this comment records the state rather than restoring the suffix.
        */}
        <SectionHead
          label={ruler.label}
          title={ruler.title}
          wideAside
          aside={
            /*
              **A container query, not a media query.**

              Whether the four steps fit in a row is a fact about *this column*,
              not about the viewport: the same 900px page gives the chain 503px
              here and 860px when it was full width. Keyed to the viewport, the
              row either overflows its column or the figure has to shrink — and
              the figure is the number the whole section exists to produce, so
              `R$ 14,60` is `--text-stat` at every width and the layout bends
              around it.

              Measured, in the fonts the page actually loads: the emphasised
              value is **163px** and the three quiet values **87px**, so with
              `px-4` and three 16px gaps the row needs **600px**. `@min-[600px]`
              is therefore the honest threshold, and it is the column's width
              that is tested. It resolves to a viewport of about **1080px** and
              up; below that the column is narrower than the row and the steps
              stack, with the connector rotating to point down — the behaviour
              the phone layout already had.
            */
            <div className="@container">
              <ol
                role="list"
                className={cn(
                  'grid grid-cols-1 gap-x-4 gap-y-9 [&>*]:min-w-0',
                  '@min-[600px]:grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,1.6fr)] @min-[600px]:gap-y-0',
                )}
              >
                {steps.map((step, index) => (
                  <li key={step.label} className="relative flex">
                    <div
                      className={cn(
                        'flex w-full items-baseline justify-between gap-3 rounded-panel px-5 py-4',
                        // The compact form: label on its own line, value under
                        // it, and the padding the 600px arithmetic assumes.
                        '@min-[600px]:h-full @min-[600px]:flex-col @min-[600px]:items-start',
                        '@min-[600px]:justify-between @min-[600px]:gap-2 @min-[600px]:px-4 @min-[600px]:py-4',
                        step.emphasis
                          ? 'bg-brand-panel text-on-brand'
                          : 'border border-line bg-surface',
                      )}
                    >
                      <span
                        className={cn(
                          'text-base leading-[1.4] @min-[600px]:text-meta @min-[600px]:leading-[1.35]',
                          step.emphasis ? 'text-on-brand-muted' : 'text-muted',
                        )}
                      >
                        {step.label}
                      </span>
                      <span
                        className={cn(
                          'font-mono whitespace-nowrap tabular-nums',
                          step.emphasis
                            ? 'text-stat font-semibold text-on-brand'
                            : 'text-xl font-medium text-ink',
                        )}
                      >
                        {step.value}
                      </span>
                    </div>

                    {/* The connector, in the gap: pointing down while the steps
                        are stacked, right once they are a row. Decoration —
                        the `<ol>` already carries the order. */}
                    {index < steps.length - 1 ? (
                      <span
                        aria-hidden
                        className={cn(
                          'absolute -bottom-7 left-1/2 grid h-5 -translate-x-1/2 place-items-center text-line-strong',
                          '@min-[600px]:top-1/2 @min-[600px]:-right-4 @min-[600px]:bottom-auto @min-[600px]:left-auto',
                          '@min-[600px]:w-4 @min-[600px]:-translate-x-0 @min-[600px]:-translate-y-1/2',
                        )}
                      >
                        <Icon
                          name="arrowRight"
                          size={16}
                          className="rotate-90 @min-[600px]:rotate-0"
                        />
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>

              <div className="mt-9 flex items-start gap-3 rounded-swatch bg-error-soft px-4 py-3.5 text-base leading-[1.6]">
                <Icon
                  name="warning"
                  size={20}
                  strokeWidth={2}
                  className="mt-0.5 shrink-0 text-error"
                />
                <span>
                  <b className="text-error">{ruler.verdictLead}</b> {ruler.verdictBody}
                </span>
              </div>

              <Source className="mt-4">{ruler.source}</Source>
            </div>
          }
        >
          <p className="text-base leading-[1.6] text-ink-soft">{ruler.body}</p>
        </SectionHead>
      </Wrap>
    </Section>
  )
}

/* -------------------------------------------------------- screening example */

type ScreeningRow = {
  label: string
  value: string
  page: string
  mono?: boolean
  badge?: boolean
}

function Screening() {
  const { screening } = page
  const rows: ScreeningRow[] = screening.rows

  return (
    <Section id={ANCHORS.screening}>
      <Wrap className="grid items-start gap-7 min-[900px]:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] min-[900px]:gap-10">
        <SectionHead label={screening.label} title={screening.title}>
          <p className="text-lg text-ink-soft">{screening.body}</p>

          {/*
            What the reading actually gives you, under the paragraph that
            promises it and beside the card that shows it.

            One check glyph per line, the idiom `Refunds` and the offer panel's
            benefit list already use: each line is a thing you get, which is
            one idea, and four different pictograms would make four kinds of
            thing out of it.

            `role="list"`: Tailwind v4's preflight sets `list-style: none`, and
            Safari drops the list semantics along with the marker — that exact
            defect shipped this morning.
          */}
          <ul role="list" className="mt-1 flex flex-col gap-2.5">
            {screening.checks.map((check) => (
              <li key={check} className="flex items-start gap-2.5 text-base leading-[1.5]">
                <Icon
                  name="check"
                  size={20}
                  strokeWidth={2}
                  className="mt-0.5 shrink-0 text-blue"
                />
                {check}
              </li>
            ))}
          </ul>

          <Source>{screening.source}</Source>
        </SectionHead>

        <article
          aria-label={screening.cardLabel}
          className="overflow-hidden rounded-panel border border-line bg-surface"
        >
          <div className="flex flex-col gap-2 border-b border-line px-5 py-[18px]">
            {/* `Status` is used here as the board's badge shape: the tone, not
                the Radar meaning, is what the example card is showing. */}
            <TagList>
              <Status kind="compatible">{screening.modality}</Status>
              <Status kind="positive">{screening.exclusive}</Status>
            </TagList>
            <H3>{screening.tender}</H3>
            <p className="text-meta leading-[1.45] text-muted">{screening.buyer}</p>
          </div>

          <div className="flex items-center gap-3.5 bg-blue-soft px-5 py-3.5">
            <b className="font-display text-score font-extrabold text-blue tabular-nums">
              {screening.score}
              <small className="text-base font-semibold">{screening.scoreOutOf}</small>
            </b>
            <p className="text-body leading-[1.55]">{screening.scoreBody}</p>
          </div>

          <div className="px-5 pt-1 pb-3">
            {rows.map((row, index) => (
              <CardRow
                key={row.label}
                last={index === rows.length - 1}
                label={<span className="text-muted">{row.label}</span>}
                value={
                  row.badge ? (
                    <Status kind="check">{row.value}</Status>
                  ) : (
                    <span className={cn('text-right', row.mono && 'font-mono tabular-nums')}>
                      {row.value}
                    </span>
                  )
                }
                aside={
                  <span className="rounded-[4px] bg-fill-muted px-1.5 py-0.5">{row.page}</span>
                }
              />
            ))}
          </div>

          <div className="flex flex-wrap justify-between gap-3 border-t border-line px-5 py-3 text-caption leading-[1.55] text-muted">
            <span>{screening.readIn}</span>
            <span>{screening.published}</span>
          </div>
        </article>
      </Wrap>
    </Section>
  )
}

/* ------------------------------------------------------- what a founder gets */

function FounderValue() {
  const { founderValue } = page
  /**
   * The first benefit **is** the price — "R$ 26 por mês durante 6 meses" — and
   * it was set at 17px in a list of four evenly weighted items, so the cheapest
   * thing on the page was also the quietest. It is lifted out of the list and
   * given `--text-stat`, the size this page already gives a figure that carries
   * a section; the three that remain keep the list.
   *
   * Nothing is cut and nothing is reworded: same four strings, same order.
   */
  const [price, ...benefits] = founderValue.benefits
  return (
    <Section ground="muted">
      <Wrap>
        {/* Brand blue, not graphite (Sci, 2026-09-24). The `on-brand` ramp is
            measured against #14347f in `tokens.css`; the graphite ramp's tiers
            do not survive the move — `blue-on-ink` in particular is 2.71:1 on
            blue and invisible.

            `min-w-0` on the grid children because a grid item defaults to
            `min-width: auto`: the comparison table inside once carried a
            `min-w-[420px]`, which at 440px pushed the whole panel past the
            viewport and took the call to action out with it. */}
        <div className="grid gap-7 rounded-feature bg-brand-panel px-5 py-7 text-on-brand [&>*]:min-w-0 min-[900px]:grid-cols-2 min-[900px]:gap-10 min-[900px]:p-10">
          <div className="flex flex-col gap-6">
            <SectionLabel tone="inverse" size="caption">
              {founderValue.label}
            </SectionLabel>
            <H2 className="text-surface">{founderValue.title}</H2>

            <div className="flex flex-col gap-1.5">
              {/* `--text-stat` carries 1.05 leading because everywhere else on
                  this page it is one line — `R$ 272,6 bi`, `R$ 14,60`. This is
                  the first place it carries a sentence, and at 390px that
                  sentence is two lines in a 310px measure: 34px type on 35.7px
                  leading puts one line's descenders in the next line's
                  ascenders. `leading-[1.15]` is the same size on 39px. */}
              <b className="font-display text-stat leading-[1.15] font-extrabold tracking-[-0.02em] text-surface text-balance">
                {price.title}
              </b>
              <span className="text-base leading-[1.6] text-on-brand-muted">{price.body}</span>
            </div>

            {/* `aria-hidden`: an `<hr>` is `role="separator"` and would be
                announced between the price and the list it introduces. */}
            <hr aria-hidden className="border-0 border-t border-brand-line" />

            {/* Check glyphs rather than four category icons. Each of the three
                is a thing the founder gets, which is one idea, and four
                different pictograms for it made the list look like four
                different kinds of thing. `icon-on-brand` is the 5.06:1 tier.

                This retires `BENEFIT_ICONS` — including the `visitor` → `money`
                correction PR #100 made to index 1 when that benefit became the
                price range. The correction was right and the reason it existed
                (an icon must illustrate the sentence beside it) is exactly why
                there is now one glyph: a check illustrates every one of them. */}
            <ul className="flex flex-col gap-4">
              {benefits.map((benefit) => (
                <li key={benefit.title} className="flex items-start gap-3">
                  <Icon
                    name="check"
                    size={20}
                    strokeWidth={2}
                    className="mt-1 shrink-0 text-icon-on-brand"
                  />
                  <div className="min-w-0">
                    <b className="mb-0.5 block text-subhead font-bold text-surface">
                      {benefit.title}
                    </b>
                    <span className="text-base leading-[1.6] text-on-brand-muted">{benefit.body}</span>
                  </div>
                </li>
              ))}
            </ul>

            {/* The call to action belongs to the offer, not to the comparison
                table it used to hang under: price, what you get, then the
                thing to do about it, full width.
                
                `mt-auto` pins it to the floor of a column the grid has
                stretched. Measured, this column's own content is the taller of
                the two at every width the row is used (563px against 401px at
                1120px, 621 against 466 at 900), so today the rule is a no-op —
                it is kept because it is the comparison column that grows when
                a row is added to the table, and then the offer would end above
                the panel's floor. */}
            <SignupButton variant="onBrand" className="mt-auto w-full" label={founderValue.cta} />
          </div>

          <div className="flex flex-col gap-4">
            <SectionLabel tone="inverse" size="caption">
              {founderValue.comparisonLabel}
            </SectionLabel>

            {/* Stacked below 560px, a table above it.
                
                `overflow-x-auto` around a `w-full` table did nothing —
                measured at 390px, clientWidth 310 and scrollWidth 310, so the
                escape hatch was inert and the columns simply compressed to
                91/104/115px. Adding `min-w-[420px]` made it scroll and
                **broke the panel**: a grid item is `min-width: auto`, so at
                440px the table pushed the whole panel past the viewport and
                carried the call to action out with it.
                
                So neither. This audience will not think to swipe a table, and
                three columns of two-to-five words do not need to be one: below
                560px each row becomes the feature name with its two values
                labelled underneath, which is the same information at a width
                that fits. `<table>` is kept — from 560px up it *is* tabular
                data, with real `<th scope="col">` associations.

                **Below 560px it is not a table at all**, and the comment that
                used to stand here said the opposite: "the real `<th>` is still
                associated with the cell". It is not. Setting `display: block`
                on a table element strips its implicit ARIA role in every major
                browser — no table, no row, no cell, and therefore no column
                header associated with anything. The `<th>`s were `sr-only`
                (present, announced) and the visible substitute labels inside
                each cell were `aria-hidden` (ignored), on the strength of that
                false claim. On a phone, every row announced the feature name
                and then two bare prices with nothing saying which was the
                competitor's and which was ours — on the one section whose
                whole job is that contrast.

                So the substitutes do the work where the semantics are gone,
                and the two mechanisms swap over at the same breakpoint the
                layout does:

                  <560px   `<thead>` is `display: none` (out of the tree, not
                           merely invisible) and each value carries its own
                           label, announced
                  ≥560px   the labels are `display: none` and the real
                           `<th scope="col">` associations are back

                `display: none` in both directions on purpose: `aria-hidden`
                cannot be made conditional on a media query, and `sr-only`
                would have left the headers announcing a second time. The
                labels are `comparisonOther` and `messages.brand.name` — the
                same two strings the `<th>`s carry. */}
            <div>
              <table className="w-full border-collapse text-body leading-[1.55] max-[559px]:block">
                <thead className="max-[559px]:hidden">
                  <tr>
                    <th scope="col" className="border-b border-brand-line px-2 py-2.5" />
                    <th
                      scope="col"
                      className="border-b border-brand-line px-2 py-2.5 text-left font-mono text-label font-medium tracking-[0.06em] text-on-brand-faint uppercase"
                    >
                      {founderValue.comparisonOther}
                    </th>
                    <th
                      scope="col"
                      className="border-b border-brand-line px-2 py-2.5 text-left font-mono text-label font-medium tracking-[0.06em] text-on-brand-faint uppercase"
                    >
                      {messages.brand.name}
                    </th>
                  </tr>
                </thead>
                <tbody className="max-[559px]:block">
                  {founderValue.comparisonRows.map((row, index) => (
                    <tr
                      key={row.feature}
                      className="max-[559px]:block max-[559px]:border-b max-[559px]:border-brand-line max-[559px]:py-3"
                    >
                      <td className="border-b border-brand-line px-2 py-2.5 align-top text-on-brand-muted max-[559px]:block max-[559px]:border-0 max-[559px]:pb-1 max-[559px]:font-semibold max-[559px]:text-on-brand">
                        {row.feature}
                      </td>
                      {/* The inline label, and it is **not** `aria-hidden`.
                          Below 560px it is the only thing that says whose
                          price this is: `display: block` has stripped the
                          cell's role, so there is no column header associated
                          with it any more. `hidden` (display: none) is what
                          keeps it from being announced twice from 560px up,
                          where the real `<th scope="col">` works again. */}
                      <td
                        className={cn(
                          'border-b border-brand-line px-2 py-2.5 align-top',
                          'max-[559px]:block max-[559px]:border-0 max-[559px]:py-0.5 max-[559px]:text-on-brand-muted',
                          index === 0 && 'font-mono tabular-nums',
                        )}
                      >
                        <span className="hidden max-[559px]:mr-1.5 max-[559px]:inline font-sans text-caption text-on-brand-faint">
                          {founderValue.comparisonOther}:
                        </span>
                        {row.other}
                      </td>
                      <td
                        className={cn(
                          'border-b border-brand-line px-2 py-2.5 align-top font-semibold text-surface',
                          'max-[559px]:block max-[559px]:border-0 max-[559px]:py-0.5',
                          index === 0 && 'font-mono tabular-nums',
                        )}
                      >
                        <span className="hidden max-[559px]:mr-1.5 max-[559px]:inline font-sans text-caption font-normal text-on-brand-faint">
                          {messages.brand.name}:
                        </span>
                        {row.us}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-caption leading-[1.55] text-on-brand-faint">{founderValue.comparisonNote}</p>
          </div>
        </div>
      </Wrap>
    </Section>
  )
}

/* -------------------------------------------------------------- timeline */

/**
 * Same order as `timeline.steps`: the day you reserve, the hour it opens, the
 * weekly Telegram summary, the subscription link.
 *
 * `deadline` is this file's calendar — see `icon.tsx`, which explains why no
 * second name for it was added.
 */
const TIMELINE_ICONS = ['deadline', 'clock', 'send', 'link'] as const

function Timeline() {
  const { timeline } = page
  return (
    <Section>
      <Wrap>
        <SectionHead label={timeline.label} title={timeline.title} className="mb-8" />
        {/*
          A rule over each step said "four things"; it did not say they happen
          in this order, and the order is the whole argument of the section —
          you reserve today and decide in October. So: the icon box the rest of
          the page already uses for a category, the numeral, and an arrow in
          the gap between consecutive steps.

          The arrows are decoration — the `<ol>` carries the sequence — so they
          are `aria-hidden`, and they exist only from 900px, the one width at
          which the steps are actually a row. Between stacked items an arrow
          pointing right would be pointing at nothing.
        */}
        <ol
          role="list"
          className="grid grid-cols-1 gap-x-4 gap-y-8 min-[560px]:grid-cols-2 min-[900px]:grid-cols-4 min-[900px]:gap-y-0"
        >
          {timeline.steps.map((step, index) => (
            <li
              key={step.title}
              className="relative flex min-w-0 flex-col gap-2 min-[900px]:pr-9"
            >
              <div className="flex items-center gap-3">
                <span className="grid size-10 place-items-center rounded-swatch bg-blue-soft text-blue">
                  <Icon name={TIMELINE_ICONS[index]} size={22} />
                </span>
                <span
                  aria-hidden
                  className="font-mono text-lead font-medium tabular-nums text-muted"
                >
                  {`0${index + 1}`}
                </span>
              </div>
              <span className="mt-1 font-mono text-caption font-medium tracking-[0.06em] text-blue uppercase">
                {step.when}
              </span>
              <H3>{step.title}</H3>
              <p className="text-base leading-[1.6] text-ink-soft">{step.body}</p>

              {index < timeline.steps.length - 1 ? (
                <span
                  aria-hidden
                  className="absolute top-5 right-1 hidden -translate-y-1/2 text-line-strong min-[900px]:block"
                >
                  <Icon name="arrowRight" size={20} />
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </Wrap>
    </Section>
  )
}

/* -------------------------------------------------------------------- faq */

function Faq() {
  const { faq } = page
  /**
   * Two catalogue columns, one list.
   *
   * `faq.columns` is a layout decision frozen into the copy file — two arrays
   * because the section used to be a full-width heading with a two-column
   * accordion under it. The heading now takes the left-hand column
   * (`SectionHead`'s `aside`, as `Pain`, `Screening` and the price chain do),
   * so the questions have ~0.55 of the row: two columns inside that is ~260px
   * a question, which is narrower than the questions themselves. Flattened in
   * order, nothing is cut, reordered or reworded — the reading order is the
   * one the file already has, top to bottom.
   *
   * **The refunds are the first row**, which is where they sat when they were
   * a section of their own — the same reading order, one level quieter. Its
   * answer is markup rather than a string because the copy is three parts and
   * none of them may be rewritten; see `RefundsAnswer`.
   */
  const questions: { q: string; a: ReactNode }[] = [
    { q: page.refunds.title, a: <RefundsAnswer /> },
    ...faq.columns.flat(),
  ]

  return (
    <Section id={ANCHORS.faq}>
      <Wrap>
        <SectionHead
          label={faq.label}
          title={faq.title}
          aside={
            <div>
              {questions.map((item) => (
                <details key={item.q} className="group border-b border-line py-1">
                  <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-4 font-semibold [&::-webkit-details-marker]:hidden">
                    <span>{item.q}</span>
                    <span aria-hidden className="font-mono text-xl text-blue group-open:hidden">
                      +
                    </span>
                    <span
                      aria-hidden
                      className="hidden font-mono text-xl text-blue group-open:block"
                    >
                      −
                    </span>
                  </summary>
                  {typeof item.a === 'string' ? (
                    <p className="pb-4 text-base leading-[1.6] text-ink-soft">{item.a}</p>
                  ) : (
                    item.a
                  )}
                </details>
              ))}
            </div>
          }
        />
      </Wrap>
    </Section>
  )
}

/* ------------------------------------------------------- closing offer */

/**
 * The last ask, rebuilt from the light `bg-blue-soft` strip it used to be
 * (Sci, 2026-09-24) and moved into the slot the refunds left, between the
 * timeline and the FAQ — so the page's final argument lands before the
 * questions rather than after them.
 *
 * `SectionHead`'s `aside` rather than a fifth hand-rolled grid: `Pain`,
 * `Screening`, the price chain and the FAQ all use it, and a two-column
 * section that agrees with those by construction cannot drift from them.
 *
 * **The card is on `surface`, not the brand panel.** `FounderValue` already
 * owns the one dark panel on this page; a second would make the two compete
 * for the same "this is the offer" reading, and the draft's closing card is
 * light.
 *
 * **Every string here is already rendered by the signup dialog's price block**
 * (`signup-form.tsx`), read from the same four keys. The two agree because
 * they read the same catalogue, not because somebody kept them in step.
 *
 * **The draft's five ticked lines are deliberately not here.** Four of the
 * five — *Acesso completo ao sistema*, *Todos os estados do Brasil*, *Suporte
 * por e-mail*, *Sem pagamento agora* — exist nowhere in `messages/pt-BR.json`,
 * and "todos os estados" is a coverage claim nothing in this product
 * substantiates. Writing them here would be writing copy, which §5 reserves to
 * Sci. When the five arrive they go between `priceNote` and the CTA, inside
 * the `gap-4` column, as the same `<ul>` idiom `RefundsAnswer` uses; nothing
 * about this layout has to change to take them.
 */
function ClosingOffer() {
  const { final, signup } = page
  return (
    <Section ground="muted">
      <Wrap>
        <SectionHead
          title={final.title}
          aside={
            <div className="flex flex-col gap-4 rounded-feature border border-line bg-surface p-5 shadow-[0_1px_0_var(--color-line),0_18px_40px_-28px_rgba(23,23,23,0.35)] min-[560px]:p-6">
              <SectionLabel tone="accent" size="caption">
                {signup.seatsGroup}
              </SectionLabel>

              <div className="flex flex-wrap items-baseline gap-2.5">
                <span className="font-display text-price font-extrabold tracking-[-0.02em] tabular-nums">
                  {signup.price}
                </span>
                <span className="text-lead text-muted">{signup.priceUnit}</span>
              </div>

              <p className="-mt-2 flex flex-wrap items-baseline gap-2 text-meta leading-[1.45] text-muted">
                <s className="font-mono text-body">{signup.priceWas}</s>
                <span className="min-w-0">{signup.priceNote}</span>
              </p>

              <SignupButton className="mt-1 w-full" label={messages.founders.offer.cta} />
            </div>
          }
        >
          <p className="text-ink-soft">{messages.brand.promise}</p>
        </SectionHead>
      </Wrap>
    </Section>
  )
}

/* ------------------------------------------------------------------- page */

export default function FoundersOfferPage() {
  return (
    <SignupSheet>
      <div className="bg-ivory text-base leading-[1.55] text-ink">
        <a
          href="#topo"
          className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-10 focus:rounded-control focus:border focus:border-line focus:bg-surface focus:px-3 focus:py-2 focus:text-meta focus:no-underline"
        >
          {page.nav.skip}
        </a>

        {/* Sticky, because the four CTAs sit at y = 10, 1 702, 7 201 and 9 520
          on a 9 808px page — and between the form's submit and the next one
          there are 5 499px, about seven phone screens, of the page's most
          persuasive material with no affordance on screen at all. That is
          precisely the stretch where somebody becomes willing to act. The
          header already holds the right link at 44px; it just scrolled away. */}
        <header className="sticky top-0 z-10 border-b border-line bg-ivory/95 backdrop-blur-sm">
          <Wrap className="flex min-h-16 items-center justify-between gap-4">
            {/*
              **The Landing, not the top of this page.**

              This was `href="#topo"` while its accessible name was
              `nav.home` — so the control announced itself as "home" and
              scrolled you 300px instead. Sci, 2026-09-25: a logo is the one
              affordance every reader already knows the meaning of, and on a
              page reached from Instagram or a WhatsApp link it is how somebody
              goes to look at the product properly.

              `#topo` keeps its consumer: the skip link above still targets it,
              which is what it was written for.

              `Link` rather than `<a>`: this is an internal route, so it
              prefetches and navigates on the client like every other one.
            */}
            <Link
              href="/"
              aria-label={page.nav.home}
              className="inline-flex min-h-touch items-center text-ink no-underline"
            >
              <Logo size={34} />
            </Link>

            {/* In-page anchors, from 900px up — the width at which the page is
              already two columns and the header has room for them beside the
              call to action. Below that the CTA is the only thing in the bar
              that matters, and three more links would crowd it off.

              The labels are the sections' own eyebrows, so nothing here is new
              copy; `scroll-mt-20` on the target keeps the heading clear of
              this bar. */}
            <nav className="hidden min-w-0 items-center gap-6 min-[900px]:flex">
              {NAV_LINKS.map((link) => (
                <a
                  key={link.id}
                  href={`#${link.id}`}
                  className="inline-flex min-h-touch items-center text-meta font-medium whitespace-nowrap text-ink-soft no-underline hover:text-blue"
                >
                  {link.label}
                </a>
              ))}
            </nav>

            <SignupTextButton
              className="inline-flex min-h-touch cursor-pointer items-center border-0 bg-transparent text-lead font-semibold whitespace-nowrap text-blue hover:text-blue-hover"
              label={page.nav.cta}
            />
          </Wrap>
        </header>

        {/* `scroll-mt-20` for the same reason every `Section` carries it: the
          skip link and the logo both point at `#topo`, and without the offset
          the first thing a keyboard user reveals — the hero badge naming the
          48 seats and the 08/10 opening — renders behind the 64px bar. */}
        <main id="topo" className="scroll-mt-20">
          <Hero />
          <Promises />
          <Pain />
          <PriceChain />
          <Screening />
          <FounderValue />
          <Timeline />
          <ClosingOffer />
          <Faq />
        </main>

        <footer className="pt-8 pb-12 text-meta leading-[1.55] text-muted">
          <Wrap className="flex flex-wrap justify-between gap-4">
            <span>{page.footer.company}</span>
            <span>
              <Link href={messages.legal.privacyUrl} className="text-blue hover:text-blue-hover">
                {messages.legal.privacyLabel}
              </Link>{' '}
              ·{' '}
              <Link href={messages.legal.termsUrl} className="text-blue hover:text-blue-hover">
                {messages.legal.termsLabel}
              </Link>
            </span>
          </Wrap>
        </footer>
      </div>
    </SignupSheet>
  )
}
