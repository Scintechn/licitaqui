import { describe, expect, it } from 'vitest'
import { founderSeats } from './seat-count'
import { FOUNDER_SEATS } from './seats'

/**
 * The Landing's founders strip reads this. What matters is not the arithmetic —
 * `seats.test.ts` owns that — but the two ways it can answer: a count, or
 * nothing at all. There is no third answer, and in particular no zero standing
 * in for "we could not ask".
 */
describe('founderSeats', () => {
  it('reports what is taken and what is left', async () => {
    await expect(founderSeats(async () => 17)).resolves.toEqual({
      total: FOUNDER_SEATS,
      taken: 17,
      left: FOUNDER_SEATS - 17,
      soldOut: false,
    })
  })

  it('says sold out only when every seat is gone', async () => {
    await expect(founderSeats(async () => FOUNDER_SEATS)).resolves.toMatchObject({
      left: 0,
      soldOut: true,
    })
    await expect(founderSeats(async () => FOUNDER_SEATS - 1)).resolves.toMatchObject({
      soldOut: false,
    })
  })

  it('clamps a count the table should never have produced', async () => {
    await expect(founderSeats(async () => 999)).resolves.toMatchObject({
      taken: FOUNDER_SEATS,
      left: 0,
    })
    await expect(founderSeats(async () => -3)).resolves.toMatchObject({
      taken: 0,
      left: FOUNDER_SEATS,
    })
  })

  /**
   * `next build` runs with no `DATABASE_URL`, and the pool can be down. Either
   * way the page must be told "no count", never "0 taken, 48 left" — that would
   * be a fabricated scarcity number on a paid offer.
   */
  it('answers null when the count cannot be taken', async () => {
    await expect(
      founderSeats(async () => {
        throw new Error('DATABASE_URL is not set')
      }),
    ).resolves.toBeNull()
  })
})
