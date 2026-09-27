import { format, messages } from '../messages'
import { FOUNDERS } from '../product'

/**
 * How many founder seats are **open**, which is not how many the offer
 * promises.
 *
 * Terms §6 sells 25, released in two lots: 17 now, 8 only if the first fills
 * within two weeks. So the contractual number (`FOUNDERS.seatsTotal`) is what
 * the copy and the legal documents quote, and this is what decides whether a
 * signup gets a seat or a waitlist place.
 *
 * **This will move out of the bundle.** Releasing lot 2 must be an `UPDATE`,
 * not a deploy — a compiled constant puts eight seats behind a CI run, an
 * image build and a redeploy, a chain that took six days end to end on
 * 2026-09-26. Until the `app_settings` row lands, this is the default and the
 * value, and that is the whole of the gap.
 */
export const FOUNDER_SEATS = FOUNDERS.seatsOpenDefault

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

/** "36 de 48 vagas preenchidas".
 *
 * The denominator is the **open** cap, passed at call time — not the 25 the
 * terms promise. A counter reading "12 de 25" while seventeen seats exist
 * would be wrong however generously you read it, and the two numbers only
 * diverged once the offer gained a second lot.
 */
export function seatsFilledLabel(taken: number): string {
  return format(messages.founders.seats.of, { count: seatsTaken(taken), total: FOUNDER_SEATS })
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
