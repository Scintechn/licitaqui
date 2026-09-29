import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MAX_SEAT } from '@/lib/auth/founder-seat'
import { describe, expect, it } from 'vitest'
import { FOUNDERS } from '../product'
import {
  FOUNDER_SEATS,
  firstLotLabel,
  seatGrid,
  seatsFilledLabel,
  seatsLeft,
  seatsLeftLabel,
  seatsTaken,
  showSeatGrid,
  soldOutLabel,
} from './seats'

describe('FOUNDER_SEATS', () => {
  it('is the open lot, not the contractual total', () => {
    // Two different facts. Terms §6 sells 25 in two lots; this is how many are
    // open. Conflating them would sell 25 seats and hand out 17.
    expect(FOUNDER_SEATS).toBe(FOUNDERS.seatsOpenDefault)
    expect(FOUNDER_SEATS).toBeLessThanOrEqual(FOUNDERS.seatsTotal)
  })
})

describe('seatsTaken', () => {
  it('passes a sane count through', () => {
    expect(seatsTaken(0)).toBe(0)
    expect(seatsTaken(17)).toBe(17)
    expect(seatsTaken(FOUNDER_SEATS)).toBe(FOUNDER_SEATS)
  })

  it('never reports more seats taken than exist', () => {
    expect(seatsTaken(FOUNDER_SEATS + 1)).toBe(FOUNDER_SEATS)
    expect(seatsTaken(1000)).toBe(FOUNDER_SEATS)
  })

  it('never reports a negative or fractional count', () => {
    expect(seatsTaken(-3)).toBe(0)
    expect(seatsTaken(4.7)).toBe(4)
  })

  it('treats a missing count as nothing taken', () => {
    expect(seatsTaken(Number.NaN)).toBe(0)
    expect(seatsTaken(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('seatsLeft', () => {
  it('counts down from the cap and stops at zero', () => {
    expect(seatsLeft(0)).toBe(FOUNDER_SEATS)
    expect(seatsLeft(FOUNDER_SEATS - 1)).toBe(1)
    expect(seatsLeft(FOUNDER_SEATS)).toBe(0)
    expect(seatsLeft(60)).toBe(0)
  })
})

describe('seatsLeftLabel', () => {
  it('uses the plural the catalogue defines', () => {
    expect(seatsLeftLabel(0)).toBe(`Restam ${FOUNDER_SEATS} vagas`)
    expect(seatsLeftLabel(FOUNDER_SEATS - 1)).toBe('Resta 1 vaga')
    expect(seatsLeftLabel(FOUNDER_SEATS)).toBe('Vagas esgotadas')
  })

  it('says "esgotadas" rather than a negative number when oversold', () => {
    expect(seatsLeftLabel(51)).toBe('Vagas esgotadas')
  })
})

describe('seatsFilledLabel', () => {
  it('counts against the open cap, not the 25 the terms promise', () => {
    expect(seatsFilledLabel(12)).toBe(`12 de ${FOUNDER_SEATS} vagas preenchidas`)
    expect(seatsFilledLabel(FOUNDER_SEATS)).toBe(
      `${FOUNDER_SEATS} de ${FOUNDER_SEATS} vagas preenchidas`,
    )
  })
})

describe('seatGrid', () => {
  it('always draws exactly one cell per open seat', () => {
    const grid = seatGrid()
    expect(grid).toHaveLength(FOUNDER_SEATS)
    expect(grid[0]).toEqual({ seat: 1, filled: false })
    expect(grid[FOUNDER_SEATS - 1]).toEqual({ seat: FOUNDER_SEATS, filled: false })
  })

  it('fills the first N cells', () => {
    const grid = seatGrid(3)
    expect(grid.filter((cell) => cell.filled).map((cell) => cell.seat)).toEqual([1, 2, 3])
  })

  it('never fills more cells than there are seats', () => {
    expect(seatGrid(99).every((cell) => cell.filled)).toBe(true)
  })
})

describe('showSeatGrid', () => {
  it('draws nothing while no seat has been taken', () => {
    // A grid of visibly empty boxes under "Restam N vagas" is a picture of
    // an empty room. Scarcity framing only works above zero.
    expect(showSeatGrid(0)).toBe(false)
  })

  it('draws nothing when the live count never arrived', () => {
    // `/fundadores` is statically rendered, so this is the state of every
    // first paint — the case that made the empty room ship to everyone.
    expect(showSeatGrid(null)).toBe(false)
  })

  it('draws the grid from the first seat sold', () => {
    expect(showSeatGrid(1)).toBe(true)
    expect(showSeatGrid(24)).toBe(true)
  })

  it('still draws it when the offer is full', () => {
    expect(showSeatGrid(FOUNDER_SEATS)).toBe(true)
    expect(showSeatGrid(60)).toBe(true)
  })

  it('treats a nonsense count as nothing to show', () => {
    expect(showSeatGrid(-3)).toBe(false)
    expect(showSeatGrid(Number.NaN)).toBe(false)
  })
})

describe('firstLotLabel', () => {
  it('names the lot while one is still unopened', () => {
    // Sci, 2026-09-28: 25 in total, opened in two lots of 17 and 8. The page
    // quotes 25 in prose and counts down from 17; this is the sentence that
    // says why those are different numbers rather than a contradiction.
    expect(firstLotLabel(17, 25)).toBe('Primeiro lote 17 vagas')
  })

  it('says nothing once every seat is open', () => {
    // **The reason lot 2 is a database change and not a deploy.** Raise the
    // cap to 25 and the phrase removes itself; nobody has to remember that
    // three strings still say "primeiro lote" on the evening it opens.
    expect(firstLotLabel(25, 25)).toBeNull()
    expect(firstLotLabel(26, 25)).toBeNull()
  })

  it('agrees in pt-BR when a lot holds one seat', () => {
    expect(firstLotLabel(1, 25)).toBe('Primeiro lote 1 vaga')
  })

  it('says nothing rather than something absurd when the cap is unusable', () => {
    // A marketing counter must never invent a number — `seat-count.ts` makes
    // the same argument for `null` over a fabricated remainder.
    expect(firstLotLabel(0, 25)).toBeNull()
    expect(firstLotLabel(-3, 25)).toBeNull()
    expect(firstLotLabel(Number.NaN, 25)).toBeNull()
  })

  it('defaults its total to the contractual figure', () => {
    expect(firstLotLabel(FOUNDER_SEATS)).toBe(firstLotLabel(FOUNDER_SEATS, FOUNDERS.seatsTotal))
  })
})

describe('soldOutLabel', () => {
  it('does not claim all 25 are gone when only the first lot is', () => {
    // The defect this closes: the page said "As 17 vagas acabaram" beside
    // "As 25 vagas de fundador acabaram", two figures for one state, and the
    // second was false — eight seats had not been offered to anybody yet.
    const label = soldOutLabel(17, 25)
    expect(label).toContain('primeiro lote')
    expect(label).toContain('17')
    expect(label).not.toContain('25')
  })

  it('claims exactly that once every seat has been offered', () => {
    const label = soldOutLabel(25, 25)
    expect(label).toContain('25')
    expect(label).not.toContain('primeiro lote')
  })
})

describe('the database bound is never shown as the offer size', () => {
  /**
   * `MAX_SEAT` is 48 because spec §6.2 gives `founder_seat` a
   * `between 1 and 48` CHECK. It is a validity bound for a column. It is not
   * how many seats are on sale, and on 2026-09-29 `/conta` rendered it as
   * "Vaga 1 de 48" while the landing banner said "restam 16 de 17 vagas" and
   * the terms sold 25 — three numbers for one offer, live.
   *
   * It survived D18 for a reason worth remembering: a blanket replacement of
   * `48` was rejected because it would have corrupted
   * `SEAT_LOCK = { namespace: 19537, key: 48 }` in `signup.ts`, and this
   * constant was excluded along with it.
   */
  it('keeps MAX_SEAT distinct from the number of seats sold', () => {
    expect(MAX_SEAT).toBeGreaterThanOrEqual(FOUNDERS.seatsTotal)
    expect(FOUNDERS.seatsTotal).not.toBe(MAX_SEAT)
  })

  it('shows the offer size on the account screens, not the column bound', () => {
    // **Scans the tree, not one file.** This used to name `app/conta/page.tsx`
    // and broke the moment D22 split that screen in three and the seat row
    // moved to `/conta/plano` — a guard that fails because the code moved
    // teaches the next person to weaken it. What must stay true is that no
    // account screen passes the column bound, wherever the row lives.
    const root = fileURLToPath(new URL('../../app/conta', import.meta.url))
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.tsx') && !name.endsWith('.test.tsx'))
      .map((name) => readFileSync(join(root, name), 'utf8'))

    expect(files.some((source) => source.includes('seatTotal={FOUNDERS.seatsTotal}'))).toBe(true)
    for (const source of files) {
      expect(source).not.toContain('seatTotal={MAX_SEAT}')
    }
  })
})
