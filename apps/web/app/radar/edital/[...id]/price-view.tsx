import {
  AppBar,
  AppBarBack,
  Button,
  Card,
  Icon,
  LockedValue,
  SectionLabel,
  StateCard,
  Tag,
} from '@/components'
import { cn } from '@/lib/cn'
import { PLAN_HREF } from '@/lib/routes'
import { format, messages } from '@/lib/messages'
import { priceHref } from '@/lib/radar/client'
import type { ErrorCode, TenderDetail, TenderItemView } from '@/lib/radar/contract'
import { errorText } from '@/lib/radar/error-text'
import { trimObject } from '@/lib/radar/format'
import { TenderStatusBanner } from '../../tender-status-banner'

/**
 * The locked price block — canvas 05, `Preco.dc.html`.
 *
 * Reached from the screening screen's "Até quanto ofertar com lucro?". It is
 * the one screen on the free path that is mostly **not there**: the winning
 * price band and the market price are Essencial features, and the awards
 * backfill that would populate them (task B8) needs weeks of collection before
 * a band means anything.
 *
 * So the honest version is the board's: print the one number we do have — what
 * the agency estimated for this item, which is public and comes straight off
 * `tender_items` — and mask the two we do not, in the shape they will have.
 * A masked bar is a promise about a real number; an invented range would be a
 * lie about a real purchase, and the whole product is the opposite of that.
 *
 * `LockedValue` is drawn, never `disabled`: the block is a link to the plan and
 * stays reachable from the keyboard.
 */

const copy = messages.radar
const page = copy.price

/** `R$ 3,74` — an item's unit price, centavos and all, unlike a tender total. */
const MONEY = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' })

export function unitPrice(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null
  const amount = Number(value)
  return Number.isFinite(amount) ? MONEY.format(amount) : null
}

/** The item the screen is about: `?item=N`, or the first one the tender has. */
export function chooseItem(
  items: TenderItemView[],
  wanted: number | null,
): TenderItemView | null {
  if (items.length === 0) return null
  if (wanted !== null) {
    const found = items.find((item) => item.number === wanted)
    if (found) return found
  }
  return items[0]
}

export type PriceStatus =
  | { kind: 'ready' }
  | { kind: 'analyzing' }
  | { kind: 'notFound' }
  | { kind: 'error'; code: ErrorCode; text?: string }

export type PriceViewProps = {
  tenderId: string
  tender: TenderDetail | null
  /** `?item=` — which item of the tender to price. */
  item: number | null
  status: PriceStatus
  backHref: string
  onRetry?: () => void
}

function LockedRow({ label, last = false }: { label: string; last?: boolean }) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2.5 py-2.5 text-body',
        !last && 'border-b border-line',
      )}
    >
      <span className="flex items-center gap-1.5">
        <Icon name="locked" size={14} className="text-muted" />
        {label}
      </span>
      <LockedValue width={64} label={`${label}: ${page.lockedValue}`} />
    </div>
  )
}

export function PriceView({ tenderId, tender, item, status, backHref, onRetry }: PriceViewProps) {
  const bar = (
    <AppBar
      leading={<AppBarBack href={backHref}>{page.back}</AppBarBack>}
      title={page.title}
      actions={<Tag tone="blue">{page.plan}</Tag>}
    />
  )

  if (status.kind !== 'ready' || !tender) {
    return (
      <div className="flex min-h-dvh flex-col">
        {bar}
        <main className="mx-auto w-full max-w-[960px] px-gutter pb-10">
          <h1 className="sr-only">{page.title}</h1>
          {status.kind === 'analyzing' ? (
            <StateCard
              kind="analyzing"
              title={copy.states.analyzingTenderTitle}
              description={copy.states.analyzingTenderBody}
            />
          ) : (
            <StateCard
              kind="empty"
              title={copy.opportunity.notFoundTitle}
              description={
                status.kind === 'error'
                  ? (status.text ?? errorText(status.code))
                  : copy.opportunity.notFoundBody
              }
              action={
                onRetry && status.kind === 'error' ? (
                  <Button variant="link" className="px-0" onClick={onRetry}>
                    {copy.states.errorAction}
                  </Button>
                ) : (
                  <Button variant="link" href={backHref} className="px-0" iconEnd="arrowRight">
                    {copy.opportunity.backToRadar}
                  </Button>
                )
              }
            />
          )}
        </main>
      </div>
    )
  }

  const chosen = chooseItem(tender.items, item)
  const estimate = unitPrice(chosen?.unitEstimatedValue)
  const aiNotice = `${messages.ai.disclaimer} ${messages.ai.notLegalAdvice}`

  return (
    <div className="flex min-h-dvh flex-col">
      {bar}

      <main className="mx-auto flex w-full max-w-[960px] grow flex-col gap-3.5 px-gutter pb-10">
        <h1 className="sr-only">{page.title}</h1>
        {/* §3.5. A price band on a suspended tender is still a true reading of
            the public results; what it must not do is imply there is a bid to
            place today. */}
        <TenderStatusBanner tender={tender} />
        <p className="m-0 text-body leading-relaxed text-muted">{page.intro}</p>

        {chosen === null ? (
          <StateCard kind="empty" title={page.itemsLabel} description={page.noItems} />
        ) : (
          <>
            <div className="text-body font-semibold">
              {chosen.description
                ? format(page.item, {
                    numero: chosen.number,
                    descricao: trimObject(chosen.description, 90),
                  })
                : format(copy.card.items, { count: chosen.number })}
            </div>

            {tender.items.length > 1 ? (
              <nav aria-label={page.itemsLabel} className="flex flex-wrap gap-1.5">
                {tender.items.map((other) => (
                  <a
                    key={other.number}
                    href={priceHref(tenderId, other.number)}
                    aria-current={other.number === chosen.number ? 'page' : undefined}
                    className={cn(
                      'inline-flex min-h-8 items-center rounded-badge border px-2 font-mono text-label no-underline',
                      other.number === chosen.number
                        ? 'border-blue-line bg-blue-soft text-blue'
                        : 'border-line-strong bg-surface text-muted',
                    )}
                  >
                    {other.number}
                  </a>
                ))}
              </nav>
            ) : null}

            <Card className="flex flex-col">
              <SectionLabel tone="muted">{page.referencesTitle}</SectionLabel>
              <div className="flex items-center justify-between gap-2.5 border-b border-line py-2.5 text-body">
                <span>{page.estimated}</span>
                <strong className="font-display text-[16px]">{estimate ?? page.noEstimate}</strong>
              </div>
              <LockedRow label={page.won} />
              <LockedRow label={page.market} last />
            </Card>

            <Card accent className="flex flex-col gap-2.5">
              <div className="text-body font-medium text-blue">{page.maxTitle}</div>
              <div className="flex items-center gap-2.5">
                <span className="font-display text-[30px] leading-none font-semibold text-muted">
                  R$
                </span>
                <LockedValue width={110} height={30} label={page.lockedValue} />
              </div>
              <p className="m-0 text-meta leading-relaxed text-muted">{page.maxNote}</p>
            </Card>

            <div className="flex items-start gap-2.5 rounded-card bg-blue-soft p-3">
              <Icon name="margin" size={20} className="shrink-0 text-blue" />
              <p className="m-0 text-meta leading-relaxed">
                <strong>{page.exampleLead}</strong> {page.exampleBody}
              </p>
            </div>

            {/* Legal brief §2.2 rule 5: every result screen carries the notice.
                This one shows money — an estimate read out of the edital, and
                a ceiling derived from it — which makes it the screen where a
                reader is most likely to treat a number as advice. Rule 3 is
                already satisfied by `page.estimated` and `page.maxNote`; this
                is the AI notice those two do not stand in for. */}
            <p className="text-caption leading-relaxed text-muted">{aiNotice}</p>
          </>
        )}

        <div className="mt-auto pt-2">
          <Button href={PLAN_HREF} fullWidth iconEnd="arrowRight">
            {page.cta}
          </Button>
        </div>
      </main>
    </div>
  )
}
