import type { TenderCard } from './contract'

/**
 * Appending a page to the Radar list.
 *
 * `GET /api/radar/tenders` has paged since B-something: `lib/radar/tenders.ts`
 * carries a keyset cursor over `(proposals_close_at, id)`, the envelope carries
 * `nextCursor`, and `tendersUrl` knows how to ask for one. What was missing was
 * the control — `radar.list.more` ("Ver mais editais") existed in the catalogue
 * and nothing rendered it, so a CNPJ with 79 compatible tenders showed 20 and
 * the other 59 were unreachable. This is the merge that button needs.
 *
 * ## Append, never replace
 *
 * The list is ordered by deadline: page 2 is *later* than page 1, and a user
 * who has read to the bottom is reading forward in time. Replacing the array
 * would throw away what they just scrolled past and move their scroll position
 * under them.
 *
 * ## Why it de-duplicates when the cursor should make that impossible
 *
 * Keyset pagination is exactly what stops a row inserted between two page loads
 * from shifting the window — that is why `tenders.ts` uses it instead of
 * `offset`. But the sweep runs every 30 minutes and may *change* a tender's
 * `proposals_close_at`, which moves it across the cursor, and a duplicated
 * `key` in React is a rendering bug rather than a cosmetic one. One `Set` is
 * cheaper than that class of bug.
 */
export function appendTenders(current: TenderCard[], incoming: TenderCard[]): TenderCard[] {
  if (incoming.length === 0) return current
  if (current.length === 0) return incoming
  const seen = new Set(current.map((tender) => tender.id))
  const fresh = incoming.filter((tender) => !seen.has(tender.id))
  return fresh.length === 0 ? current : [...current, ...fresh]
}
