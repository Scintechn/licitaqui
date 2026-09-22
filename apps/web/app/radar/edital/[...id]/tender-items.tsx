import { Button, Icon, SectionLabel, StateCard } from '@/components'
import { cn } from '@/lib/cn'
import { format, messages } from '@/lib/messages'
import type { TenderItemView } from '@/lib/radar/contract'
import { moneyExact, quantity, trimObject } from '@/lib/radar/format'

/**
 * The Itens tab — PNCP's own table, on our screen.
 *
 * Sci: *"regarding the data, value — we have it in the TAB ITENS… In my
 * opinion this information is extremely important — without it, I have to open
 * two applications."* He is right that we already hold it: `GET /api/tenders/:id`
 * has always returned `items`, read from our `tender_items` table by
 * `lib/radar/tender.ts`. Nothing here fetches, nothing here touches PNCP
 * (spec §3); the screen was simply not drawing the rows it was already sent.
 *
 * Verified on `12342663000173-1-000017/2026`: 15 rows, `sum(total_value)`
 * R$ 2.988.571,02, item 1 `FILMAGEM COM CAMÊRA…` 400 × R$ 816,67 =
 * R$ 326.668,00 — the same figures PNCP's table prints. Across the whole
 * table, **127 980 of 127 980 item rows carry a quantity, a unit, a unit value
 * and a total**.
 *
 * ## Why a page of twenty and not the whole list
 *
 * Production is much wider than the card's "1 to 55+": the largest tender we
 * hold has **1 124 items**, 122 tenders have more than 200 and 492 have
 * between 51 and 200. Rendering every row eagerly means, on that tender, two
 * DOM trees of 1 124 rows each — measured at ~1.1 MB of markup — on a screen
 * whose first job is a deadline and an object. So the tab renders
 * `ITEMS_PAGE` rows and grows by `ITEMS_PAGE` on demand, the same
 * "Ver mais · Mostrando X de Y" pattern the Radar list already uses.
 *
 * Virtualisation was the alternative and was rejected on this data: row
 * heights here vary from one line to an expanded 2 048-character
 * specification, which is the worst case for a windowing library; it would
 * need measurement in the browser, so the tab could no longer be rendered on
 * the server or asserted with `renderToStaticMarkup`; and it would break
 * find-in-page, which on a table of 1 124 items is how someone actually
 * locates the item they supply. Paging costs one tap and keeps all three.
 *
 * ## Two layouts, one of them always hidden
 *
 * Five columns — Número, Descrição, Quantidade, Valor unitário estimado, Valor
 * total estimado — cannot be read inside a 390px frame: the four numeric
 * columns alone eat the width and leave the description about 90px. An
 * `overflow-x: auto` table would technically fit, and the reader would have to
 * scroll right to reach the price and lose the description doing it. So below
 * `md` each item is a card (number and description, then the three figures as
 * labelled rows) and from `md` up it is a real `<table>` with real
 * `<th scope="col">`.
 *
 * They are two markup trees, and that is the deliberate cost: `hidden` is
 * `display: none`, so exactly one of them exists in the accessibility tree at
 * any width and neither has to fake table semantics with ARIA on restyled
 * `<tr>`s. Bounded by the page size, it is forty row-trees, not two thousand.
 *
 * ## The total is not computed here as a stand-in for the tender's value
 *
 * `tenders.estimated_value` is what the deadline/value card shows, and it is
 * what PNCP shows: the number in our header must be the number in theirs, and
 * that decision belongs in the worker, once. It is null on 5 036 of the 5 921
 * tenders that have items today and a lane is backfilling it — and on **42
 * tenders the agency's declared total already differs from the sum of its own
 * item rows**, which is exactly why the browser must not silently substitute
 * one for the other. The figure below is therefore labelled as what it is:
 * the sum of these item rows, with its arithmetic named (legal brief §2.2
 * rule 3), and it is omitted entirely if any row is missing a total.
 */

const copy = messages.radar.opportunity.items

/** How many rows a page of the Itens tab holds. */
export const ITEMS_PAGE = 20

/**
 * Longer than this and the description gets a disclosure instead of a cell.
 *
 * The median item description is 175 characters, but 20 293 rows run past 300
 * and 5 978 past 600, up to 2 048. Twenty of those open at once is a wall, so
 * the long ones collapse — the same `<details>` the Radar card uses for the
 * Objeto, for the same reason: it is a keyboard stop with its expanded state
 * already announced, it is searchable by find-in-page, and it works before
 * React has hydrated.
 */
const DESCRIPTION_MAX = 160

/**
 * The sum of every item's total, or `null` when even one row cannot be added.
 *
 * Exported because it is the one piece of arithmetic on this screen and it
 * needs its own test against the production figures above.
 */
export function sumItems(items: TenderItemView[]): string | null {
  if (items.length === 0) return null
  let total = 0
  for (const item of items) {
    if (item.totalValue === null || item.totalValue === '') return null
    const value = Number(item.totalValue)
    if (!Number.isFinite(value)) return null
    total += value
  }
  // Back to a decimal string, so it re-enters `moneyExact` the way a wire
  // value would. Two places: every `total_value` PNCP publishes has two.
  return total.toFixed(2)
}

/**
 * An item's description, whole.
 *
 * Deliberately **not** put through `cleanTitle()`, which the titles are. That
 * function de-shouts block capitals, and this column exists so a reader can
 * check our row against PNCP's row — a specification is technical text where
 * case carries meaning (catalogue codes, formats, units), and PNCP prints it
 * verbatim. So the collapsed summary is only whitespace-collapsed and trimmed,
 * and the expanded text keeps the agency's own line breaks, which real items
 * use to list sub-quantities.
 */
function ItemDescription({ text }: { text: string }) {
  const full = text.replace(/[ \t]+/g, ' ').trim()
  const flat = full.replace(/\s+/g, ' ')
  if (flat.length <= DESCRIPTION_MAX) {
    return <span className="text-body">{flat}</span>
  }

  return (
    <details className="group">
      <summary
        className={cn(
          'cursor-pointer list-none text-body [&::-webkit-details-marker]:hidden',
        )}
      >
        <span className="group-open:hidden">{trimObject(flat, DESCRIPTION_MAX)}</span>
        <span className="flex min-h-touch items-center gap-1.5 text-meta font-medium text-blue">
          <Icon
            name="chevronRight"
            size={14}
            className="transition-transform group-open:rotate-90"
          />
          <span className="group-open:hidden">{copy.more}</span>
          <span className="hidden group-open:inline">{copy.less}</span>
        </span>
      </summary>
      <p className="m-0 pb-1 text-body leading-relaxed whitespace-pre-line">{full}</p>
    </details>
  )
}

type Figures = {
  quantity: string | null
  unit: string | null
  unitValue: string | null
  totalValue: string | null
}

function figures(item: TenderItemView): Figures {
  return {
    quantity: quantity(item.quantity),
    unit: item.unit,
    unitValue: moneyExact(item.unitEstimatedValue),
    totalValue: moneyExact(item.totalValue),
  }
}

/** An absent figure is named, never left as an empty cell. */
const DASH = '—'

const HEAD = 'py-2 text-label font-mono font-medium tracking-[0.08em] text-muted uppercase'

function ItemsTable({ items }: { items: TenderItemView[] }) {
  return (
    <div className="hidden overflow-x-auto md:block">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">{copy.caption}</caption>
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className={cn(HEAD, 'w-12 pr-2')}>
              {copy.number}
            </th>
            <th scope="col" className={cn(HEAD, 'pr-4')}>
              {copy.description}
            </th>
            <th scope="col" className={cn(HEAD, 'w-28 pr-4 text-right')}>
              {copy.quantity}
            </th>
            <th scope="col" className={cn(HEAD, 'w-40 pr-4 text-right')}>
              {copy.unitValue}
            </th>
            <th scope="col" className={cn(HEAD, 'w-40 text-right')}>
              {copy.totalValue}
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const cell = figures(item)
            return (
              <tr key={item.number} className="border-b border-line align-top">
                <td className="py-3 pr-2 font-mono text-label text-muted tabular-nums">
                  {item.number}
                </td>
                <td className="py-3 pr-4">
                  <ItemDescription text={item.description ?? ''} />
                </td>
                <td className="py-3 pr-4 text-right text-body tabular-nums">
                  {cell.quantity ?? DASH}
                  {cell.unit ? (
                    <span className="block text-caption text-muted">{cell.unit}</span>
                  ) : null}
                </td>
                <td className="py-3 pr-4 text-right text-body whitespace-nowrap tabular-nums">
                  {cell.unitValue ?? DASH}
                </td>
                <td className="py-3 text-right text-body font-medium whitespace-nowrap tabular-nums">
                  {cell.totalValue ?? DASH}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function ItemFigure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="m-0 text-right tabular-nums">{value}</dd>
    </div>
  )
}

function ItemsCards({ items }: { items: TenderItemView[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2.5 p-0 md:hidden">
      {items.map((item) => {
        const cell = figures(item)
        const qty =
          cell.quantity === null
            ? DASH
            : cell.unit
              ? `${cell.quantity} ${cell.unit}`
              : cell.quantity
        return (
          <li key={item.number} className="rounded-card border border-line bg-surface p-3">
            <div className="flex items-baseline gap-2">
              <span className="shrink-0 font-mono text-label text-muted tabular-nums">
                {item.number}
              </span>
              <div className="min-w-0 grow">
                <ItemDescription text={item.description ?? ''} />
              </div>
            </div>
            <dl className="m-0 mt-2 flex flex-col gap-1 border-t border-line pt-2 text-meta">
              <ItemFigure label={copy.quantity} value={qty} />
              <ItemFigure label={copy.unitValue} value={cell.unitValue ?? DASH} />
              <ItemFigure label={copy.totalValue} value={cell.totalValue ?? DASH} />
            </dl>
          </li>
        )
      })}
    </ul>
  )
}

export type TenderItemsProps = {
  items: TenderItemView[]
  /**
   * How many rows are on screen. The screen owns it, so this component stays a
   * pure function of its props and every page of it can be asserted.
   */
  visible?: number
  onShowMore?: () => void
}

export function TenderItems({ items, visible = ITEMS_PAGE, onShowMore }: TenderItemsProps) {
  if (items.length === 0) {
    return <StateCard kind="empty" title={copy.emptyTitle} description={copy.emptyBody} />
  }

  const shown = Math.min(Math.max(visible, 1), items.length)
  const rows = items.slice(0, shown)
  const total = moneyExact(sumItems(items))

  return (
    <div className="flex flex-col gap-3">
      <ItemsCards items={rows} />
      <ItemsTable items={rows} />

      {shown < items.length ? (
        <div className="flex flex-col items-center gap-1.5">
          <Button variant="secondary" onClick={onShowMore} fullWidth>
            {copy.showMore}
          </Button>
          <span className="text-caption text-muted">
            {format(copy.showing, { shown, total: items.length })}
          </span>
        </div>
      ) : null}

      {total === null ? null : (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-card bg-fill-muted px-3.5 py-3">
            <SectionLabel tone="muted">
              {format(copy.sum, { count: items.length })}
            </SectionLabel>
            <span className="font-display text-[20px] leading-none font-semibold text-ink tabular-nums">
              {total}
            </span>
          </div>
          {/* Legal brief §2.2 rule 3: a figure is an estimate and its
              arithmetic is visible. This one is ours — an addition over the
              rows above — and the sentence says so, so it can never be read as
              the agency's own declared total. */}
          <p className="m-0 text-caption leading-relaxed text-muted">{copy.sumNote}</p>
        </div>
      )}
    </div>
  )
}
