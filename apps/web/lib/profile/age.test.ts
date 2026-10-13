import { describe, expect, it } from 'vitest'
import { parseBirthDate } from './age'

/** Midday UTC on 2026-10-13, which is 09:00 in São Paulo — same calendar day. */
const NOW = new Date('2026-10-13T12:00:00Z')

describe('parseBirthDate (F31)', () => {
  it('accepts a date that makes somebody an adult', () => {
    expect(parseBirthDate('1980-05-20', NOW)).toEqual({ iso: '1980-05-20' })
    expect(parseBirthDate('  1980-05-20  ', NOW)).toEqual({ iso: '1980-05-20' })
  })

  it('accepts the eighteenth birthday itself and refuses the day before', () => {
    expect(parseBirthDate('2008-10-13', NOW)).toEqual({ iso: '2008-10-13' })
    expect(parseBirthDate('2008-10-14', NOW)).toBeNull()
  })

  /*
   * CLAUDE.md, Clocks. Somebody turning 18 today in Brasília is still 17 by a
   * UTC clock for the first three hours of the Brazilian day, so this asks the
   * question in the product's timezone. At 01:00 UTC on the 13th it is still
   * the 12th in São Paulo — so the 18th birthday has not arrived yet.
   */
  it('asks the question in the product clock, not UTC', () => {
    const earlyUtc = new Date('2026-10-13T01:00:00Z') // 22:00 on the 12th, BRT
    expect(parseBirthDate('2008-10-13', earlyUtc)).toBeNull()
    expect(parseBirthDate('2008-10-12', earlyUtc)).toEqual({ iso: '2008-10-12' })
  })

  it('refuses a child, whatever the month', () => {
    for (const date of ['2010-01-01', '2020-06-15', '2026-10-12']) {
      expect(parseBirthDate(date, NOW), date).toBeNull()
    }
  })

  it('refuses the future', () => {
    expect(parseBirthDate('2027-01-01', NOW)).toBeNull()
    expect(parseBirthDate('2026-10-14', NOW)).toBeNull()
  })

  it('refuses an age nobody has', () => {
    expect(parseBirthDate('1900-01-01', NOW)).toBeNull()
    expect(parseBirthDate('1906-10-14', NOW)).toEqual({ iso: '1906-10-14' })
  })

  /*
   * `new Date(2026, 1, 31)` is 3 March. A validator that trusted the
   * constructor would accept a date that does not exist and store a different
   * one — the same shape as reading `+1` digits as Brazilian.
   */
  it('refuses a date that does not exist instead of rolling it forward', () => {
    expect(parseBirthDate('1990-02-31', NOW)).toBeNull()
    expect(parseBirthDate('1990-13-01', NOW)).toBeNull()
    expect(parseBirthDate('1990-00-10', NOW)).toBeNull()
    expect(parseBirthDate('1990-04-31', NOW)).toBeNull()
    // 1992 was a leap year; 1991 was not.
    expect(parseBirthDate('1992-02-29', NOW)).toEqual({ iso: '1992-02-29' })
    expect(parseBirthDate('1991-02-29', NOW)).toBeNull()
  })

  it('takes only what the date input posts, because a typed date is ambiguous', () => {
    for (const date of ['20/05/1980', '05/20/1980', '1980-5-20', '19800520', '', '   ', 'ontem']) {
      expect(parseBirthDate(date, NOW), JSON.stringify(date)).toBeNull()
    }
  })
})

/*
 * Found by review 2026-10-13. The first version parsed
 * `Intl.DateTimeFormat('en-CA').format()` with `.split('-')`, so a runtime
 * without `en-CA` data (which formats `10/13/2026`) produced `NaN` for the
 * age — and `NaN < 18` and `NaN > 120` are **both** false, so every date was
 * accepted, including a child's. On the one validator whose job is refusing
 * children. §4d: the fix is the shape, not the threshold.
 */
describe('parseBirthDate when the runtime cannot say what day it is', () => {
  it('refuses rather than accepting everything', () => {
    const real = Intl.DateTimeFormat
    try {
      // A formatter that yields no usable year/month/day fields, which is what
      // a missing locale degrades to.
      // @ts-expect-error — replacing a built-in for one assertion.
      Intl.DateTimeFormat = class {
        formatToParts() {
          return [{ type: 'literal', value: '10/13/2026' }]
        }
      }
      expect(parseBirthDate('2020-01-01')).toBeNull()
      // And the safe direction is refusing even a date that *would* be fine.
      expect(parseBirthDate('1980-05-20')).toBeNull()
    } finally {
      Intl.DateTimeFormat = real
    }
    // Restored, so the rest of the file is unaffected.
    expect(parseBirthDate('1980-05-20', NOW)).toEqual({ iso: '1980-05-20' })
  })
})
