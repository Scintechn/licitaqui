import { describe, expect, it } from 'vitest'
import {
  FOUNDER_SEATS,
  seatGrid,
  seatsFilledLabel,
  seatsLeft,
  seatsLeftLabel,
  seatsTaken,
} from './seats'

describe('FOUNDER_SEATS', () => {
  it('is the 48 of spec §10 — the cap on the Promocional price', () => {
    expect(FOUNDER_SEATS).toBe(48)
  })
})

describe('seatsTaken', () => {
  it('passes a sane count through', () => {
    expect(seatsTaken(0)).toBe(0)
    expect(seatsTaken(17)).toBe(17)
    expect(seatsTaken(48)).toBe(48)
  })

  it('never reports more seats taken than exist', () => {
    expect(seatsTaken(49)).toBe(48)
    expect(seatsTaken(1000)).toBe(48)
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
  it('counts down from 48 and stops at zero', () => {
    expect(seatsLeft(0)).toBe(48)
    expect(seatsLeft(47)).toBe(1)
    expect(seatsLeft(48)).toBe(0)
    expect(seatsLeft(60)).toBe(0)
  })
})

describe('seatsLeftLabel', () => {
  it('uses the plural the catalogue defines', () => {
    expect(seatsLeftLabel(0)).toBe('Restam 48 vagas')
    expect(seatsLeftLabel(47)).toBe('Resta 1 vaga')
    expect(seatsLeftLabel(48)).toBe('Vagas esgotadas')
  })

  it('says "esgotadas" rather than a negative number when oversold', () => {
    expect(seatsLeftLabel(51)).toBe('Vagas esgotadas')
  })
})

describe('seatsFilledLabel', () => {
  it('reads "N de 48 vagas preenchidas"', () => {
    expect(seatsFilledLabel(12)).toBe('12 de 48 vagas preenchidas')
    expect(seatsFilledLabel(48)).toBe('48 de 48 vagas preenchidas')
  })
})

describe('seatGrid', () => {
  it('always draws exactly 48 cells, numbered 1..48', () => {
    const grid = seatGrid()
    expect(grid).toHaveLength(48)
    expect(grid[0]).toEqual({ seat: 1, filled: false })
    expect(grid[47]).toEqual({ seat: 48, filled: false })
  })

  it('fills the first N cells', () => {
    const grid = seatGrid(3)
    expect(grid.filter((cell) => cell.filled).map((cell) => cell.seat)).toEqual([1, 2, 3])
  })

  it('never fills more cells than there are seats', () => {
    expect(seatGrid(99).every((cell) => cell.filled)).toBe(true)
  })
})
