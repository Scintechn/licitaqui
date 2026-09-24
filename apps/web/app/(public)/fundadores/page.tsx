import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { Button, Card, CardRow, Icon, Logo, SectionLabel, Status, TagList } from '@/components'
import { cn } from '@/lib/cn'
import { messages } from '@/lib/messages'
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
  className?: string
}) {
  return (
    <div className={cn('flex max-w-[720px] flex-col gap-3', className)}>
      {label ? (
        <SectionLabel tone="muted" size="caption">
          {label}
        </SectionLabel>
      ) : null}
      <H2>{title}</H2>
      {children}
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
 * The hero, which until now showed the product nowhere.
 *
 * `/fundadores` asks for a name, an e-mail and a WhatsApp number before the
 * reader has seen a single screen of the thing: the first piece of product on
 * the page was the screening card in section five, roughly 3 400px down. So
 * `ExampleRadar` moves up here — **that** component and no mock-up of it. It
 * renders `TenderCardView`, the Radar's own card, over three real PNCP tenders
 * frozen at 17/09/2026, and it carries its own caption saying so; a marketing
 * drawing of the same thing would drift from the product within a sprint and
 * start promising screens we do not draw (CDC art. 30 on a page taking money).
 *
 * Three children, one grid, and the order is load-bearing:
 *
 *  - **≥900px** the form is pinned to column two across both rows, so the
 *    example tucks under the headline and beside the form;
 *  - **below that** the single column falls in DOM order — headline, form,
 *    example. The form stays above the ~600px of example, because the page is
 *    taking sign-ups this week and the example is evidence, not the ask.
 */
function Hero() {
  const { hero } = page
  return (
    <div className="pt-7 pb-14">
      <Wrap className="grid items-start gap-7 [&>*]:min-w-0 min-[900px]:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] min-[900px]:gap-x-12 min-[900px]:gap-y-10">
        <div className="flex flex-col gap-[22px] pt-3 min-[900px]:col-start-1 min-[900px]:row-start-1">
          <span className="inline-flex items-center gap-2 self-start rounded-badge bg-attention-soft px-2.5 py-1.5 font-mono text-caption font-medium tracking-[0.06em] text-attention uppercase">
            <span aria-hidden className="inline-block size-[7px] rounded-pill bg-attention" />
            {hero.badge}
          </span>

          <h1 className="font-display text-hero font-extrabold tracking-[-0.01em] text-balance">
            {hero.title}
          </h1>

          <p className="max-w-[34em] text-intro text-ink-soft">{hero.subtitle}</p>

          <ul className="mt-1 grid grid-cols-1 gap-x-5 gap-y-3 min-[560px]:grid-cols-2">
            {hero.promises.map((promise) => (
              <li key={promise} className="flex items-start gap-2.5 text-base leading-[1.45]">
                <Icon name="check" size={20} strokeWidth={2} className="mt-0.5 text-blue" />
                {promise}
              </li>
            ))}
          </ul>
        </div>

        <div className="min-[900px]:col-start-2 min-[900px]:row-span-2 min-[900px]:row-start-1">
          <SignupForm />
        </div>

        <ExampleRadar className="min-[900px]:col-start-1 min-[900px]:row-start-2" />
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
        <ul className="grid grid-cols-1 gap-x-6 gap-y-6 min-[560px]:grid-cols-3">
          {pillars.items.slice(0, 3).map((item, index) => (
            <li key={item.title} className="flex min-w-0 flex-col gap-2.5">
              <span className="grid size-10 place-items-center rounded-swatch bg-blue-soft text-blue">
                <Icon name={TRUST_ICONS[index]} size={22} />
              </span>
              <b className="font-display text-subsection font-bold tracking-[-0.01em] text-balance">
                {item.title}
              </b>
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

function Pain() {
  const { pain } = page
  return (
    <Section>
      <Wrap>
        <SectionHead label={pain.label} title={pain.title} className="mb-8" />

        <div className="grid grid-cols-1 gap-4 min-[900px]:grid-cols-3">
          {pain.items.map((item) => (
            <Card key={item.title} padding="none" className="flex flex-col gap-2.5 p-5">
              <H3>{item.title}</H3>
              <p className="text-base leading-[1.6] text-ink-soft">{item.body}</p>
            </Card>
          ))}
        </div>

        <div className="mt-7 flex flex-wrap items-baseline gap-8">
          {pain.facts.map((fact) => (
            <div key={fact.value}>
              <b className="block font-display text-stat font-extrabold tabular-nums">
                {fact.value}
              </b>
              <span className="text-body leading-[1.55] text-muted">{fact.label}</span>
            </div>
          ))}
        </div>

        <Source className="mt-3.5">{pain.source}</Source>
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
        {/* The eyebrow earns its place here: it names the commodity the four
            figures are about, which the heading deliberately does not. */}
        <SectionHead label={ruler.label} title={ruler.title} className="mb-8">
          <p className="text-base leading-[1.6] text-ink-soft">{ruler.body}</p>
        </SectionHead>

        {/*
          One row from 900px, one column below it. No 2×2 tier: the chain is an
          argument in four steps, and a grid that puts step 3 under step 1
          breaks the reading order the change exists to create.

          Track sizes: the last step holds `R$ 14,60` at 34px mono and cannot
          wrap, so it gets 1.35fr against the other three. Measured at a 900px
          viewport, the narrowest width at which the row is used: 860px of
          Wrap, less three 24px gaps, is 788px over 4.35fr — 181px each for the
          quiet steps and 245px for the last, against the ~203px its value and
          padding need. `[&>*]:min-w-0` so no step can force the grid wider
          than the viewport, the way the comparison table's `min-w-[420px]`
          did to the panel below.
        */}
        <ol className="grid grid-cols-1 gap-x-6 gap-y-9 [&>*]:min-w-0 min-[900px]:grid-cols-[repeat(3,minmax(0,1fr))_minmax(0,1.35fr)] min-[900px]:gap-y-0">
          {steps.map((step, index) => (
            <li key={step.label} className="relative flex">
              <div
                className={cn(
                  'flex w-full items-baseline justify-between gap-3 rounded-panel px-5 py-4',
                  'min-[900px]:h-full min-[900px]:flex-col min-[900px]:items-start min-[900px]:justify-between min-[900px]:gap-3 min-[900px]:py-5',
                  step.emphasis ? 'bg-brand-panel text-on-brand' : 'border border-line bg-surface',
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

              {/* The connector, in the gap: pointing down while the steps are
                  stacked, right once they are a row. Decoration — the order is
                  already in the markup. */}
              {index < steps.length - 1 ? (
                <span
                  aria-hidden
                  className="absolute -bottom-7 left-1/2 grid h-5 -translate-x-1/2 place-items-center text-line-strong min-[900px]:top-1/2 min-[900px]:-right-6 min-[900px]:bottom-auto min-[900px]:left-auto min-[900px]:w-6 min-[900px]:-translate-x-0 min-[900px]:-translate-y-1/2"
                >
                  <Icon name="arrowRight" size={20} className="rotate-90 min-[900px]:rotate-0" />
                </span>
              ) : null}
            </li>
          ))}
        </ol>

        <div className="mt-9 flex max-w-[46em] items-start gap-3 rounded-swatch bg-error-soft px-4 py-3.5 text-base leading-[1.6]">
          <Icon name="warning" size={20} strokeWidth={2} className="mt-0.5 shrink-0 text-error" />
          <span>
            <b className="text-error">{ruler.verdictLead}</b> {ruler.verdictBody}
          </span>
        </div>

        <Source className="mt-4">{ruler.source}</Source>
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
        <div className="grid grid-cols-1 gap-4 min-[560px]:grid-cols-2 min-[900px]:grid-cols-4">
          {pillars.items.map((item, index) => (
            <Card key={item.title} padding="none" className="flex flex-col gap-2.5 p-5">
              <span className="grid size-10 place-items-center rounded-swatch bg-blue-soft text-blue">
                <Icon name={PILLAR_ICONS[index]} size={22} />
              </span>
              <H3>{item.title}</H3>
              <p className="text-base leading-[1.6] text-ink-soft">{item.body}</p>
              <span className="mt-auto font-mono text-label tracking-[0.06em] text-muted uppercase">
                {item.plan}
              </span>
            </Card>
          ))}
        </div>
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

/**
 * Index 1 is `money`, not `visitor`. The second benefit used to be "Acesso
 * antes de todos" — a person icon for early access. D7 replaced that claim with
 * the price range, so the icon moved with the sentence; leaving the old one
 * would illustrate a benefit the card no longer names.
 */
const BENEFIT_ICONS = ['locked', 'money', 'send', 'account'] as const

function FounderValue() {
  const { founderValue } = page
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

            <ul className="flex flex-col gap-[18px]">
              {founderValue.benefits.map((benefit, index) => (
                <li key={benefit.title} className="grid grid-cols-[36px_minmax(0,1fr)] gap-3.5">
                  <span className="grid size-9 place-items-center rounded-control bg-brand-raised text-icon-on-brand">
                    <Icon name={BENEFIT_ICONS[index]} size={20} />
                  </span>
                  <div>
                    <b className="mb-0.5 block text-subhead font-bold text-surface">
                      {benefit.title}
                    </b>
                    <span className="text-base leading-[1.6] text-on-brand-muted">{benefit.body}</span>
                  </div>
                </li>
              ))}
            </ul>
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

            <Button variant="onBrand" href="#vaga" className="mt-auto w-full">
              {founderValue.cta}
            </Button>
          </div>
        </div>
      </Wrap>
    </Section>
  )
}

/* -------------------------------------------------------------- timeline */

function Timeline() {
  const { timeline } = page
  return (
    <Section>
      <Wrap>
        <SectionHead label={timeline.label} title={timeline.title} className="mb-8" />
        <ol className="grid grid-cols-1 gap-x-0 gap-y-7 min-[560px]:grid-cols-2 min-[900px]:grid-cols-4 min-[900px]:gap-y-0">
          {timeline.steps.map((step, index) => (
            <li
              key={step.title}
              className={cn(
                'relative flex flex-col gap-2 pr-5',
                "before:mb-3.5 before:block before:h-0.5 before:content-['']",
                index === 0 ? 'before:bg-blue' : 'before:bg-line-strong',
              )}
            >
              <span className="font-mono text-caption font-medium tracking-[0.06em] text-blue uppercase">
                {step.when}
              </span>
              <H3>{step.title}</H3>
              <p className="text-base leading-[1.6] text-ink-soft">{step.body}</p>
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
  return (
    <Section id={ANCHORS.faq}>
      <Wrap>
        <SectionHead label={faq.label} title={faq.title} className="mb-8" />
        <div className="grid grid-cols-1 gap-x-10 min-[900px]:grid-cols-2">
          {faq.columns.map((column, index) => (
            <div key={index}>
              {column.map((item) => (
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
          ))}
        </div>
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
