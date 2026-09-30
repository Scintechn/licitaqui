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
import { MenuTrigger } from '@/components/menu-trigger'
import { cn } from '@/lib/cn'
import { PLAN_HREF } from '@/lib/routes'
import { format, messages } from '@/lib/messages'
import { priceHref, type RadarSearch } from '@/lib/radar/client'
import type { ErrorCode, TenderDetail, TenderItemView } from '@/lib/radar/contract'
import { errorText } from '@/lib/radar/error-text'
import { moneyExact, moneyExactNonZero, trimObject } from '@/lib/radar/format'
import type { PriceBand } from '@/lib/radar/price-band'
import { MarginCeiling } from './margin-ceiling'
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

/**
 * `R$ 3,74` — an item's unit price, centavos and all, unlike a tender total.
 *
 * This is the **same figure** the Itens tab prints in its "Valor unitário
 * estimado" column, off the same `tender_items.unit_estimated_value`, so it is
 * now the same function. It used to be a second `Intl.NumberFormat` declared
 * here, which is how this screen came to print `R$ 0,00` on the tenders Sci
 * found while the fix for the items table would have sailed past it. One
 * formatter, one rule: a zero is not a price (`notAPrice` in
 * `lib/radar/format.ts`), so it falls through to `page.noEstimate` below.
 */
export function unitPrice(value: string | null | undefined): string | null {
  return moneyExact(value)
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
  // Sci, on his journey: *"the item that has the price should be the first."*
  // He landed on item 2 of a two-item edital and met "ainda sem dados de
  // vencedores" — a screen called *Até quanto ofertar* opening on the one item
  // it cannot answer for. `hasAward` is already on the wire, so the default is
  // the first item a band can exist for; `items[0]` only when none has one,
  // which is the honest fallback rather than an arbitrary pick.
  return items.find((item) => item.hasAward) ?? items[0]
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
  /** The search that got the user here — the item chips below carry it on. */
  search: RadarSearch
  /**
   * The band for the chosen item, or `null` when the gate refused one.
   *
   * Computed on the server (`lib/radar/price-band.ts`) because it reads the
   * `awards` table. **`null` is a first-class answer, not a loading state** —
   * it means no number exists for this item, and the view must say so rather
   * than draw a locked bar implying one is being withheld.
   *
   * Optional because the loading fallback and the suspended-tender screens
   * genuinely have none: absent and `null` mean the same thing here, which is
   * "no number exists", and both render the third state.
   */
  band?: PriceBand | null
  /**
   * The caller's plan does not include the band.
   *
   * A third state, and the one that makes `LockedValue` honest again: *locked*
   * says a number exists and this plan does not include it; *empty* says no
   * number exists for anybody. The first version of E9 had only two states and
   * had to choose between lying to a visitor and hiding the plan.
   */
  bandLocked?: boolean
  /**
   * Whether to offer the Essencial plan. Defaults to **true** so every render
   * that does not know — the loading fallback, the suspended screen, a test —
   * keeps the behaviour this screen had before the band existed.
   */
  showPlanCta?: boolean
  onRetry?: () => void
}

/**
 * `"R$ 18,00 – R$ 24,00"`, or `null` when either end cannot be shown as money.
 *
 * Both ends or neither: a range with one half missing is worse than no range,
 * because the reader has no way to tell which half they are looking at.
 */
export function bandRange(band: { low: number; high: number }): string | null {
  const low = moneyExactNonZero(String(band.low))
  const high = moneyExactNonZero(String(band.high))
  return low === null || high === null ? null : `${low} – ${high}`
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

export function PriceView({
  tenderId,
  tender,
  item,
  status,
  backHref,
  search,
  band = null,
  bandLocked = false,
  showPlanCta = true,
  onRetry,
}: PriceViewProps) {
  const bar = (
    <AppBar
      leading={<AppBarBack href={backHref}>{page.back}</AppBarBack>}
      title={page.title}
      actions={
        <>
          <Tag tone="blue">{page.plan}</Tag>
          {/* D24 half 2 — see the note in `opportunity-view.tsx`. */}
          <MenuTrigger />
        </>
      }
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
              <nav aria-label={page.itemsLabel} className="flex flex-col gap-1">
                {tender.items.map((other) => (
                  <a
                    key={other.number}
                    href={priceHref(tenderId, search, other.number)}
                    aria-current={other.number === chosen.number ? 'page' : undefined}
                    className={cn(
                      'flex min-h-touch items-center rounded-control border px-3 text-body no-underline',
                      other.number === chosen.number
                        ? 'border-blue-line bg-blue-soft text-blue'
                        : 'border-line-strong bg-surface text-ink',
                    )}
                  >
                    {other.description
                      ? format(page.item, {
                          numero: other.number,
                          descricao: trimObject(other.description, 70),
                        })
                      : format(copy.card.items, { count: other.number })}
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
              {bandLocked ? (
                <LockedRow label={page.won} />
              ) : band ? (
                <div className="flex items-center justify-between gap-2.5 border-b border-line py-2.5 text-body">
                  <span>{page.won}</span>
                  <strong className="font-display text-[16px] tabular-nums">
                    {/* Not a template literal: `bandRange` can answer null,
                        and interpolating that prints the literal word "null"
                        beside a money figure — TypeScript will not catch it
                        inside a template. That half was right.

                        The reason given was not. It said `moneyExact` refuses
                        "anything that rounds to zero"; it refuses `=== 0`
                        only. And it claimed sub-centavo awards exist because
                        the column is numeric(16,4) filtered on `> 0` — an
                        argument from the schema, never measured. Measured
                        2026-09-28: the minimum over 5 349 OK awards is
                        R$ 0,0300, so no band end reaches zero today. The
                        guard stays because "both ends or neither" only means
                        something if an end can be refused, and
                        `moneyExactNonZero` is what actually refuses one. */}
                    {bandRange(band) ?? page.noEstimate}
                  </strong>
                </div>
              ) : null}
              {/* Locked for everyone, and its label is wrong for everyone:
                  `page.lockedValue` reads "valor disponível no plano
                  Essencial" while `0002_plan_limits.sql` grants `market_price`
                  to **`pro` alone**. Pre-existing, but gating the band put it
                  beside a feature that now really does unlock, so an Essencial
                  subscriber reads that they need Essencial. Left as it is
                  rather than guessed at: the string is Sci's and the
                  entitlement question is F5's. Recorded in `docs/CLAIMS.md`. */}
              <LockedRow label={page.market} last />
            </Card>

            {bandLocked ? (
              /* The honest use of a locked value: a number does exist for this
                 item and this plan does not include it. */
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
            ) : band ? (
              /* The only interactive part of this screen, so the only part
                 that is a Client Component. The rest stays server-rendered. */
              <MarginCeiling band={band} />
            ) : (
              /* **The third state, and why it is not a locked bar.** A locked
                 value tells a person a number exists and is being withheld from
                 them. For these items no number exists: the gate in
                 `lib/radar/price-band.ts` refused one because the comparable
                 awards were too few or too scattered to mean anything. Saying
                 that plainly keeps the Essencial feature visible without
                 claiming something is being kept back. */
              <Card className="flex flex-col gap-2.5">
                <div className="text-body font-medium">{page.maxTitle}</div>
                <p className="m-0 text-body text-muted">{page.noData}</p>
                <p className="m-0 text-meta leading-relaxed text-muted">{page.noDataHelp}</p>
              </Card>
            )}

            {/* Legal brief §2.2 rule 5: every result screen carries the notice.
                This one shows money — an estimate read out of the edital, and
                a ceiling derived from it — which makes it the screen where a
                reader is most likely to treat a number as advice. Rule 3 is
                already satisfied by `page.estimated` and `page.maxNote`; this
                is the AI notice those two do not stand in for. */}
            <p className="text-caption leading-relaxed text-muted">{aiNotice}</p>
          </>
        )}

        {/* **Not shown to someone who already has the plan.** Gating the band
            made this visible: the button reads "Ver plano Essencial" and the
            screen was rendering it unconditionally, including to Essencial and
            Pro subscribers, and including beside a band they had just been
            shown. `bandLocked` is the closest thing this component has to
            "does not have the plan" — when the band is not locked, either the
            caller is entitled or no number exists for anybody — but those are
            not the same thing, so the server says which — read once in the
            page (`entitlement.ts`) and passed in as `showPlanCta`, never off
            the band response. */}
        {showPlanCta ? (
          <div className="mt-auto pt-2">
            <Button href={PLAN_HREF} fullWidth iconEnd="arrowRight">
              {page.cta}
            </Button>
          </div>
        ) : null}
      </main>
    </div>
  )
}
