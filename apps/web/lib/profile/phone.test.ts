import { describe, expect, it } from 'vitest'
import { parseBrazilianMobile, parseMobile } from './phone'

describe('parseMobile (F31)', () => {
  it('accepts a Brazilian mobile however it is punctuated', () => {
    for (const written of [
      '+55 (11) 99999-9999',
      '55 11 99999 9999',
      '11999999999',
      '(11) 9 9999-9999',
      '  +5511999999999  ',
    ]) {
      expect(parseMobile(written), written).toEqual({ country: 'BR', e164: '+5511999999999' })
    }
  })

  it('accepts an 8-digit number, which is still issued', () => {
    expect(parseMobile('(11) 3333-4444')).toEqual({ country: 'BR', e164: '+551133334444' })
  })

  /*
   * The defect this module exists for, and it was live in
   * `lib/founders/input.ts`: `digits()` ran before the `+` was read, so a US
   * number whose third digit is a 9 passed every Brazilian rule — area code
   * 12 is Sao Jose dos Campos and `995550000` is a well-formed mobile there.
   * `evolution.py`'s `normalise_number` carries the same warning.
   */
  it('never reinterprets an explicit foreign country code as Brazilian', () => {
    const parsed = parseMobile('+1 299 555 0000')
    expect(parsed).toEqual({ country: 'other', e164: '+12995550000' })
    expect(parsed?.e164).not.toBe('+5512995550000')
  })

  it('accepts other stated country codes as E.164', () => {
    expect(parseMobile('+351 963 602 316')).toEqual({ country: 'other', e164: '+351963602316' })
    expect(parseMobile('+44 7700 900123')).toEqual({ country: 'other', e164: '+447700900123' })
  })

  /*
   * The asymmetry is the point. With a `+` the country code is a fact the
   * person stated; without one it is a guess, and guessing is what messages a
   * stranger. So bare digits are only ever read as Brazilian, and bare digits
   * that are not a Brazilian number are refused rather than promoted.
   */
  it('never reads bare digits as international', () => {
    expect(parseMobile('12995550000')).toEqual({ country: 'BR', e164: '+5512995550000' })
    expect(parseMobile('351963602316')).toBeNull()
    expect(parseMobile('447700900123')).toBeNull()
  })

  it('refuses a landline typed where a mobile was asked for', () => {
    // 9 subscriber digits must start with 9 (ANATEL).
    expect(parseMobile('(11) 1234-5678 9')).toBeNull()
    expect(parseMobile('11123456789')).toBeNull()
  })

  it('refuses an area code that does not exist', () => {
    expect(parseMobile('(10) 99999-9999')).toBeNull()
    expect(parseMobile('(00) 99999-9999')).toBeNull()
    expect(parseMobile('0999999999')).toBeNull()
  })

  it('refuses the wrong number of digits', () => {
    expect(parseMobile('+55')).toBeNull()
    expect(parseMobile('119999')).toBeNull()
    expect(parseMobile('1199999999999999')).toBeNull()
    // E.164 tops out at 15 digits; 16 is not a number anywhere.
    expect(parseMobile('+1234567890123456')).toBeNull()
    expect(parseMobile('+1234567')).toBeNull()
  })

  it('refuses blank, junk and a misplaced plus', () => {
    for (const written of ['', '   ', 'abc', '+', '++5511999999999', '11+999999999']) {
      expect(parseMobile(written), JSON.stringify(written)).toBeNull()
    }
  })

  /*
   * 55 is Santa Maria, RS as well as the country code, so the strip is guarded
   * on length. Without that guard the first of these loses its area code and
   * the second silently becomes a different subscriber's number.
   */
  it('keeps 55 as an area code when it is one', () => {
    expect(parseMobile('(55) 99999-9999')).toEqual({ country: 'BR', e164: '+5555999999999' })
    expect(parseMobile('(55) 3333-4444')).toEqual({ country: 'BR', e164: '+555533334444' })
    expect(parseMobile('+55 55 99999-9999')).toEqual({ country: 'BR', e164: '+5555999999999' })
  })
})

/*
 * Found by review, 2026-10-13, and it is the defect this module was written to
 * prevent — committed by the module itself. `parseMobile` computed `stated`
 * and used it only for the foreign branch, so `brazilianNational` still had to
 * guess whether a leading 55 was the country code or the Santa Maria area
 * code, and guessed by length. `+55 99999-9999` — a stated country code with
 * the DDD forgotten — is 11 digits, so the guard did not fire and the answer
 * was `+5555999999999`: **a real mobile belonging to somebody else**.
 *
 * Load-bearing now rather than theoretical: the mobile is required, it reaches
 * Asaas as `mobilePhone`, and `billing.py` dials it for the terms §7 notice.
 */
describe('parseMobile and a stated country code with no area code', () => {
  it('refuses it instead of reading 55 as Santa Maria', () => {
    for (const written of [
      '+55 99999-9999',
      '+55 999999999',
      '+5599999-9999',
      '+55 9999-9999',
      '+55 3333-4444',
    ]) {
      expect(parseMobile(written), written).toBeNull()
    }
  })

  it('still accepts a stated country code with a real area code', () => {
    expect(parseMobile('+55 11 99999-9999')).toEqual({ country: 'BR', e164: '+5511999999999' })
    expect(parseMobile('+55 55 99999-9999')).toEqual({ country: 'BR', e164: '+5555999999999' })
    expect(parseMobile('+55 55 3333-4444')).toEqual({ country: 'BR', e164: '+555533334444' })
  })

  /*
   * Bare digits keep the length rule, and must: `55999999999` with no `+` is a
   * Santa Maria mobile written without its country code, which is how somebody
   * in Santa Maria writes their own number.
   */
  it('keeps reading bare 55 as an area code', () => {
    expect(parseMobile('55999999999')).toEqual({ country: 'BR', e164: '+5555999999999' })
    expect(parseMobile('5533334444')).toEqual({ country: 'BR', e164: '+555533334444' })
    expect(parseMobile('5511999999999')).toEqual({ country: 'BR', e164: '+5511999999999' })
  })
})

describe('parseMobile and a country code that cannot exist', () => {
  it('refuses a leading zero, which is the international prefix typed twice', () => {
    expect(parseMobile('+00 351 963 602 316')).toBeNull()
    expect(parseMobile('+0 11 99999-9999')).toBeNull()
  })
})

describe('parseBrazilianMobile', () => {
  it('is parseMobile narrowed to what WhatsApp can dial', () => {
    expect(parseBrazilianMobile('+55 11 99999-9999')).toBe('+5511999999999')
    expect(parseBrazilianMobile('11999999999')).toBe('+5511999999999')
  })

  it('refuses a foreign number instead of reinterpreting it', () => {
    expect(parseBrazilianMobile('+1 299 555 0000')).toBeNull()
    expect(parseBrazilianMobile('+351 963 602 316')).toBeNull()
  })
})
