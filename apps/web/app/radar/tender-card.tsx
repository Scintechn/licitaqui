import { Card, Icon, Status, Tag, TagList, type StatusKind } from '@/components'
import { tenderHref } from '@/lib/radar/client'
import type { TenderCard, TenderGroup } from '@/lib/radar/contract'
import { agencyLine, deadlineShort, meEppSummary } from '@/lib/radar/format'
import { cardHeadline, deadlineLabel } from '@/lib/radar/headline'
import { tenderObject } from '@/lib/radar/object'
import { mayShowUrgency, statusChipLabel } from '@/lib/radar/tender-status'
import { cn } from '@/lib/cn'
import { format, messages } from '@/lib/messages'

export { deadlineLabel }

/**
 * One tender in the Radar list — canvas 02, `Editais.dc.html`, the card that
 * repeats three times down the screen.
 *
 * Transcribed row for row from the board: status badge and countdown, title,
 * agency line, the value in Archivo with the item count beside it, the ME/EPP
 * tags, and the deadline line closed by a chevron.
 *
 * Two things the board could not know, because it was drawn against a tender
 * that had a budget and a hand-written title:
 *
 *  - the Archivo slot holds whichever fact `cardHeadline()` elects, because on
 *    real data the estimated value is absent on almost every card and an anchor
 *    that reads "Valor não informado" nineteen times is not an anchor;
 *  - the title is `tenderTitle()`, not the raw PNCP object, which arrives
 *    shouted and with the sourcing portal bolted on the front.
 *
 * The clickable part of the card is one `<a>`, not a div with a click handler
 * and a nested link: one keyboard stop for the whole tender, one screen-reader
 * target, and the middle button opens it in a tab like any other link.
 *
 * It used to be the *entire* card, and is not any more, because of "Objeto
 * completo" (see `ObjectDisclosure` below): a `<details>` is interactive
 * content and cannot live inside an `<a>`. So the card is now a surface
 * holding a link and, when there is more object than the title shows, a
 * disclosure under it — two keyboard stops on those cards instead of one,
 * which is what an in-place expander costs and what it is worth.
 *
 * No hooks and no handlers, so it renders on the server and in a test with
 * `renderToStaticMarkup`. `now` is injected for the same reason: a card whose
 * countdown depends on the wall clock cannot be asserted.
 */

const copy = messages.radar
const list = copy.list

const STATUS: Record<TenderGroup, { kind: StatusKind; label: string }> = {
  compatible: { kind: 'compatible', label: list.badges.compatible },
  check: { kind: 'check', label: list.badges.check },
  keyword: { kind: 'keyword', label: list.badges.keyword },
}

/**
 * The ME/EPP regime and the SRP flag, in the board's tag tones. `none` is
 * shown rather than omitted: "Sem cota ME/EPP" is the board's own tag and it
 * is the fact a micro-business most needs to see before spending an evening on
 * a tender it will dispute against companies of any size.
 */
export function TenderTags({ tender }: { tender: TenderCard }) {
  const regime = meEppSummary(tender.meEppSummary)
  const tags: Array<{ key: string; tone: 'blue' | 'neutral' | 'muted'; label: string }> = []

  if (regime === 'exclusive') tags.push({ key: regime, tone: 'blue', label: copy.tags.exclusive })
  if (regime === 'quota') tags.push({ key: regime, tone: 'neutral', label: copy.tags.quota })
  if (regime === 'mixed') tags.push({ key: regime, tone: 'blue', label: copy.tags.mixed })
  if (regime === 'none') tags.push({ key: regime, tone: 'muted', label: copy.tags.none })
  if (tender.favoredTreatment && regime !== 'exclusive' && regime !== 'mixed') {
    tags.push({ key: 'favored', tone: 'blue', label: copy.tags.favored })
  }
  if (tender.priceRegistration) {
    tags.push({ key: 'srp', tone: 'neutral', label: copy.tags.priceRegistration })
  }

  if (tags.length === 0) return null
  return (
    <TagList>
      {tags.map((tag) => (
        <Tag key={tag.key} tone={tag.tone}>
          {tag.label}
        </Tag>
      ))}
    </TagList>
  )
}

/**
 * "Objeto completo" — the rest of the text, on the card, for nothing.
 *
 * Sci, comparing us with PNCP: *"Like we have in PNCP I just need one click to
 * see the brief description in 'Objeto'. In our application we need at least 2
 * or 3 clicks, or to request the AI — for something that is already there,
 * free."* He is right twice over. The full string is in the list payload
 * (`tenders.ts` selects `t.object`), so reading it costs no request; and it has
 * nothing to do with the AI screening, so paying a triagem to be told what the
 * object says is spending quota on text the browser already holds.
 *
 * ## Why `<details>` and not a `useState`
 *
 * Three reasons, in order of how much they matter:
 *
 *  1. it keeps this file free of hooks, which is what lets the whole card —
 *     every card in the list — render on the server and be asserted with
 *     `renderToStaticMarkup`;
 *  2. `summary` is already a keyboard stop with Enter and Space bound, already
 *     announced as a disclosure with its expanded state, and already
 *     searchable by the browser's own find-in-page;
 *  3. it works before React has hydrated, like the filter row above it.
 *
 * Collapsed is the default and stays it: the list is meant to be scanned, and
 * twenty 200-character paragraphs is not a list. The panel opens *below* its
 * own trigger inside its own card, so nothing above the reader's eye moves;
 * what is below it moves down, which is what an accordion is.
 */
function ObjectDisclosure({ text }: { text: string }) {
  return (
    <details className="group border-t border-line">
      <summary
        className={cn(
          'flex min-h-touch cursor-pointer list-none items-center gap-1.5 px-3.5',
          'text-meta font-medium text-blue [&::-webkit-details-marker]:hidden',
        )}
      >
        <Icon
          name="chevronRight"
          size={14}
          className="transition-transform group-open:rotate-90"
        />
        {list.object.label}
      </summary>
      <p className="px-3.5 pb-3.5 text-meta leading-relaxed text-ink">{text}</p>
    </details>
  )
}

export function TenderCardView({
  tender,
  now = new Date(),
  href,
}: {
  tender: TenderCard
  now?: Date
  /**
   * Where the card goes. Defaults to this tender's page on the Radar.
   *
   * `null` renders the same card as a plain surface instead of a link — the
   * Landing's "Exemplo" panel, which shows three real tenders frozen at a past
   * date (`lib/radar/landing-example.ts`). Linking those would take a visitor
   * to whatever the database holds for that id today, or to a 404. A card that
   * leads nowhere must also not be a keyboard stop, so it is not an `<a>` with
   * the href removed: it is not an anchor at all.
   */
  href?: string | null
}) {
  const status = STATUS[tender.group]
  const headline = cardHeadline(tender, now)
  const deadline = deadlineShort(tender.proposalsCloseAt)
  const target = href === undefined ? tenderHref(tender.id) : href
  const object = tenderObject(tender.object)
  // The gate (§2.2 rule 6), asked once for the whole card.
  const urgency = mayShowUrgency(tender)
  const statusChip = statusChipLabel(tender)

  // When the deadline has been promoted into the anchor it is the same string
  // the top-right countdown prints, so the countdown steps aside rather than
  // saying "13 dias" twice on one card.
  const countdown =
    !urgency || headline.anchor?.fact === 'deadline'
      ? null
      : deadlineLabel(tender.proposalsCloseAt, now)

  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Status kind={status.kind}>{status.label}</Status>
          {/* §3.3: the state has to be visible *before* the tender is opened,
              or the user spends the click to find out. Where the countdown
              used to be is exactly where they were already looking. */}
          {statusChip === null ? null : <Status kind="check">{statusChip}</Status>}
        </div>
        {countdown === null ? null : (
          <span className="text-caption text-muted">{countdown}</span>
        )}
      </div>

      <div className="text-lead leading-[1.3] font-semibold">{object.title}</div>

      <div className="text-meta text-muted">{agencyLine(tender)}</div>

      <div className="flex flex-col gap-0.5">
        <div className="flex items-baseline justify-between gap-2">
          {headline.anchor === null ? (
            <span />
          ) : (
            <span className="font-display text-[22px] leading-none font-semibold tabular-nums">
              {headline.anchor.text}
            </span>
          )}
          {/* The item count keeps its place beside the anchor unless it *is*
              the anchor, which would print it twice. */}
          {tender.itemCount === null || headline.anchor?.fact === 'items' ? null : (
            <span className="text-caption text-muted">
              {format(copy.card.items, { count: tender.itemCount })}
            </span>
          )}
        </div>
        {headline.note === null ? null : (
          <span className="text-meta text-muted">{headline.note}</span>
        )}
      </div>

      <TenderTags tender={tender} />

      {/* The date stays — a user tracking this tender needs to know which one
          lapsed — but "Proposta até 30/09" asserts the window is still open,
          so on a stopped tender it is relabelled "Data anterior". */}
      <div className="flex items-center gap-2 text-meta text-muted">
        <Icon name="deadline" size={16} />
        <span className="grow">
          {deadline
            ? format(urgency ? copy.card.proposalsUntil : copy.card.previousDeadline, {
                quando: deadline,
              })
            : copy.card.noDeadline}
        </span>
        {target === null ? null : <Icon name="chevronRight" size={16} />}
      </div>
    </>
  )

  // `w-full` matters: the list item is a flex container so the cards stretch
  // to equal height in the desktop grid, and a block child of a flex parent
  // is shrink-to-fit, not full width.
  //
  // `padding="none"` on the surface, and the padding on the link and the
  // disclosure instead: the hairline between them has to reach both edges of
  // the card, and the summary has to be a 44px touch target across its whole
  // width rather than a label with a padded gap around it.
  //
  // `has-[a:hover]:` reproduces what `CardLink` did with `hover:` — the border
  // lifts when the *link* is hovered, not when the pointer is anywhere on the
  // card, so hovering "Objeto completo" does not promise a navigation.
  const expander = object.expandable ? <ObjectDisclosure text={object.full} /> : null

  if (target === null) {
    return (
      <Card padding="none" className="flex w-full flex-col">
        <div className="flex grow flex-col gap-2 p-3.5">{body}</div>
        {expander}
      </Card>
    )
  }

  return (
    <Card
      padding="none"
      className="flex w-full flex-col transition-colors has-[a:hover]:border-line-strong"
    >
      <a href={target} className="flex grow flex-col gap-2 p-3.5 text-ink no-underline">
        {body}
      </a>
      {expander}
    </Card>
  )
}
