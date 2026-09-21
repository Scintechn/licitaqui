import type { ReactNode } from 'react'
import {
  Button,
  CardRow,
  Icon,
  LockedValue,
  LogoSymbol,
  SectionLabel,
  Status,
  Tag,
  type StatusKind,
} from '@/components'
import { cn } from '@/lib/cn'
import type { FounderSeatsView } from '@/lib/founders/seat-count'
import { format, messages } from '@/lib/messages'
import { TENDER_GROUPS } from '@/lib/radar/contract'
import { EXAMPLE_AS_OF } from '@/lib/radar/landing-example'
import { H3, Panel, Section, SectionHead, Source, Wrap } from './page-parts'

/**
 * Everything on the Landing below the hero, in the order
 * `paginas/landing_radar.html` puts it: how it works, the opportunity example,
 * the Telegram alert, the plans, the guarantees and the questions.
 *
 * Nothing here holds state, so it all renders on the server and can be asserted
 * with `renderToStaticMarkup` in `page.test.tsx`.
 *
 * Every price and quota is read from `messages.plans.*`, the catalogue spec §10
 * fills. No figure is typed into a component, and the one number that is not in
 * the catalogue — how many founder seats are left — is read from the database
 * at render time or left out (see `seatsLine`).
 */

const copy = messages.radar.landing
const list = messages.radar.list
const plans = messages.plans

/* ------------------------------------------------------------ como funciona */

const LEGEND: { kind: StatusKind; group: (typeof TENDER_GROUPS)[number] }[] = [
  { kind: 'compatible', group: 'compatible' },
  { kind: 'check', group: 'check' },
  { kind: 'keyword', group: 'keyword' },
]

export function HowItWorks() {
  return (
    <Section id="como-funciona">
      <Wrap>
        <SectionHead label={copy.how.label} title={copy.how.title} className="mb-8" />
        <ol className="m-0 grid list-none grid-cols-1 gap-4 p-0 min-[900px]:grid-cols-3">
          {copy.how.steps.map((step, index) => (
            <li key={step.title} className="flex">
              <Panel className="flex w-full flex-col gap-2.5 p-5">
                <span className="font-mono text-meta font-medium text-blue">{step.eyebrow}</span>
                <H3>{step.title}</H3>
                <p className="text-lead leading-[1.55] text-ink-soft">{step.body}</p>

                {/* The board puts the three Radar groups inside step 2: the
                    badges are the product's own, so the legend and the Radar
                    can never disagree about what "Verificar" looks like. */}
                {index === 1 ? (
                  <div className="mt-1 flex flex-col gap-2.5">
                    {LEGEND.map((entry) => (
                      <div key={entry.group} className="flex flex-wrap items-center gap-2">
                        <Status kind={entry.kind}>{list.badges[entry.group]}</Status>
                        <span className="text-body text-ink-soft">
                          {list.groupHint[entry.group]}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </Panel>
            </li>
          ))}
        </ol>
      </Wrap>
    </Section>
  )
}

/* --------------------------------------------------------- a oportunidade */

/** One of the three figures across the top of the example opportunity card. */
function Figure({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-swatch bg-fill-muted p-3">
      <span className="text-caption text-muted">{label}</span>
      {/* 18px on a phone, 22px from 560px — the source's own media query, so the
          three figures stay on one row at 390px instead of stacking. */}
      <b className="font-display text-[18px] leading-[1.1] font-extrabold tabular-nums min-[560px]:text-[22px]">
        {value}
      </b>
      <span className="text-caption text-muted">{note}</span>
    </div>
  )
}

/**
 * "Saiba se vale disputar. E até que preço." — one real tender opened up, with
 * the price band still behind the plan.
 *
 * Like the Radar panel in the hero, this is one edital from a fixed date and
 * says so twice: the label above it and the source line under it.
 */
export function Opportunity() {
  const { opportunity } = copy
  return (
    <Section>
      <Wrap className="grid items-center gap-7 min-[900px]:grid-cols-2 min-[900px]:gap-10">
        <Panel className="flex flex-col gap-3.5 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <SectionLabel tone="muted">{opportunity.cardLabel}</SectionLabel>
            <Status kind="positive">{messages.radar.tags.exclusive}</Status>
          </div>

          <H3>{opportunity.tender}</H3>

          <div className="grid grid-cols-3 gap-2.5">
            <Figure
              label={opportunity.deadlineLabel}
              value={opportunity.deadlineValue}
              note={opportunity.deadlineNote}
            />
            <Figure
              label={opportunity.valueLabel}
              value={opportunity.valueValue}
              note={format(messages.radar.card.items, { count: 7 })}
            />
            <Figure
              label={opportunity.scoreLabel}
              value={opportunity.scoreValue}
              note={opportunity.scoreNote}
            />
          </div>

          <div>
            {opportunity.rows.map((row, index) => (
              <CardRow
                key={row.label}
                last={index === opportunity.rows.length - 1}
                label={<span className="text-muted">{row.label}</span>}
                value={row.value}
                aside={<span className="rounded-[4px] bg-fill-muted px-1.5 py-0.5">{row.page}</span>}
              />
            ))}
          </div>

          <p className="text-caption leading-[1.45] text-muted">{messages.ai.disclaimer}</p>

          {/* The board's locked block: the price band exists, the plan does not
              yet. A dashed surface with a real link out, never a dead control. */}
          <div className="flex flex-col gap-2.5 rounded-card border border-dashed border-line-strong bg-fill-muted p-4">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              <b className="inline-flex items-center gap-2 text-lead font-semibold">
                <Icon name="locked" size={18} className="text-blue" />
                {opportunity.lockedTitle}
              </b>
              <Tag tone="muted">{plans.essential.name}</Tag>
            </div>
            <span aria-hidden className="flex flex-col gap-1.5">
              <LockedValue width="82%" height={10} />
              <LockedValue width="58%" height={10} />
            </span>
            <p className="text-meta leading-[1.45] text-muted">{plans.locked.priceBand}</p>
            <Button href="#planos" fullWidth>
              {opportunity.lockedCta}
            </Button>
          </div>

          <Source>{format(opportunity.source, { data: EXAMPLE_AS_OF })}</Source>
        </Panel>

        <SectionHead label={opportunity.label} title={opportunity.title} className="mb-0">
          <p className="text-lg leading-[1.55] text-ink-soft">{opportunity.body}</p>
        </SectionHead>
      </Wrap>
    </Section>
  )
}

/* ------------------------------------------------------------------ alertas */

export function Alerts() {
  const { alerts } = copy
  return (
    <Section>
      <Wrap className="grid items-center gap-7 min-[900px]:grid-cols-2 min-[900px]:gap-10">
        <SectionHead label={alerts.label} title={alerts.title} className="mb-0">
          <p className="text-lg leading-[1.55] text-ink-soft">{alerts.body}</p>
        </SectionHead>

        <div
          role="group"
          aria-label={alerts.messageLabel}
          className="flex max-w-[460px] flex-col gap-3 rounded-feature border border-line bg-surface p-4"
        >
          <div className="flex items-center gap-2.5 text-body">
            <span className="grid size-9 shrink-0 place-items-center rounded-pill bg-blue">
              <LogoSymbol size={22} tone="ivory" />
            </span>
            <span>
              <b className="block font-semibold">{messages.brand.name}</b>
              <span className="text-caption text-muted">{alerts.when}</span>
            </span>
          </div>

          <b className="text-lead font-semibold">{alerts.heading}</b>

          {alerts.items.map((item, index) => (
            <div
              key={item.text}
              className={cn(
                'border-l-[3px] pl-2.5 text-body leading-[1.45]',
                index === 1 ? 'border-attention' : 'border-blue',
              )}
            >
              {item.text}
              <br />
              <span className="text-muted">{item.note}</span>
            </div>
          ))}

          {/* Part of the picture of a Telegram message, not controls: they are
              plain text, so nothing here takes focus or promises a click. */}
          <div className="grid grid-cols-2 gap-2">
            {alerts.actions.map((action) => (
              <span
                key={action}
                className="rounded-control border border-line-strong px-2 py-2.5 text-center text-meta font-semibold text-blue"
              >
                {action}
              </span>
            ))}
          </div>
        </div>
      </Wrap>
    </Section>
  )
}

/* ------------------------------------------------------------------- planos */

function Feature({ children }: { children: ReactNode }) {
  return (
    <li className="grid grid-cols-[18px_minmax(0,1fr)] gap-2.5 text-body leading-[1.4]">
      <Icon name="check" size={18} strokeWidth={2} className="mt-0.5 text-blue" />
      <span>{children}</span>
    </li>
  )
}

function Price({ value, unit }: { value: string; unit?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <b className="font-display text-[40px] leading-none font-extrabold tabular-nums">{value}</b>
      {unit ? <span className="text-body text-muted">{unit}</span> : null}
    </div>
  )
}

/**
 * "Restam 12 vagas", or — when the count could not be read — the number of
 * seats that exist, with no claim about how many are left.
 *
 * Exported for the test that pins that second branch: a fabricated remaining
 * number on a scarcity offer is the one failure this page must not have.
 */
export function seatsLine(seats: FounderSeatsView | null): string {
  if (!seats) return messages.foundersPage.signup.seatsGroup
  return format(messages.founders.seats.left, { count: seats.left })
}

/** The three plans of spec §10, priced from `messages.plans`. */
export function Plans({ seats }: { seats: FounderSeatsView | null }) {
  return (
    <Section id="planos">
      <Wrap>
        <SectionHead label={copy.plans.label} title={copy.plans.title} className="mb-8">
          <p className="text-lg leading-[1.55] text-ink-soft">{copy.plans.body}</p>
        </SectionHead>

        <div className="grid grid-cols-1 items-stretch gap-4 min-[900px]:grid-cols-3">
          {/* Básico — free, and split the way access actually is (§10): what a
              visitor gets in three days, then what an account adds. */}
          <Panel className="flex flex-col gap-4 p-6">
            <SectionLabel tone="muted" size="caption">
              {copy.plans.basicEyebrow}
            </SectionLabel>
            <H3>{plans.basic.name}</H3>
            <Price value={plans.basic.price} />

            <SectionLabel tone="muted">{copy.plans.basicVisitorGroup}</SectionLabel>
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              <Feature>{plans.basic.feature1}</Feature>
              <Feature>{copy.plans.basicVisitorScreenings}</Feature>
            </ul>

            <SectionLabel tone="muted">{copy.plans.basicAccountGroup}</SectionLabel>
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              <Feature>{plans.basic.feature3}</Feature>
              <Feature>{plans.basic.feature2}</Feature>
              <Feature>{plans.basic.feature4}</Feature>
            </ul>

            <Button href="#inicio" variant="secondary" fullWidth className="mt-auto">
              {copy.plans.basicCta}
            </Button>
          </Panel>

          {/* Essencial, at the founders' promotional price while seats last. */}
          <Panel accent className="flex flex-col gap-4 p-6">
            <SectionLabel tone="accent" size="caption">
              {copy.plans.essentialEyebrow}
            </SectionLabel>
            <H3>{plans.essential.name}</H3>
            <Price value={plans.essential.price} unit={plans.monthly} />

            <div className="flex flex-col gap-1 rounded-swatch bg-attention-soft p-3 text-body leading-[1.45]">
              <b className="text-attention">
                {plans.promo.price} {plans.monthly} · {plans.promo.badge}
              </b>
              <span>{seatsLine(seats)}</span>
              <span className="text-muted">{plans.promo.priceChangeNote}</span>
            </div>

            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              <Feature>{plans.essential.feature3}</Feature>
              <Feature>{plans.essential.feature1}</Feature>
              <Feature>{plans.essential.feature2}</Feature>
              <Feature>{plans.essential.feature4}</Feature>
            </ul>

            <Button href="/fundadores" fullWidth className="mt-auto">
              {messages.founders.offer.cta}
            </Button>
            <p className="text-caption leading-[1.45] text-muted">
              {copy.plans.essentialPaymentNote}
            </p>
          </Panel>

          {/* Pro — announced, not for sale. It carries no call to action, because
              there is nothing on the other side of one yet. */}
          <Panel className="flex flex-col gap-4 p-6">
            <SectionLabel tone="muted" size="caption">
              {copy.plans.proEyebrow}
            </SectionLabel>
            <div className="flex flex-wrap items-center gap-2">
              <H3>{plans.pro.name}</H3>
              <Tag tone="muted">{copy.plans.proSoon}</Tag>
            </div>
            <Price value={plans.pro.price} unit={plans.monthly} />
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              <Feature>{plans.pro.feature1}</Feature>
              <Feature>{plans.pro.feature2}</Feature>
              <Feature>{plans.pro.feature4}</Feature>
              <Feature>{plans.pro.feature3}</Feature>
            </ul>
            <p className="mt-auto text-caption leading-[1.45] text-muted">{copy.plans.proNote}</p>
          </Panel>
        </div>
      </Wrap>
    </Section>
  )
}

/* --------------------------------------------------------------- garantias */

export function Guarantees() {
  return (
    <Section>
      <Wrap>
        <div className="grid grid-cols-1 gap-4 min-[560px]:grid-cols-2 min-[900px]:grid-cols-4">
          {copy.guarantees.map((item) => (
            <div key={item.title} className="flex flex-col gap-1.5 border-t-2 border-ink pt-3.5">
              <b className="text-base font-semibold">{item.title}</b>
              <span className="text-body leading-[1.55] text-ink-soft">{item.body}</span>
            </div>
          ))}
        </div>
      </Wrap>
    </Section>
  )
}

/* --------------------------------------------------------------- perguntas */

export function Faq() {
  return (
    <Section id="perguntas">
      <Wrap>
        <SectionHead label={copy.faq.label} title={copy.faq.title} className="mb-8" />
        <div className="grid grid-cols-1 gap-x-10 min-[900px]:grid-cols-2">
          {copy.faq.columns.map((column, index) => (
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
                  <p className="pb-4 text-lead leading-[1.55] text-ink-soft">{item.a}</p>
                </details>
              ))}
            </div>
          ))}
        </div>
      </Wrap>
    </Section>
  )
}

/* ----------------------------------------------------------------- rodapé */

/**
 * `/privacidade` and `/termos` are published by the legal lane running beside
 * this one; the approved page anchors these two links and the routes exist.
 */
export function Footer() {
  return (
    <footer
      aria-label={copy.footer.label}
      className="pt-8 pb-12 text-meta leading-[1.55] text-muted"
    >
      <Wrap className="flex flex-wrap justify-between gap-4">
        <span>{messages.foundersPage.footer.company}</span>
        <span>
          <a href="/privacidade" className="text-blue hover:text-blue-hover">
            {messages.legal.privacyLabel}
          </a>{' '}
          ·{' '}
          <a href="/termos" className="text-blue hover:text-blue-hover">
            {messages.legal.termsLabel}
          </a>
        </span>
      </Wrap>
    </footer>
  )
}
