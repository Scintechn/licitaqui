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
import { ActionBar } from '@/components/action-bar'
import { priceHref, tenderHref, type RadarSearch } from '@/lib/radar/client'
import type { ErrorCode, TenderDetail, TenderItemView } from '@/lib/radar/contract'
import { errorText } from '@/lib/radar/error-text'
import { moneyExact, moneyExactNonZero, trimObject } from '@/lib/radar/format'
import { MIN_SAMPLE } from '@/lib/radar/price-band'
import type { LockedEvidence, PriceBand, PriceEvidence } from '@/lib/radar/price-band'
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
   * What was found when it was not enough for a band (E22).
   *
   * **The reason the third state is no longer one state.** `priceBand` returns
   * `null` below `MIN_SAMPLE`, and the count went with it, so this screen could
   * not tell *"one past winner"* from *"nothing found"* and said "ainda sem
   * dados de vencedores" to both. Measured 2026-10-01 over 600 open items:
   * 11.17% have a past winner of the same product, **0.67%** clear the band's
   * gate — so that sentence was wrong for roughly ten items in every eleven it
   * appeared on.
   *
   * Two shapes, because the rungs are not the same offer. Below the gate it is
   * `PriceEvidence`: the count, the individual prices and what each one was.
   * At or above it — where the band exists and this plan does not include it —
   * it is `LockedEvidence`, which has no price field at all, because the
   * sampled prices rebuild the band (Sci, 2026-10-02). `bandLocked` says which
   * one arrived, and the union means a price cannot reach the locked branch.
   */
  evidence?: PriceEvidence | LockedEvidence | null
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

/**
 * The matched descriptions, as a list the reader judges (E22).
 *
 * This is not decoration. `MIN_SAMPLE` and `MAX_SPREAD` are what caught a wrong
 * match — five editais outvote one caderno — and below the gate neither has
 * run, so at one or two editais **nothing** has checked that the comparable is
 * even the same product. A single clean number looks *more* authoritative for
 * being one number, which is the failure this list exists to prevent: the top
 * rung earns the right to hide its sources because the spread did the judging,
 * and the thin rungs borrow the reader's judgement instead.
 */
function MatchedList({ items }: { items: readonly string[] }) {
  if (items.length === 0) return null
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {items.map((description) => (
        <li key={description} className="text-meta leading-relaxed text-muted">
          {trimObject(description, 70)}
        </li>
      ))}
    </ul>
  )
}

/**
 * One past result: a price somebody closed at, and the words it closed under.
 *
 * `value` is a real awarded row, never a statistic — see `PriceSample`. The two
 * are rendered together because neither is worth much alone: the price without
 * the description asserts a match the thin rungs have not verified, and the
 * description without the price is not evidence about money.
 */
function EvidenceRow({ sample }: { sample: PriceEvidence['samples'][number] }) {
  const money = moneyExactNonZero(String(sample.value))
  return (
    <div className="flex items-baseline justify-between gap-2.5 border-b border-line py-2 last:border-b-0">
      <span className="text-meta leading-relaxed text-muted">
        {sample.description === null ? page.won : trimObject(sample.description, 60)}
      </span>
      {money === null ? null : (
        <strong className="shrink-0 font-display text-[15px] tabular-nums">{money}</strong>
      )}
    </div>
  )
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
  evidence = null,
  showPlanCta = true,
  onRetry,
}: PriceViewProps) {
  /**
   * **Narrowed structurally, not by `bandLocked`.**
   *
   * `bandLocked` is supposed to say which shape arrived, but it is a separate
   * prop and the two can disagree — a caller passing `PriceEvidence` with
   * `bandLocked` would otherwise read `.matched` off an object that has none.
   * Asking the object instead means a mismatched pair renders nothing rather
   * than throwing, and no branch can reach a field its shape lacks.
   *
   * `thin` is also only ever rendered where `band === null`, so these two are
   * mutually exclusive on screen even though the prop is one union.
   */
  const thin = evidence !== null && 'samples' in evidence ? evidence : null
  const locked = evidence !== null && 'matched' in evidence ? evidence : null

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
                {/* **The count and what was matched, never the prices** (Sci,
                    2026-10-02). Withholding all of it would make the ladder go
                    backwards — a visitor would see the matched results at four
                    editais and an empty card at five, the moment the data got
                    good enough to sell. Showing the prices would hand back the
                    band: the quartiles of five sorted values are
                    `sorted[1..3]`, so four sampled prices give two of the three
                    figures exactly. `LockedEvidence` carries no price field, so
                    this block cannot print one. */}
                {locked === null ? null : (
                  <>
                    <p className="m-0 text-body">
                      {format(page.lockedEvidence, { count: locked.editais })}
                    </p>
                    <MatchedList items={locked.matched} />
                  </>
                )}
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
                 claiming something is being kept back.

                 **E22 split it in two.** The gate refusing a band is not the
                 same as having found nothing, and this card said the same
                 sentence to both. `thin` is the rung that was missing. */
              <Card className="flex flex-col gap-2.5">
                <div className="text-body font-medium">{page.maxTitle}</div>
                {thin === null ? (
                  <>
                    <p className="m-0 text-body text-muted">{page.noData}</p>
                    <p className="m-0 text-meta leading-relaxed text-muted">{page.noDataHelp}</p>
                  </>
                ) : (
                  <>
                    {/* The count, then every result behind it. No median, no
                        quartile, no preço-alvo: those are earned by five
                        editais and a spread the gate checked, and a figure
                        drawn through one or two prices would be a confident
                        number with nothing behind it. */}
                    <p className="m-0 text-body">
                      {format(page.evidenceCount, { count: thin.editais })}
                    </p>
                    <div className="flex flex-col">
                      {thin.samples.map((sample) => (
                        <EvidenceRow key={sample.tenderId} sample={sample} />
                      ))}
                    </div>
                    {/* **Only below the floor, because above it the sentence
                        is false.** `evidenceHelp` says the faixa appears at
                        five editais or more. `MIN_SAMPLE` is necessary and not
                        sufficient — `MAX_SPREAD` must pass too — so an item
                        with six scattered editais would read "Mostramos a faixa
                        quando encontramos pelo menos 5 editais… Neste item
                        encontramos 6" directly above no faixa at all. It is
                        reachable, not hypothetical: measured 2026-10-01, 0.83%
                        of open items reach five editais and 0.67% show a band,
                        so about one in five of those fails on spread.

                        Suppressing it leaves that case with the count and the
                        results and no explanation, which is incomplete but
                        true. Saying why would need a sentence about scatter,
                        and the words are Sci's — recorded in `CLAIMS.md`. */}
                    {thin.editais < MIN_SAMPLE ? (
                      <p className="m-0 text-meta leading-relaxed text-muted">
                        {format(page.evidenceHelp, { count: thin.editais })}
                      </p>
                    ) : null}
                  </>
                )}
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

        {/* **The plan CTA moved into the action bar below.**

            It used to be a full-width button here *and* a slot in the bar, so
            below `lg` the screen offered the same action twice under the same
            accessible name. Sci, 2026-09-30: *"both CTA jump to the same
            location, and the button at the bottom is the primary cta."*

            The condition it carried survives and still governs the bar:
            `showPlanCta` is read once in the page (`entitlement.ts`) and
            passed in, never inferred from the band response. Gating the band
            is what made the old defect visible — the button read "Ver plano
            Essencial" and rendered unconditionally, including to Essencial
            and Pro subscribers, beside a band they had just been shown. */}
      </main>

      {/* D25 (3). This screen is the end of the journey, so the only thing
          ahead of the reader is the plan that unlocks the band — and since
          2026-09-30 this is the **only** place that action appears: the
          full-width button that used to sit above was drawn under the same
          accessible name and has been deleted, not hidden.

          When `showPlanCta` is false the caller is entitled or no band exists
          for anybody, so there is no next action and no bar. **That also
          takes the second slot with it**, which is worth knowing: an entitled
          subscriber's only way back is the AppBar's "Voltar", and on this
          screen that goes to the triagem rather than to the edital. Carded,
          not fixed here. */}
      {showPlanCta ? (
        <ActionBar
          primary={{ href: PLAN_HREF, label: page.cta }}
          // **Not `backHref`.** On this screen that is `screeningHref` — the
          // triagem — so a slot labelled "Edital" would have landed somewhere
          // else. The AppBar's "Voltar" is honest about being history; a slot
          // that names a destination has to go to it.
          secondary={{ href: tenderHref(tenderId, search), label: messages.common.tender }}
        />
      ) : null}
    </div>
  )
}
