import { describe, expect, it } from 'vitest'
import { parseMargin } from './margin-ceiling'

describe('parseMargin', () => {
  it('reads an ordinary margin', () => {
    expect(parseMargin('20')).toBe(20)
    expect(parseMargin(' 33 ')).toBe(33)
    expect(parseMargin('0')).toBe(0)
  })

  it('says null for an empty field rather than zero', () => {
    // **The defect this replaced.** `Number('')` is `0` and finite, so holding
    // a number meant backspacing the field snapped the margin to zero — the
    // headline figure jumped to the full median, under a label reading "Teto
    // para manter a margem que você informou", and you could not
    // backspace-then-retype. A wrong figure substituted for a blank one, on
    // the only control this screen has.
    expect(parseMargin('')).toBeNull()
    expect(parseMargin('   ')).toBeNull()
  })

  it('says null rather than guessing at something that is not a number', () => {
    expect(parseMargin('abc')).toBeNull()
    expect(parseMargin('R$ 20')).toBeNull()
    expect(parseMargin('20%')).toBeNull()
  })

  it('refuses a margin that is not a margin', () => {
    // 100% implies a supplier cost of zero; negative is not a question this
    // screen answers. Matches `targetPurchasePrice`'s own bounds so the two
    // cannot disagree about what is valid.
    expect(parseMargin('100')).toBeNull()
    expect(parseMargin('-1')).toBeNull()
    expect(parseMargin('99')).toBe(99)
    expect(parseMargin('99.9')).toBe(99.9)
  })
})
