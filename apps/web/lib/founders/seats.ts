import { format, messages } from '../messages'

/**
 * Spec §10: the Promocional price (R$ 26/month for the first 6 months, then
 * R$ 57) is capped at 48 founder seats. The number lives here rather than in
 * the copy so the offer page, the seat grid and — later — task F1's seat
 * assignment all count the same thing.
 */
export const FOUNDER_SEATS = 48

/** Seats actually taken, clamped into 0..FOUNDER_SEATS. */
export function seatsTaken(taken: number): number {
  if (!Number.isFinite(taken)) return 0
  return Math.min(FOUNDER_SEATS, Math.max(0, Math.floor(taken)))
}

/** Seats still available at the founder price. Never negative. */
export function seatsLeft(taken: number): number {
  return FOUNDER_SEATS - seatsTaken(taken)
}

/** "Restam 12 vagas" / "Resta 1 vaga" / "Vagas esgotadas". */
export function seatsLeftLabel(taken: number): string {
  return format(messages.founders.seats.left, { count: seatsLeft(taken) })
}

/** "36 de 48 vagas preenchidas". */
export function seatsFilledLabel(taken: number): string {
  return format(messages.founders.seats.of, { count: seatsTaken(taken) })
}

/**
 * Whether the 48-cell grid is worth drawing at all.
 *
 * Scarcity framing only works above zero. With no seat taken the grid is forty
 * eight visibly empty boxes under "Restam 48 vagas" — a picture of an empty
 * room, on the page traffic lands on during founders week. The sentence alone
 * says the same thing without the picture contradicting it.
 *
 * `null` — the live count has not arrived, or failed — is the case that made
 * this necessary rather than merely nicer. `/fundadores` is statically rendered
 * (spec §3.3), so `taken` is **always** null in the HTML: before this, every
 * first paint drew the empty room, for every visitor, no matter how many seats
 * had actually sold. The grid now appears when the count arrives and says there
 * is something to show, which is also the moment it starts meaning something.
 */
export function showSeatGrid(taken: number | null): boolean {
  return taken !== null && seatsTaken(taken) > 0
}

/**
 * One entry per seat, for the 48-cell grid on the offer page.
 *
 * Only rendered once `showSeatGrid()` agrees there is a seat to show; the live
 * count comes from `GET /api/founders/seats` (task F1).
 */
export function seatGrid(taken = 0): { seat: number; filled: boolean }[] {
  const filled = seatsTaken(taken)
  return Array.from({ length: FOUNDER_SEATS }, (_, index) => ({
    seat: index + 1,
    filled: index < filled,
  }))
}
