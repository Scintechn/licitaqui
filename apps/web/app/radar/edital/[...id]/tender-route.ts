/**
 * Which of the three tender screens a `/radar/edital/…` path asks for.
 *
 * The board gives them three addresses — `/radar/edital/:id`, `…/triagem`,
 * `…/preco` — and Next.js will not build the obvious spelling of the last two:
 * *"Catch-all must be the last part of the URL in route
 * `/radar/edital/[...id]/triagem`"*. A PNCP id contains a slash, so the segment
 * has to be a catch-all, and nothing may be nested inside one.
 *
 * So `page.tsx` keeps taking the whole path and reads the trailing segment as
 * the view. That dispatch lives here, away from the server component, because
 * it is the part with the decisions in it and it is worth a unit test rather
 * than three manual clicks.
 */

/** The screens the id can be followed by, and how the URL spells them. */
export const TENDER_VIEWS = { triagem: 'screening', preco: 'price' } as const

export type TenderView = 'opportunity' | (typeof TENDER_VIEWS)[keyof typeof TENDER_VIEWS]

export type TenderRoute =
  | { view: TenderView; tenderId: string }
  /** The id is malformed — canvas 03's "não encontramos este edital". */
  | { view: 'badId' }
  /** `/radar/edital/<id>/qualquer-coisa` — not a screen, so a real 404. */
  | { view: 'unknown' }

/** PNCP's `numeroControlePNCP`, the same shape the API routes enforce. */
const TENDER_ID_RE = /^\d{14}-\d-\d{6}\/\d{4}$/

/**
 * `['51885242000140-1-000744', '2026', 'triagem']` → the screening of
 * `51885242000140-1-000744/2026`.
 */
export function readTenderRoute(segments: string[] | undefined): TenderRoute {
  const parts = (segments ?? []).filter((part) => part !== '')
  const last = parts[parts.length - 1]
  const suffix =
    last && last in TENDER_VIEWS ? TENDER_VIEWS[last as keyof typeof TENDER_VIEWS] : null
  const idParts = suffix ? parts.slice(0, -1) : parts
  const tenderId = idParts.join('/')

  if (idParts.length === 0) return { view: 'unknown' }
  if (!TENDER_ID_RE.test(tenderId)) {
    // A path with a trailing word we do not serve is a 404; a malformed id on a
    // screen we *do* serve is the "edital não encontrado" card, which keeps the
    // way back to the Radar on screen instead of dead-ending.
    return suffix === null && idParts.length > 2 ? { view: 'unknown' } : { view: 'badId' }
  }
  return { view: suffix ?? 'opportunity', tenderId }
}
