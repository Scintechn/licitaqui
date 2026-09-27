import { describe, expect, it } from 'vitest'
import { FOUNDERS } from '../product'
import {
  FOUNDER_SEATS,
  seatGrid,
  seatsFilledLabel,
  seatsLeft,
  seatsLeftLabel,
  seatsTaken,
  showSeatGrid,
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
