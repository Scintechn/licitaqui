import { CardLink, Icon, Status, Tag, TagList, type StatusKind } from '@/components'
import { tenderHref } from '@/lib/radar/client'
import type { TenderCard, TenderGroup } from '@/lib/radar/contract'
import { agencyLine, daysUntil, deadlineShort, meEppSummary, money, trimObject } from '@/lib/radar/format'
import { format, messages } from '@/lib/messages'

/**
 * One tender in the Radar list — canvas 02, `Editais.dc.html`, the card that
 * repeats three times down the screen.
 *
 * Transcribed row for row from the board: status badge and countdown, title,
 * agency line, the value in Archivo with the item count beside it, the ME/EPP
 * tags, and the deadline line closed by a chevron.
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

/** The countdown on the top right: "13 dias", "último dia", "encerrado". */
export function deadlineLabel(iso: string | null, now: Date): string {
  const days = daysUntil(iso, now)
  if (days === null) return copy.card.noDeadline
  if (days < 0) return copy.card.closed
  return format(copy.card.daysLeft, { count: days })
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

export function TenderCardView({ tender, now = new Date() }: { tender: TenderCard; now?: Date }) {
  const status = STATUS[tender.group]
  const value = tender.confidentialBudget ? copy.card.confidential : money(tender.estimatedValue)
  const deadline = deadlineShort(tender.proposalsCloseAt)

  return (
    // `w-full` matters: the list item is a flex container so the cards stretch
    // to equal height in the desktop grid, and a block child of a flex parent
    // is shrink-to-fit, not full width.
    <CardLink href={tenderHref(tender.id)} className="flex w-full flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <Status kind={status.kind}>{status.label}</Status>
        <span className="text-caption text-muted">{deadlineLabel(tender.proposalsCloseAt, now)}</span>
      </div>

      <div className="text-lead leading-[1.3] font-semibold">{trimObject(tender.object)}</div>

      <div className="text-meta text-muted">{agencyLine(tender)}</div>

      <div className="flex items-baseline justify-between gap-2">
        <span className="font-display text-[22px] leading-none font-semibold tabular-nums">
          {value ?? copy.card.noValue}
        </span>
        {tender.itemCount === null ? null : (
          <span className="text-caption text-muted">
            {format(copy.card.items, { count: tender.itemCount })}
          </span>
        )}
      </div>

      <TenderTags tender={tender} />

      <div className="flex items-center gap-2 text-meta text-muted">
        <Icon name="deadline" size={16} />
        <span className="grow">
          {deadline ? format(copy.card.proposalsUntil, { quando: deadline }) : copy.card.noDeadline}
        </span>
        <Icon name="chevronRight" size={16} />
      </div>
    </CardLink>
  )
}
