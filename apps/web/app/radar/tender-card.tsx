import { Card, CardLink, Icon, Status, Tag, TagList, type StatusKind } from '@/components'
import type { TenderCard, TenderGroup } from '@/lib/radar/contract'
import { agencyLine, deadlineShort, displayTitle, meEppSummary } from '@/lib/radar/format'
import { cardHeadline, deadlineLabel } from '@/lib/radar/headline'
import { mayShowUrgency, statusChipLabel } from '@/lib/radar/tender-status'
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
 *  - the title is `displayTitle()` — the worker's `short_title` when it has
 *    written one, and the cleaned-up object when it has not. The raw PNCP
 *    object arrives shouted and with the sourcing portal bolted on the front.
 *
 * The whole card is one `<a>`: one keyboard stop for the whole tender, one
 * screen-reader target, and the middle button opens it in a tab like any other
 * link.
 *
 * It briefly was not. "Objeto completo" put a `<details>` on the card — a
 * `<details>` is interactive content and cannot live inside an `<a>` — so the
 * card became a surface holding a link plus a disclosure, at two keyboard
 * stops instead of one. The disclosure is gone and the card is a `CardLink`
 * again. Sci: *"I don't think it's needed, because we will have the whole
 * description inside the item."* The Opportunity screen now prints the whole
 * Objeto expanded, above its Itens tab, so the tail the disclosure revealed is
 * one tap away on the screen that also carries the items, the files and the
 * deadline — and the list goes back to being a list.
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

export function TenderCardView({
  tender,
  now = new Date(),
  href,
}: {
  tender: TenderCard
  now?: Date
  /**
   * Where the card goes. **Required**, because the one thing this link must
   * carry is the search that found the tender (`client.ts`'s `tenderHref`), and
   * a default would be a link that silently drops it — which is the bug the
   * Radar has now had twice.
   *
   * `null` renders the same card as a plain surface instead of a link — the
   * Landing's "Exemplo" panel, which shows three real tenders frozen at a past
   * date (`lib/radar/landing-example.ts`). Linking those would take a visitor
   * to whatever the database holds for that id today, or to a 404. A card that
   * leads nowhere must also not be a keyboard stop, so it is not an `<a>` with
   * the href removed: it is not an anchor at all.
   */
  href: string | null
}) {
  const status = STATUS[tender.group]
  const headline = cardHeadline(tender, now)
  const deadline = deadlineShort(tender.proposalsCloseAt)
  const title = displayTitle(tender)
  // The gate (§2.2 rule 6), asked once for the whole card.
  const urgency = mayShowUrgency(tender, now)
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
        {/* 13px ink, not 12px muted. Measured in the 2026-09-24 audit: this
            was the smallest text on the card — quieter than the buyer's name
            — while being the number that decides whether anyone opens the
            tender at all. `ink` on `surface` is 17.9:1. */}
        {countdown === null ? null : (
          <span className="text-meta font-medium text-ink">{countdown}</span>
        )}
      </div>

      <div className="text-lead leading-[1.3] font-semibold">{title}</div>

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
        {href === null ? null : <Icon name="chevronRight" size={16} />}
      </div>
    </>
  )

  // `w-full` matters: the list item is a flex container so the cards stretch
  // to equal height in the desktop grid, and a block child of a flex parent
  // is shrink-to-fit, not full width.
  if (href === null) {
    return (
      <Card padding="sm" className="flex w-full grow flex-col gap-2">
        {body}
      </Card>
    )
  }

  return (
    <CardLink href={href} className="flex w-full grow flex-col gap-2">
      {body}
    </CardLink>
  )
}
