import { cleanTitle, trimObject } from './format'

/**
 * The tender's "Objeto", in the two lengths a card needs.
 *
 * ## Why this is a file and not a `slice()` at the point of render
 *
 * On PNCP the whole Objeto is plain text on the page, one click from a search
 * result. On our card it was `trimObject(object, 120)` and nothing else, so
 * reading the rest meant opening the tender — and, for someone who did not
 * know the text was already on the screen, asking for an **AI triagem** that
 * spends a screening to summarise a string the browser is holding.
 *
 * The waste was measurable: of the 20 cards on page 1 for CNPJ
 * 36955612000185, **16 objects are longer than 120 characters** (median 205,
 * longest 512). The full string is already in the list payload —
 * `lib/radar/tenders.ts` selects `t.object` and `toCard()` passes it through —
 * so the card can show all of it for free.
 *
 * ## `expandable` is the honest half
 *
 * A disclosure that opens to the same sentence it was already showing is
 * noise on nineteen cards out of twenty. `expandable` is true only when the
 * full text really is longer than the title the card prints, which is what the
 * card uses to decide whether to render the control at all.
 *
 * Both strings go through `cleanTitle()` — the portal prefix, the shouting and
 * the trailing full stop are presentation, and the reader should not have to
 * read a 500-character paragraph in block capitals to learn what is being
 * bought. Nothing here writes: the database keeps exactly what PNCP published,
 * because that is the string a screening cites.
 */

/** The card's title budget. `trimObject`'s own default, named. */
export const TITLE_MAX = 120

export type TenderObject = {
  /** What the card's title line shows: cleaned and trimmed to `max`. */
  title: string
  /** The whole object, cleaned but never trimmed. */
  full: string
  /** The full text says more than the title does. */
  expandable: boolean
}

export function tenderObject(object: string, max: number = TITLE_MAX): TenderObject {
  const full = cleanTitle(object)
  const title = trimObject(full, max)
  return { title, full, expandable: full !== title }
}
