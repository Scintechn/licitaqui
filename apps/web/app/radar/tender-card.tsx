import { Card, CardLink, Icon, Status, Tag, TagList, type StatusKind } from '@/components'
import { tenderHref } from '@/lib/radar/client'
import type { TenderCard, TenderGroup } from '@/lib/radar/contract'
import { agencyLine, deadlineShort, meEppSummary, tenderTitle } from '@/lib/radar/format'
import { cardHeadline, deadlineLabel } from '@/lib/radar/headline'
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
 * The whole card is one `<a>` (`CardLink`), not a div with a click handler and
 * a nested link: one keyboard stop, one screen-reader target, and the middle
 * button opens it in a tab like any other link.
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

  // When the deadline has been promoted into the anchor it is the same string
  // the top-right countdown prints, so the countdown steps aside rather than
  // saying "13 dias" twice on one card.
  const countdown =
    headline.anchor?.fact === 'deadline' ? null : deadlineLabel(tender.proposalsCloseAt, now)

  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <Status kind={status.kind}>{status.label}</Status>
        {countdown === null ? null : (
          <span className="text-caption text-muted">{countdown}</span>
        )}
      </div>

      <div className="text-lead leading-[1.3] font-semibold">{tenderTitle(tender.object)}</div>

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

      <div className="flex items-center gap-2 text-meta text-muted">
        <Icon name="deadline" size={16} />
        <span className="grow">
          {deadline ? format(copy.card.proposalsUntil, { quando: deadline }) : copy.card.noDeadline}
        </span>
        {target === null ? null : <Icon name="chevronRight" size={16} />}
      </div>
    </>
  )

  // `w-full` matters: the list item is a flex container so the cards stretch
  // to equal height in the desktop grid, and a block child of a flex parent
  // is shrink-to-fit, not full width.
  if (target === null) {
    return (
      <Card padding="sm" className="flex w-full flex-col gap-2">
        {body}
      </Card>
    )
  }

  return (
    <CardLink href={target} className="flex w-full flex-col gap-2">
      {body}
    </CardLink>
  )
}
