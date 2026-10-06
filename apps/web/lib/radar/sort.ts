import { DEFAULT_SORT, TENDER_SORTS, type TenderSort } from './contract'

/**
 * `?sort=` read out of a query string (D51).
 *
 * The counterpart of `readGroup()` in `group.ts`, with one deliberate
 * difference: this one **cannot** answer `null`. A group has a meaningful
 * "unchosen" state — the counts elect a tab — while an order does not: the rows
 * come back in some order whether the reader asked or not, and the one the
 * product has always shown is the deadline. So an absent, misspelt or
 * hand-edited `?sort=` all mean `deadline`, which is also what the list did
 * before this parameter existed.
 *
 * The API route is stricter on purpose: there `sort` goes through `z.enum`, so
 * a value we do not recognise is a 400 rather than a silent fallback, the same
 * as `group`. A URL a human typed must degrade; a request our own client built
 * must not lie about what it asked for.
 */
export function readSort(value: string | null | undefined): TenderSort {
  return (TENDER_SORTS as readonly string[]).includes(value ?? '')
    ? (value as TenderSort)
    : DEFAULT_SORT
}
