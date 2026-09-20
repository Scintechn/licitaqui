import { SectionLabel, Status } from '@/components'
import { cn } from '@/lib/cn'
import { format, messages } from '@/lib/messages'
import { TENDER_GROUPS } from '@/lib/radar/contract'
import {
  EXAMPLE_AS_OF,
  EXAMPLE_NOW,
  EXAMPLE_STATE,
  EXAMPLE_TENDERS,
  exampleCounts,
} from '@/lib/radar/landing-example'
import { TenderCardView } from '@/app/radar/tender-card'

/**
 * The "Exemplo" panel of the approved landing (`paginas/landing_radar.html`,
 * the `.radar` block in the hero) — the one thing on the page that shows a
 * visitor what they get before they type a CNPJ.
 *
 * ## It is an example, and it has to keep saying so
 *
 * Three real tenders from the PNCP, frozen at 17/09/2026
 * (`lib/radar/landing-example.ts`). Everything that could let it be read as a
 * live feed is deliberately closed off:
 *
 *  - the panel is headed "Exemplo", in the board's mono label;
 *  - the caption under the list names the date the three are stated as of and
 *    says in as many words that this is not a live search;
 *  - the countdowns are measured against that frozen date, so they never tick
 *    down to a deadline that has passed;
 *  - the cards do not link anywhere (`href={null}`), because the tender behind
 *    each one closed long ago;
 *  - the group chips are a list, not links: the real tabs are on `/radar`, and
 *    a chip here that looked clickable and did nothing would be a worse lie
 *    than no chip at all.
 *
 * ## Why it renders `TenderCardView`
 *
 * It is the Radar's own card, not a copy of it: same badges, same ME/EPP tags,
 * same money and deadline formatting. A second card built for marketing would
 * drift from the product within a sprint, and then the page would be promising
 * something the Radar does not draw.
 */

const copy = messages.radar.landing.example
const list = messages.radar.list

export function ExampleRadar({ className }: { className?: string }) {
  const counts = exampleCounts()

  return (
    <section
      aria-label={copy.panelLabel}
      className={cn(
        'overflow-hidden rounded-feature border border-line bg-surface',
        'shadow-[0_24px_50px_-36px_rgba(23,23,23,0.45)]',
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3.5">
        <div>
          <SectionLabel tone="muted">{copy.label}</SectionLabel>
          <b className="text-lead font-semibold">
            {format(copy.company, { empresa: list.companyFallback })}
          </b>
        </div>
        <Status kind="compatible">{EXAMPLE_STATE}</Status>
      </div>

      {/* The board's `.segmentos` row. A list, because that is what it is: the
          counts describe the three examples below, and nothing here navigates. */}
      <ul
        aria-label={copy.groupsLabel}
        className="m-0 flex list-none flex-wrap gap-1.5 px-4 pt-3 pb-0"
      >
        {TENDER_GROUPS.map((group, index) => (
          <li
            key={group}
            className={cn(
              'inline-flex min-h-9 items-center gap-1.5 rounded-pill border px-3 text-meta font-medium whitespace-nowrap',
              index === 0
                ? 'border-ink bg-ink text-surface'
                : 'border-line-strong bg-surface text-ink',
            )}
          >
            {list.groups[group]}
            <span className="font-mono text-caption opacity-80">{counts[group]}</span>
          </li>
        ))}
      </ul>

      <ul className="m-0 flex list-none flex-col gap-2.5 p-4">
        {EXAMPLE_TENDERS.map((tender) => (
          <li key={tender.id} className="flex">
            <TenderCardView tender={tender} now={EXAMPLE_NOW} href={null} />
          </li>
        ))}
      </ul>

      <p className="border-t border-line bg-fill-muted px-4 py-3 text-caption leading-[1.45] text-muted">
        {format(copy.caption, { data: EXAMPLE_AS_OF })}
      </p>
    </section>
  )
}
