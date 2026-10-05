'use client'

import { useId, useState } from 'react'
import { Icon } from '@/components'
import { cn } from '@/lib/cn'
import { format, messages } from '@/lib/messages'
import { priceHref, type RadarSearch } from '@/lib/radar/client'
import type { TenderItemView } from '@/lib/radar/contract'
import { trimObject } from '@/lib/radar/format'

/**
 * The price screen's item list, as a list rather than a scroll (D34).
 *
 * ## The defect
 *
 * Sci, 2026-10-01, on `77817476000144-1-000034/2026`: *"imagine the tender has
 * more than 31 items… if the item has this range price, it should be visible in
 * priority, if not, ok. But we need a new arrangement to view those items,
 * expand/collapse. But scrolling 31 items is not the best practice."* That
 * tender has **251** items and FIOCRUZ's has 91; the screen drew every one of
 * them as an equal chip, so the two useful rows were somewhere inside a column
 * taller than the price card it exists to lead to.
 *
 * ## This is the *arrangement* half only
 *
 * D34 has two halves and they ship apart. The arrangement — collapse, a count,
 * and a way to search inside it — needs no new data. The **priority** half
 * (winner-bearing items first, marked) needs the per-item flag **D33** builds
 * and is worth nothing before **C3**. `priceableFirst` below is the hook it
 * will fill: present, inert, and tested as inert.
 *
 * **It is not faked with `hasAward`.** That field is the item's *own* award —
 * `true` for 0.33% of items on open editais and zero on all six tenders Sci
 * sent — so an order built on it would reorder nothing while claiming to. The
 * mistake is already on the record twice (D25 (5) and D33); `isPriceable`
 * answers `false` for every item, including one carrying `hasAward`, and a test
 * pins exactly that.
 *
 * ## Widths
 *
 * This block lives inside the app shell, in `main` (`max-w-[960px] px-gutter`)
 * beside a rail that is 264px from `lg` and 56px when the reader collapses it —
 * a `localStorage` state no media query can observe. Its column is therefore
 * `min(viewport − rail, 960) − 40`: **720px at the moment the rail appears**,
 * which is why a viewport breakpoint above 720 is the D29/D30/D32 defect.
 *
 * So there is **no width breakpoint here at all**. The summary row wraps with
 * `flex-wrap`, which is right at every width and pins no number. If one is ever
 * needed it must be `@container` on a wrapper and `@min-[Npx]:` on the child,
 * with the number *measured* rather than inferred (D32's lesson), and the
 * container must stay off any ancestor of D25 (3)'s fixed `ActionBar`, because
 * `container-type: inline-size` makes an element a containing block for fixed
 * descendants. `item-picker.test.tsx` fails if any viewport query appears here,
 * in either spelling.
 *
 * ## Copy
 *
 * Nothing new. `radar.price.itemsLabel`, `radar.price.item`,
 * `radar.opportunity.items.showMore`/`.less`/`.showing` already say these
 * things, and reusing a control label across one gesture is the house rule
 * (D38). The search field has **no words of its own** — it is `type="search"`
 * behind the set's magnifier, named by the group heading through
 * `aria-labelledby` — because a label for it would be a new user-facing string
 * and those are Sci's. That is **D47**, carded in this PR.
 */

const copy = messages.radar
const page = copy.price
const itemCopy = copy.opportunity.items

/**
 * Above this many items the list collapses; at or below it, it is just a list.
 *
 * Eight chips at `min-h-touch` plus their gaps is about **384px** — roughly one
 * phone's worth of list, and the point past which the list stops being
 * something you read and starts being something you scroll. (Inferred from the
 * token values, not measured in a browser: `--spacing-touch` is 44px and the
 * gap is 4px. §4d — say which is which.) Below the line the disclosure would
 * cost a tap and buy nothing, which is `LongText`'s rule for a short
 * description applied to a short list.
 */
export const COLLAPSE_FROM = 8

/**
 * The most rows the open list draws, however many the edital has.
 *
 * The widest tender we hold has **1 124 items** (`tender-items.tsx`), and this
 * list is one anchor per item rather than a five-cell row in two layouts, so it
 * is an order of magnitude lighter than the Itens tab — but 1 124 of anything
 * is still not a list. The Itens tab answers this with paging; here the answer
 * is the search field, because paging *and* a filter together would hide a
 * match behind "Ver mais" and make the count mean two things at once.
 *
 * The count line stays true either way: it reports the rows actually drawn
 * against the edital's own total, which is the only pair of numbers a reader
 * can check.
 */
export const LIST_CAP = 50

/** Where a chip's description is cut. The same 70 the list has always used. */
const DESCRIPTION_MAX = 70

/**
 * Lower-case and accent-fold, so typing `cafe` finds `CAFÉ`.
 *
 * Deliberately **not** `product-key.ts`'s `fold`, which exists to decide
 * whether two purchases are the same product and is tuned against the band's
 * gate. Those are different questions: that one may change the day the gate
 * changes, and what a reader can type into a box must not move with it. It also
 * drops punctuation and collapses whitespace, which would be wrong here — a
 * reader searching `75 g/m²` should find it.
 */
function fold(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
}

/**
 * Whether an item answers the text in the box.
 *
 * Every whitespace-separated token must appear, so `papel a4` narrows instead
 * of widening, and the item **number** is part of the haystack: on a 251-item
 * edital the reader often knows the number from the edital PDF and nothing
 * else, and `trimObject` has cut whatever else they might have recognised.
 *
 * An empty or whitespace-only box matches everything rather than nothing — the
 * list's resting state is the whole list, not an empty one.
 */
export function matchesQuery(item: TenderItemView, query: string): boolean {
  const tokens = fold(query)
    .split(/\s+/)
    .filter((token) => token !== '')
  if (tokens.length === 0) return true
  const haystack = fold(`${item.number} ${item.description ?? ''}`)
  return tokens.every((token) => haystack.includes(token))
}

/** A predicate over an item, so the ordering hook below can be tested at all. */
export type ItemPredicate = (item: TenderItemView) => boolean

/**
 * **D33's flag, before D33 exists: `false`, for every item.**
 *
 * The honest count of priceable items today is ~0 (D33, after C3's
 * product-identity gate), and the real signal — *does `priceBand` return
 * non-null for this item* — is 412 ms median and 2 715 ms worst **per item**
 * (B21), so it can only ever be a precomputed column. Until that column exists
 * this answers `false` and the order on screen is the agency's own numbering.
 *
 * It takes no argument on purpose. Reading `item.hasAward` here is the one
 * mistake this card was written to avoid, and a function with nothing to read
 * cannot make it.
 */
export const isPriceable: ItemPredicate = () => false

/**
 * The ordering hook: items a band exists for first, the agency's order within.
 *
 * A **stable partition**, not a sort — `Array.prototype.sort` is stable in
 * every engine we ship to, but a partition says what this does without the
 * reader having to know that, and it cannot accidentally reorder the items
 * inside a group.
 *
 * `priceable` is a parameter so that the partition itself is testable while the
 * flag is constant: with the default it is the identity (proven), and with a
 * predicate the test supplies it moves the marked items to the front and leaves
 * everything else where it was (also proven). That is what "present but inert
 * rather than wrong" has to mean — an untestable hook is not inert, it is
 * unknown.
 */
export function priceableFirst(
  list: readonly TenderItemView[],
  priceable: ItemPredicate = isPriceable,
): TenderItemView[] {
  const first: TenderItemView[] = []
  const rest: TenderItemView[] = []
  for (const item of list) {
    if (priceable(item)) first.push(item)
    else rest.push(item)
  }
  return [...first, ...rest]
}

/** `Item 12 · resma de papel A4…` — one chip's words, cut at 70. */
export function itemLabel(item: TenderItemView): string {
  return item.description
    ? format(page.item, {
        numero: item.number,
        descricao: trimObject(item.description, DESCRIPTION_MAX),
      })
    : format(copy.card.items, { count: item.number })
}

const CHIP = 'flex min-h-touch items-center rounded-control border px-3 text-body no-underline'
const CHIP_CURRENT = 'border-blue-line bg-blue-soft text-blue'
const CHIP_OTHER = 'border-line-strong bg-surface text-ink'

export type ItemPickerProps = {
  tenderId: string
  /** The search that got the reader here — every chip carries it on. */
  search: RadarSearch
  list: TenderItemView[]
  /** The item the screen is about, as `chooseItem` resolved it. */
  chosen: TenderItemView
}

export function ItemPicker({ tenderId, search, list, chosen }: ItemPickerProps) {
  /**
   * The raw box text. No debounce and no effect: the filter is a pure function
   * of this string, so `renderToStaticMarkup` sees the resting list and the
   * browser sees the filtered one — the split §4c asks for, with nothing in
   * between that only one of them can run.
   */
  const [query, setQuery] = useState('')
  const headingId = useId()

  const ordered = priceableFirst(list)

  if (list.length <= COLLAPSE_FROM) {
    // Short list: the arrangement is the list. Same markup as before D34.
    return (
      <nav aria-label={page.itemsLabel} className="flex flex-col gap-1">
        {ordered.map((item) => (
          <ItemChip key={item.number} {...{ tenderId, search, item, chosen }} />
        ))}
      </nav>
    )
  }

  const matched = ordered.filter((item) => matchesQuery(item, query))
  const shown = matched.slice(0, LIST_CAP)

  return (
    <details className="group rounded-card border border-line-strong bg-surface">
      <summary className="cursor-pointer list-none px-3 py-2.5 [&::-webkit-details-marker]:hidden">
        {/* No width breakpoint — see the note at the top of this file. The row
            wraps on a narrow column and sits on one line on a wide one, with
            no number for a future editor to get wrong. */}
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span id={headingId} className="text-meta font-medium text-ink">
            {page.itemsLabel}
          </span>
          {/* **The count, twice, because CSS can read the open state and
              JavaScript here cannot.** `environment: 'node'` runs no effect and
              a `<details>` toggle fires none we listen to, so there is no React
              state saying whether this is open. Collapsed, exactly one item is
              on screen — the chosen one, below — so the true sentence is
              "Mostrando 1 de 251 itens"; open, it is however many rows the list
              drew. Both are computed on render and the one that does not apply
              is `display: none`, which is the same trick `LongText`'s
              "Ver mais / Ver menos" already uses. */}
          <span className="text-caption text-muted tabular-nums">
            <span className="group-open:hidden">
              {format(itemCopy.showing, { shown: 1, total: list.length })}
            </span>
            <span className="hidden group-open:inline">
              {format(itemCopy.showing, { shown: shown.length, total: list.length })}
            </span>
          </span>
          <span className="flex min-h-touch items-center gap-1.5 text-meta font-medium text-blue">
            <Icon
              name="chevronRight"
              size={14}
              className="transition-transform group-open:rotate-90"
            />
            <span className="group-open:hidden">{itemCopy.showMore}</span>
            <span className="hidden group-open:inline">{itemCopy.less}</span>
          </span>
        </div>

        {/* **The chosen item survives the collapse.** It is a `<span>` and not
            the `<a>` the list draws: it is the page you are on, and an anchor
            inside `<summary>` is a control inside a control. The real
            `aria-current="page"` link is in the list below. */}
        <span className={cn(CHIP, CHIP_CURRENT, 'mt-1.5 group-open:hidden')}>
          {itemLabel(chosen)}
        </span>
      </summary>

      <div className="flex flex-col gap-2 border-t border-line px-3 py-2.5">
        {/* **A search field with no label of its own.** Its accessible name is
            the group heading above (`aria-labelledby`), its role comes from
            `type="search"`, and the magnifier is the set's own `search` icon.
            A placeholder or a visible label would be a new user-facing string,
            and those are Sci's — D47. `text-base` and `min-h-control` are
            `components/field.tsx`'s, including the reason: iOS Safari zooms the
            viewport for a focused input under 16px. */}
        <div className="flex items-center gap-2 rounded-control border border-field-line bg-surface pl-3">
          <Icon name="search" size={18} className="text-muted" />
          <input
            type="search"
            aria-labelledby={headingId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-h-control w-full border-0 bg-transparent pr-3 text-base text-ink outline-none"
          />
        </div>

        {/* Bounded, so a long edital cannot push the price card off the screen
            again: the list scrolls inside itself and the page does not grow
            with the number of items. A height, so no breakpoint — the rail
            takes width, never height. */}
        <nav
          aria-label={page.itemsLabel}
          className="flex max-h-[60vh] flex-col gap-1 overflow-y-auto"
        >
          {shown.map((item) => (
            <ItemChip key={item.number} {...{ tenderId, search, item, chosen }} />
          ))}
        </nav>
      </div>
    </details>
  )
}

function ItemChip({
  tenderId,
  search,
  item,
  chosen,
}: {
  tenderId: string
  search: RadarSearch
  item: TenderItemView
  chosen: TenderItemView
}) {
  const current = item.number === chosen.number
  return (
    <a
      href={priceHref(tenderId, search, item.number)}
      aria-current={current ? 'page' : undefined}
      className={cn(CHIP, current ? CHIP_CURRENT : CHIP_OTHER)}
    >
      {itemLabel(item)}
    </a>
  )
}
