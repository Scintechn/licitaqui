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
 * One entry per seat, for the 48-cell grid on the offer page.
 *
 * The page is statically rendered, so today every cell is drawn empty: the live
 * count comes from `GET /api/founders/seats`, which is task F1.
 */
export function seatGrid(taken = 0): { seat: number; filled: boolean }[] {
  const filled = seatsTaken(taken)
  return Array.from({ length: FOUNDER_SEATS }, (_, index) => ({
    seat: index + 1,
    filled: index < filled,
  }))
}
