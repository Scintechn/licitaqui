import type { Metadata } from 'next'
import Link from 'next/link'
import type { ReactNode } from 'react'
import { Button, Card, CardRow, Icon, Logo, SectionLabel, Status, TagList } from '@/components'
import { cn } from '@/lib/cn'
import { messages } from '@/lib/messages'
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
  className,
}: {
  children: ReactNode
  /** `.borda-topo` — a hairline separating this section from the one above. */
  divided?: boolean
  className?: string
}) {
  return (
    <section className={cn('py-10 min-[560px]:py-12', divided && 'border-t border-line', className)}>
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

function Hero() {
  const { hero } = page
  return (
    <div className="pt-7 pb-14">
      <Wrap className="grid items-start gap-7 min-[900px]:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] min-[900px]:gap-12">
        <div className="flex flex-col gap-[22px] pt-3">
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

        <SignupForm />
      </Wrap>
    </div>
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

/* ------------------------------------------------------------- price ruler */

/**
 * A marker on the price ruler. `side` decides whether it hangs above the bar or
 * below it; `left` is its position on the R$ 10 – R$ 40 scale.
 */
function RulerMark({
  left,
  side,
  tone,
  value,
  label,
}: {
  left: string
  side: 'above' | 'below'
  tone: string
  value: string
  label: string
}) {
  return (
    <div
      style={{ left }}
      className={cn(
        'absolute flex w-24 -translate-x-1/2 flex-col items-center gap-1 text-center min-[560px]:w-[130px]',
        side === 'above' ? 'top-0' : 'bottom-0 flex-col-reverse',
        tone,
      )}
    >
      <span className="font-mono text-base font-medium min-[560px]:text-xl">{value}</span>
      <span className="text-caption leading-[1.25] whitespace-nowrap text-muted">{label}</span>
      <span aria-hidden className="mt-0.5 h-[22px] w-0.5 bg-current" />
    </div>
  )
}

function PriceRuler() {
  const { ruler } = page
  return (
    <Section>
      <Wrap>
        <div className="grid items-center gap-7 rounded-panel border border-line bg-surface p-5 min-[560px]:p-7 min-[900px]:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)] min-[900px]:gap-9">
          <div className="flex flex-col gap-3.5">
            <SectionLabel tone="muted" size="caption">
              {ruler.label}
            </SectionLabel>
            <H2>{ruler.title}</H2>
            <p className="text-ink-soft">{ruler.body}</p>
            <Source>{ruler.source}</Source>
          </div>

          <div>
            <div className="relative pt-[84px] pb-[92px]" role="img" aria-label={ruler.alt}>
              <RulerMark
                left="33.3%"
                side="above"
                tone="text-ink"
                value={ruler.winnerValue}
                label={ruler.winner}
              />
              <RulerMark
                left="86.7%"
                side="above"
                tone="text-ink"
                value={ruler.tenderValue}
                label={ruler.tender}
              />
              {/* 15.3% is where a 15% margin stops being possible: green up to
                  there, red after it. */}
              <div className="relative h-3.5 rounded-pill border border-line bg-[linear-gradient(90deg,var(--color-success-soft)_0_15.3%,var(--color-error-soft)_15.3%_100%)]" />
              <RulerMark
                left="15.3%"
                side="below"
                tone="text-success"
                value={ruler.maxPurchaseValue}
                label={ruler.maxPurchase}
              />
              <RulerMark
                left="63.3%"
                side="below"
                tone="text-error"
                value={ruler.retailValue}
                label={ruler.retail}
              />
            </div>

            <div className="mt-2 flex justify-between font-mono text-label text-muted">
              <span>{ruler.scaleStart}</span>
              <span>{ruler.scaleEnd}</span>
            </div>

            <div className="mt-4 flex items-start gap-3 rounded-swatch bg-error-soft px-4 py-3.5 text-base leading-[1.6]">
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
          </div>
        </div>
      </Wrap>
    </Section>
  )
}

/* ---------------------------------------------------------------- pillars */

const PILLAR_ICONS = ['search', 'tender', 'money', 'alert'] as const

function Pillars() {
  const { pillars } = page
  return (
    <Section>
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
    <Section>
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

const BENEFIT_ICONS = ['locked', 'visitor', 'send', 'account'] as const

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
                that fits. `<table>` is kept — it *is* tabular data, and the
                headers stay for assistive technology, hidden visually where
                the layout stacks. */}
            <div>
              <table className="w-full border-collapse text-body leading-[1.55] max-[559px]:block">
                <thead className="max-[559px]:sr-only">
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
                      {/* Below 560px the column header is `sr-only`, so each
                          value carries its own label. `aria-hidden` on the
                          inline label: the real `<th>` is still associated
                          with the cell, and announcing both would say it
                          twice. */}
                      <td
                        className={cn(
                          'border-b border-brand-line px-2 py-2.5 align-top',
                          'max-[559px]:block max-[559px]:border-0 max-[559px]:py-0.5 max-[559px]:text-on-brand-muted',
                          index === 0 && 'font-mono tabular-nums',
                        )}
                      >
                        <span aria-hidden className="hidden max-[559px]:mr-1.5 max-[559px]:inline font-sans text-caption text-on-brand-faint">
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
                        <span aria-hidden className="hidden max-[559px]:mr-1.5 max-[559px]:inline font-sans text-caption font-normal text-on-brand-faint">
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
    <Section>
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
        <Wrap className="flex min-h-16 items-center justify-between gap-3">
          <a
            href="#topo"
            aria-label={page.nav.home}
            className="inline-flex min-h-touch items-center text-ink no-underline"
          >
            <Logo size={34} />
          </a>
          <a
            href="#vaga"
            className="inline-flex min-h-touch items-center text-lead font-semibold whitespace-nowrap text-blue no-underline hover:text-blue-hover"
          >
            {page.nav.cta}
          </a>
        </Wrap>
      </header>

      <main id="topo">
        <Hero />
        <Pain />
        <PriceRuler />
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
