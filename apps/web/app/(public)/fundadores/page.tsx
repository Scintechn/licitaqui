import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { Button, Card, CardRow, Icon, Logo, SectionLabel, Status, TagList } from '@/components'
import { cn } from '@/lib/cn'
import { messages } from '@/lib/messages'
import radarPreview from '@/public/radar-preview.png'
import { ExampleRadar } from '../example-radar'
import { SignupForm } from './signup-form'

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
const ANCHORS = {
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

/** The public-page rhythm, 40/48 — see `page-parts.tsx` for why it stepped down. */
function Section({
  children,
  divided = true,
  id,
  className,
}: {
  children: ReactNode
  /** `.borda-topo` — a hairline separating this section from the one above. */
  divided?: boolean
  /**
   * The target of a header anchor. `scroll-mt-20` comes with it: the header is
   * sticky and 64px tall, so a bare `#id` jump parks the heading underneath it.
   */
  id?: string
  className?: string
}) {
  return (
    <section
      id={id}
      className={cn(
        'py-10 min-[560px]:py-12',
        id && 'scroll-mt-20',
        divided && 'border-t border-line',
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
  className?: string
}) {
  const head = (
    <>
      {label ? (
        <SectionLabel tone="muted" size="caption">
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
        'grid grid-cols-1 items-start gap-x-12 gap-y-6 [&>*]:min-w-0',
        'min-[900px]:grid-cols-[minmax(0,0.45fr)_minmax(0,0.55fr)]',
        className,
      )}
    >
      <div className="flex max-w-[500px] flex-col gap-3">{head}</div>
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

/* -------------------------------------------------------------------- band */

type BandItem = { key: string; content: ReactNode }

/**
 * The hairline dividers between a band's cells, per column count.
 *
 * The rule this encodes was learned at 560–899px, on a tier nobody
 * screenshots: **a tier may only clear a rule a lower tier set.** `border-t`
 * unprefixed, cleared by `min-[560px]:border-t-0`, is safe — a media query
 * beats the base rule whatever the source order. `min-[560px]:border-t` and
 * `min-[560px]:border-t-0` are the same property under the same query and
 * settle by stylesheet order rather than by the order they are written here,
 * which is how the rule between the two rows of pillars went missing.
 *
 * The unprefixed `border-t` also carries the colour every rule below inherits;
 * clearing the width leaves it in place for the vertical rules.
 */
function bandDividers(index: number, columns: 3 | 4) {
  const stacked = index > 0 && 'border-t border-line'

  //   <560px   one column    → a rule above every item but the first
  //   ≥560px   three columns → one row, so a rule left of every item but the first
  if (columns === 3) return cn(stacked, index > 0 && 'min-[560px]:border-t-0 min-[560px]:border-l')

  //   <560px   one column    → a rule above every item but the first
  //   560px    two columns   → a rule left of the right-hand items (1, 3) and
  //                            above the second row (2, 3)
  //   900px    four columns  → a rule left of every item but the first
  return cn(
    stacked,
    // Two columns: the second item joins the first row…
    index === 1 && 'min-[560px]:border-t-0',
    // …and the right-hand item of each row is divided vertically.
    index % 2 === 1 && 'min-[560px]:border-l',
    // Four columns: one row, so the second row's rule goes…
    index >= 2 && 'min-[900px]:border-t-0',
    // …and the only item still missing a vertical rule gets one.
    index === 2 && 'min-[900px]:border-l',
  )
}

/**
 * One panel with hairlines between the cells, rather than N bordered cards.
 *
 * `Pillars` introduced this for its four parts: the items are a single claim,
 * and four separate bordered surfaces make them compete, each with its own
 * edge and its own shadow of white against the ivory. One surface with rules
 * between the items says it once. The trust row under the hero is the same
 * shape with three items, so the treatment lives here rather than being
 * written a second time and drifting.
 *
 * What the two callers do *not* share is the cell: the pillars carry an `<h3>`
 * and a plan attribution, and the trust row deliberately introduces no heading
 * structure at all (it sits above the page's first `<h2>`, and its three
 * strings already head `Pillars` further down). So the surface, the column
 * tiers and the dividers are shared; the contents stay with the sections.
 *
 * `role="list"`: Tailwind v4's preflight sets `list-style: none`, and Safari
 * drops the list semantics along with the marker.
 */
function Band({
  columns,
  items,
  className,
}: {
  columns: 3 | 4
  items: BandItem[]
  className?: string
}) {
  return (
    <ul
      role="list"
      className={cn(
        'grid grid-cols-1 overflow-hidden rounded-panel border border-line bg-surface',
        columns === 3
          ? 'min-[560px]:grid-cols-3'
          : 'min-[560px]:grid-cols-2 min-[900px]:grid-cols-4',
        className,
      )}
    >
      {items.map((item, index) => (
        <li
          key={item.key}
          className={cn(
            'flex min-w-0 flex-col gap-2.5 p-5 min-[900px]:p-6',
            bandDividers(index, columns),
          )}
        >
          {item.content}
        </li>
      ))}
    </ul>
  )
}

/* -------------------------------------------------------------------- hero */

/**
 * The hero: the argument on the left, the product on the right, the ask below.
 *
 * The form used to sit in column two, which made the first screen a headline
 * and a set of five inputs. The approved draft gives that column to a wide
 * shot of the Radar instead and moves the form down to the offer, where the
 * reader has been told the price and what it buys before being asked for a
 * name, an e-mail and a WhatsApp number.
 *
 * Two things keep that from costing sign-ups:
 *
 *  - the CTA below the promises anchors to `#vaga`, so the ask is one click
 *    from the first screen at every width — it is asserted, in a browser, at
 *    390px and at 1280px (`e2e/journeys/fundadores.spec.ts`);
 *  - the form is still `#vaga`, so the header's CTA, the offer panel's and the
 *    final band's all land on it unchanged.
 *
 * **The image is decorative and its `alt` is empty on purpose.** The headline,
 * the subtitle and the four promises beside it already say what the product
 * does; a description of the screenshot would be new user-facing copy, and
 * copy on this page is Sci's under the legal brief. It is a visualisation, not
 * the product — the product itself is `ExampleRadar`, further down, which
 * renders the Radar's own card over three real frozen PNCP tenders.
 *
 * `next/image` with a static import: the source is 1600×1066 and 1.6MB, and an
 * `<img>` in a hero would ship all of it to a phone. The static import carries
 * the intrinsic size, so the box is reserved before the bytes arrive (no CLS),
 * and `sizes` tells the generator which variant each width actually needs.
 * `priority` because this is the LCP element above the fold.
 */
function Hero() {
  const { hero } = page
  return (
    <div className="pt-7 pb-14">
      {/* The split favours the headline: `--text-hero` is `clamp(34px, 5.4vw,
          60px)`, so at 900px the h1 is already 48px and a column narrower than
          ~440px breaks it into eight lines of three words. 1.1/0.9 keeps the
          headline on about the measure it had when the form was here, and the
          shot still takes the larger half of what is left. */}
      <Wrap className="grid items-center gap-8 [&>*]:min-w-0 min-[900px]:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] min-[900px]:gap-x-12">
        <div className="flex flex-col gap-[22px] pt-3">
          <span className="inline-flex items-center gap-2 self-start rounded-badge bg-attention-soft px-2.5 py-1.5 font-mono text-caption font-medium tracking-[0.06em] text-attention uppercase">
            <span aria-hidden className="inline-block size-[7px] rounded-pill bg-attention" />
            {hero.badge}
          </span>

          <h1 className="font-display text-hero font-extrabold tracking-[-0.01em] text-balance">
            {hero.title}
          </h1>

          <p className="max-w-[34em] text-intro text-ink-soft">{hero.subtitle}</p>

          <ul role="list" className="mt-1 grid grid-cols-1 gap-x-5 gap-y-3 min-[560px]:grid-cols-2">
            {hero.promises.map((promise) => (
              <li key={promise} className="flex items-start gap-2.5 text-base leading-[1.45]">
                <Icon name="check" size={20} strokeWidth={2} className="mt-0.5 text-blue" />
                {promise}
              </li>
            ))}
          </ul>

          {/* The one thing to do, from the first screen. `founders.offer.cta`
              is the catalogue's existing ask — the same string the offer panel
              and the form's own submit carry; nothing new is written here. */}
          <Button href="#vaga" className="mt-1 w-full min-[560px]:w-auto min-[560px]:self-start">
            {messages.founders.offer.cta}
          </Button>
        </div>

        {/* `w-full h-auto` inside a `min-w-0` grid child: the intrinsic 1600px
            never becomes the column's minimum, which is the shape that put the
            brand panel past the viewport at 440px two days ago. */}
        <Image
          src={radarPreview}
          alt=""
          priority
          sizes="(min-width: 900px) 52vw, 100vw"
          className="h-auto w-full rounded-feature border border-line shadow-[0_24px_50px_-36px_rgba(23,23,23,0.45)]"
        />
      </Wrap>
    </div>
  )
}

/* -------------------------------------------------------------- trust row */

/** Same order as `pillars.items`, so the icons keep meaning the same thing. */
const TRUST_ICONS = ['search', 'tender', 'money'] as const

/**
 * The three facts, directly under the hero: compatible with your CNAE, the AI
 * reading with the page it came from, the maximum purchase price.
 *
 * Every string is `pillars.items[0..2]` — the approved copy for exactly these
 * three, reused rather than rewritten. Note that the full `Pillars` section
 * further down renders the same three plus the Telegram alerts, with their
 * plan attribution; see the PR for the duplication that creates.
 *
 * **The titles are not headings.** They were `<h3>` for one run and it broke
 * the outline in two ways at once: the row sits above the page's first `<h2>`,
 * so the document went `h1` → `h3` with nothing between, and because the same
 * three strings head the `Pillars` section further down, a reader navigating
 * by heading met "Encontrar / Entender / Ofertar com lucro" twice and could
 * not tell the summary from the section. This row introduces no structure —
 * it has no heading of its own — so its titles are `<b>`, the idiom
 * `FounderValue` already uses for a bold lead-in inside a list item. The type
 * is unchanged.
 */
function Trust() {
  const { pillars } = page
  return (
    <Section>
      <Wrap>
        {/* One band, the same one `Pillars` uses — three bare items in a grid
            read as three loose columns of text directly under a hero that is
            now two large surfaces, and the row is a single statement about
            what the tool knows. `Band` owns the surface and the dividers. */}
        <Band
          columns={3}
          items={pillars.items.slice(0, 3).map((item, index) => ({
            key: item.title,
            content: (
              <>
                <span className="grid size-10 place-items-center rounded-swatch bg-blue-soft text-blue">
                  <Icon name={TRUST_ICONS[index]} size={22} />
                </span>
                <b className="font-display text-subsection font-bold tracking-[-0.01em] text-balance">
                  {item.title}
                </b>
                <p className="text-base leading-[1.6] text-ink-soft">{item.body}</p>
              </>
            ),
          }))}
        />
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
 * It sits directly under the price because `faq-cobranca.md`'s own placement
 * table puts *devolução* on the Offer, and because until today neither refund
 * appeared anywhere in the product: a sweep of the whole catalogue for
 * `devolv|reembols|garantia|arrepend|estorno` returned nothing, while both
 * promises were already contractual under terms §8.
 *
 * `**bold**` is resolved here rather than rendered as Markdown: the catalogue
 * holds the sentences verbatim so they can be diffed against the legal file,
 * and this is the only place that needs to display them.
 */
function Refunds() {
  const { refunds } = page
  return (
    <Section>
      <Wrap className="max-w-[46em]">
        {/* This heading was `text-lead font-semibold` — 15px IBM Plex Sans —
            while the other eight `<h2>`s on the page are 26px Archivo 700. So
            the 7-day CDC right of withdrawal and the 30-day guarantee rendered
            *smaller than the body copy of the sections around them*, directly
            above a FAQ that got the full display treatment, and read as a
            stray FAQ entry rather than a section.

            For someone deciding whether to trust an unknown company with a
            business subscription, this is the most valuable block on the page.
            No eyebrow: it is a question, so it labels itself. */}
        <SectionHead title={refunds.title} />
        <p className="mt-4 text-base leading-[1.6] text-ink-soft">{refunds.intro}</p>
        <ul className="mt-4 flex flex-col gap-3">
          {refunds.items.map((item) => (
            <li key={item} className="flex items-start gap-2.5 text-base leading-[1.6]">
              <Icon name="check" size={18} strokeWidth={2} className="mt-1 shrink-0 text-blue" />
              <span>{bold(item)}</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-meta leading-[1.5] text-muted">{refunds.outro}</p>
      </Wrap>
    </Section>
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
          Heading left, the two market figures right.

          The figures used to sit *under* the three cards, below the fold of
          this section on a phone, where they read as a footnote to the cards
          rather than as the scale of the market the heading is claiming. They
          are the section's supporting material, so they are what the heading's
          second column carries.
        */}
        <SectionHead
          label={pain.label}
          title={pain.title}
          className="mb-10"
          aside={
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap items-baseline gap-x-10 gap-y-6">
                {pain.facts.map((fact) => (
                  <div key={fact.value} className="min-w-0">
                    <b className="block font-display text-stat font-extrabold tabular-nums">
                      {fact.value}
                    </b>
                    <span className="text-body leading-[1.55] text-muted">{fact.label}</span>
                  </div>
                ))}
              </div>
              <Source>{pain.source}</Source>
            </div>
          }
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
              <Card padding="none" className="flex w-full flex-col gap-2.5 p-5">
                <div className="flex items-center gap-3">
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
    <Section>
      <Wrap>
        {/*
          Heading left, the chain right — `SectionHead`'s `aside`, the same
          arrangement `Pain` and `Screening` already use and the one the draft
          approved here.

          The chain descends rather than running across. It used to be a row of
          four from 900px, and that row needs ~790px: the last step holds
          `R$ 14,60` at 34px mono and cannot wrap. The aside column is ~0.55 of
          1032px — 567px at the page's full width — so four across would either
          wrap the figure or push the grid past the viewport. Descending, each
          step keeps the label/value row it already had below 900px, the
          connectors point down at every width (they always did, stacked), and
          the reading order the section argues in is untouched: edital, winner,
          retail, maximum purchase.

          The verdict strip and the source line stay in this column, directly
          under the chain: the verdict *is* the chain's conclusion — it names
          the sum that does not close — and the source names where those four
          figures came from. Both read as a footnote to a heading if they are
          left in the left-hand column, and neither is about the heading.

          The eyebrow earns its place here: it names the commodity the four
          figures are about, which the heading deliberately does not.
        */}
        <SectionHead
          label={ruler.label}
          title={ruler.title}
          aside={
            <>
              <ol role="list" className="flex flex-col gap-9">
                {steps.map((step, index) => (
                  <li key={step.label} className="relative flex">
                    <div
                      className={cn(
                        'flex w-full items-baseline justify-between gap-3 rounded-panel px-5 py-4',
                        step.emphasis
                          ? 'bg-brand-panel text-on-brand'
                          : 'border border-line bg-surface',
                      )}
                    >
                      <span
                        className={cn(
                          'text-base leading-[1.4]',
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

                    {/* The connector, centred in the 36px gap below the step.
                        Decoration — the `<ol>` already carries the order. */}
                    {index < steps.length - 1 ? (
                      <span
                        aria-hidden
                        className="absolute -bottom-7 left-1/2 grid h-5 -translate-x-1/2 place-items-center text-line-strong"
                      >
                        <Icon name="arrowRight" size={20} className="rotate-90" />
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>

              <div className="mt-9 flex items-start gap-3 rounded-swatch bg-error-soft px-4 py-3.5 text-base leading-[1.6]">
                <Icon name="warning" size={20} strokeWidth={2} className="mt-0.5 shrink-0 text-error" />
                <span>
                  <b className="text-error">{ruler.verdictLead}</b> {ruler.verdictBody}
                </span>
              </div>

              <Source className="mt-4">{ruler.source}</Source>
            </>
          }
        >
          <p className="text-base leading-[1.6] text-ink-soft">{ruler.body}</p>
        </SectionHead>
      </Wrap>
    </Section>
  )
}

/* ---------------------------------------------------------------- pillars */

const PILLAR_ICONS = ['search', 'tender', 'money', 'alert'] as const

function Pillars() {
  const { pillars } = page
  return (
    <Section id={ANCHORS.pillars}>
      <Wrap>
        <SectionHead label={pillars.label} title={pillars.title} className="mb-8" />
        {/*
          One panel, not four cards.

          The four are a single claim — *da busca à proposta* — and four
          separate bordered surfaces make them compete, each with its own edge
          and its own shadow of white against the ivory. One surface with
          hairlines between the items says the same thing once: this is the
          tool, in four parts.

          `Band` owns that surface, its column tiers and its dividers — the
          trust row under the hero is the same treatment with three items, and
          the arithmetic that draws the rules is subtle enough (see
          `bandDividers`) that a second copy of it would drift.
        */}
        <Band
          columns={4}
          items={pillars.items.map((item, index) => ({
            key: item.title,
            content: (
              <>
                <span className="grid size-10 place-items-center rounded-swatch bg-blue-soft text-blue">
                  <Icon name={PILLAR_ICONS[index]} size={22} />
                </span>
                <H3>{item.title}</H3>
                <p className="text-base leading-[1.6] text-ink-soft">{item.body}</p>
                <span className="mt-auto pt-1 font-mono text-label tracking-[0.06em] text-muted uppercase">
                  {item.plan}
                </span>
              </>
            ),
          }))}
        />
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
    <Section divided={false}>
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
            <Button variant="onBrand" href="#vaga" className="mt-auto w-full">
              {founderValue.cta}
            </Button>
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

/* ------------------------------------------------------------------ signup */

/**
 * The ask, and the one real product screen on the page, together.
 *
 * The form left the hero (see `Hero`), and this is where it lands: directly
 * under the offer panel, so the order of the page is now price → what it buys
 * → the form, instead of a form beside a headline. It keeps `id="vaga"` and
 * its own `scroll-mt-20` (`signup-form.tsx`), so all four `href="#vaga"` on
 * the page — header, offer panel, final band and the hero's new CTA — land on
 * it with the heading clear of the sticky bar.
 *
 * `ExampleRadar` comes with it, and this is where it earns its place. It is
 * the Radar's own `TenderCardView` over three real PNCP tenders frozen at
 * 17/09/2026, captioned as such — the only actual product on the page, against
 * a hero image that is a visualisation. Its job in the hero was to be evidence
 * beside the ask, and that is exactly the job it still has here: the last
 * thing a visitor reads before typing a name, an e-mail and a WhatsApp number
 * is three real editais, not a drawing. It also gets back the ~510px column it
 * was drawn for on the Landing, which a full-width band would not give it.
 *
 * DOM order is form first: below 900px the column falls in source order, and
 * the ~600px of example must not sit on top of the ask on a phone.
 *
 * `divided={false}`: the offer panel above is its own surface, and a hairline
 * between it and the form would read as a section break through the middle of
 * one offer.
 */
function Signup() {
  return (
    <Section divided={false} className="pt-0 min-[560px]:pt-0">
      <Wrap className="grid items-start gap-8 [&>*]:min-w-0 min-[900px]:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] min-[900px]:gap-10">
        <SignupForm />
        <ExampleRadar />
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
        <ol role="list" className="grid grid-cols-1 gap-x-4 gap-y-8 min-[560px]:grid-cols-2 min-[900px]:grid-cols-4 min-[900px]:gap-y-0">
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
   */
  const questions = faq.columns.flat()

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
                  <p className="pb-4 text-base leading-[1.6] text-ink-soft">{item.a}</p>
                </details>
              ))}
            </div>
          }
        />
      </Wrap>
    </Section>
  )
}

/* ------------------------------------------------------------------- page */

export default function FoundersOfferPage() {
  return (
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
          <a
            href="#topo"
            aria-label={page.nav.home}
            className="inline-flex min-h-touch items-center text-ink no-underline"
          >
            <Logo size={34} />
          </a>

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

          <a
            href="#vaga"
            className="inline-flex min-h-touch items-center text-lead font-semibold whitespace-nowrap text-blue no-underline hover:text-blue-hover"
          >
            {page.nav.cta}
          </a>
        </Wrap>
      </header>

      {/* `scroll-mt-20` for the same reason every `Section` carries it: the
          skip link and the logo both point at `#topo`, and without the offset
          the first thing a keyboard user reveals — the hero badge naming the
          48 seats and the 08/10 opening — renders behind the 64px bar. */}
      <main id="topo" className="scroll-mt-20">
        <Hero />
        <Trust />
        <Pain />
        <PriceChain />
        <Pillars />
        <Screening />
        <FounderValue />
        <Signup />
        <Timeline />
      <Refunds />
        <Faq />

        <Section divided={false}>
          <Wrap>
            <div className="flex flex-wrap items-center justify-between gap-6 rounded-feature bg-blue-soft px-5 py-6 min-[560px]:p-8">
              <div className="flex max-w-[620px] flex-col gap-2">
                <H2>{page.final.title}</H2>
                <p className="text-ink-soft">{messages.brand.promise}</p>
              </div>
              <Button href="#vaga" className="w-full min-[560px]:w-auto">
                {messages.founders.offer.cta}
              </Button>
            </div>
          </Wrap>
        </Section>
      </main>

      <footer className="pt-8 pb-12 text-meta leading-[1.55] text-muted">
        <Wrap className="flex flex-wrap justify-between gap-4">
          <span>{page.footer.company}</span>
          <span>
            <Link
              href={messages.legal.privacyUrl}
              className="text-blue hover:text-blue-hover"
            >
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
  )
}
