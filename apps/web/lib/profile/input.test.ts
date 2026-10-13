import { describe, expect, it } from 'vitest'
import { PROFILE_ERRORS, profileErrors, profileInput } from './input'

const valid = {
  name: 'Maria Silva',
  mobile: '+55 (11) 99999-9999',
  cnpj: '36.955.612/0001-85',
}

const parse = (over: Record<string, unknown> = {}) => profileInput.safeParse({ ...valid, ...over })

describe('profileInput (F31)', () => {
  it('accepts the three fields the privacy policy already covers', () => {
    const result = parse()
    expect(result.success).toBe(true)
    expect(result.success && result.data).toEqual({
      name: 'Maria Silva',
      mobile: '+5511999999999',
      cnpj: '36955612000185',
    })
  })

  it('collapses whitespace in a name rather than rejecting it', () => {
    const result = parse({ name: '  Maria   da  Silva  ' })
    expect(result.success && result.data.name).toBe('Maria da Silva')
  })

  it('requires a name, which is what closes F29', () => {
    for (const name of ['', '   ', 'M', '.', '--', '1']) {
      const result = parse({ name })
      expect(result.success, JSON.stringify(name)).toBe(false)
      expect(!result.success && profileErrors(result.error).name).toBe(PROFILE_ERRORS.name)
    }
  })

  it('accepts a name in any script, because names are not ASCII', () => {
    for (const name of ['José Antônio', 'Ngô Bảo Châu', 'Åsa Lindqvist', 'Bo Li']) {
      expect(parse({ name }).success, name).toBe(true)
    }
  })

  it('refuses a name longer than Asaas will take', () => {
    expect(parse({ name: 'a'.repeat(121) }).success).toBe(false)
    expect(parse({ name: 'a'.repeat(120) }).success).toBe(true)
  })

  it('stores the mobile in E.164 and accepts a stated foreign code', () => {
    expect(parse({ mobile: '11999999999' }).success && true).toBe(true)
    const foreign = parse({ mobile: '+351 963 602 316' })
    expect(foreign.success && foreign.data.mobile).toBe('+351963602316')
  })

  it('refuses a mobile that would be reinterpreted, not just a malformed one', () => {
    for (const mobile of ['', '119999', '(11) 1234-5678', '351963602316']) {
      const result = parse({ mobile })
      expect(result.success, JSON.stringify(mobile)).toBe(false)
      expect(!result.success && profileErrors(result.error).mobile).toBe(PROFILE_ERRORS.mobile)
    }
  })

  it('requires a CNPJ, because Asaas needs a document to charge anybody', () => {
    for (const cnpj of ['', '   ', '36955612000100', '123']) {
      const result = parse({ cnpj })
      expect(result.success, JSON.stringify(cnpj)).toBe(false)
      expect(!result.success && profileErrors(result.error).cnpj).toBe(PROFILE_ERRORS.cnpj)
    }
  })

  /*
   * The two fields Sci asked for that this form does not collect. The columns
   * exist and the privacy policy names neither, so a schema that accepted them
   * would be the one place a future caller could write one. `.strict()` is not
   * used anywhere else in this repo's schemas, so the assertion is that they
   * are absent from the output rather than that the input is refused.
   */
  it('does not collect a birth date or a CPF, which the policy does not name', () => {
    const result = profileInput.safeParse({
      ...valid,
      birthDate: '1980-01-01',
      birth_date: '1980-01-01',
      cpf: '12345678909',
    })
    expect(result.success).toBe(true)
    expect(result.success && Object.keys(result.data).sort()).toEqual(['cnpj', 'mobile', 'name'])
  })

  it('does not collect a business name either — F38 brings the column', () => {
    const result = profileInput.safeParse({ ...valid, companyName: 'Padaria do Ze' })
    expect(result.success && Object.keys(result.data)).not.toContain('companyName')
  })

  it('reports one error per field, first wins', () => {
    const result = parse({ name: '', mobile: 'x', cnpj: '' })
    expect(result.success).toBe(false)
    expect(!result.success && profileErrors(result.error)).toEqual({
      name: PROFILE_ERRORS.name,
      mobile: PROFILE_ERRORS.mobile,
      cnpj: PROFILE_ERRORS.cnpj,
    })
  })
})
