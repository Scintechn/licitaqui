import { describe, expect, it } from 'vitest'
import { PROFILE_ERRORS, profileErrors, profileInput } from './input'

const valid = {
  name: 'Maria Silva',
  birthDate: '1980-05-20',
  mobile: '+55 (11) 99999-9999',
  cnpj: '36.955.612/0001-85',
}

const parse = (over: Record<string, unknown> = {}) => profileInput.safeParse({ ...valid, ...over })

describe('profileInput (F31)', () => {
  it('accepts the four fields the privacy policy covers', () => {
    const result = parse()
    expect(result.success).toBe(true)
    expect(result.success && result.data).toEqual({
      name: 'Maria Silva',
      birthDate: '1980-05-20',
      mobile: '+5511999999999',
      cnpj: '36955612000185',
    })
  })

  /*
   * The field the policy's v1.4 amendment unblocked. The rule itself is tested
   * in `age.test.ts`, including the timezone; here the question is only that
   * the schema applies it and reports it as its own field.
   */
  it('requires a date of birth and applies the 18+ rule', () => {
    // Dates chosen not to rot: a 1990 leap-day that never exists, a malformed
    // shape, and a year far enough out that it stays in the future. `2020-01-01`
    // would stop being a rejection in 2038 — `age.test.ts` injects the clock,
    // and this seam cannot, so it must not depend on one.
    for (const birthDate of ['', '20/05/1980', '1990-02-31', '2099-01-01', '1800-01-01']) {
      const result = parse({ birthDate })
      expect(result.success, JSON.stringify(birthDate)).toBe(false)
      expect(!result.success && profileErrors(result.error).birthDate).toBe(PROFILE_ERRORS.birthDate)
    }
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
   * The CPF is the one field Sci asked for that this form still does not
   * collect, and it is no longer a legal blocker — the policy names it from
   * v1.4. **F32** is what stops it: a CNPJ stays required to use the Radar, so
   * a CPF would satisfy only Asaas. `.strict()` is not used anywhere in this
   * repo's schemas, so the assertion is that it is absent from the *output* —
   * which is what makes this schema not the place somebody writes `users.cpf`.
   */
  it('does not collect a CPF, so nothing here can write users.cpf', () => {
    const result = profileInput.safeParse({ ...valid, cpf: '12345678909' })
    expect(result.success).toBe(true)
    expect(result.success && Object.keys(result.data).sort()).toEqual([
      'birthDate',
      'cnpj',
      'mobile',
      'name',
    ])
  })

  it('does not collect a business name either — F38 brings the column', () => {
    const result = profileInput.safeParse({ ...valid, companyName: 'Padaria do Ze' })
    expect(result.success && Object.keys(result.data)).not.toContain('companyName')
  })

  it('reports one error per field, first wins', () => {
    const result = parse({ name: '', birthDate: '', mobile: 'x', cnpj: '' })
    expect(result.success).toBe(false)
    expect(!result.success && profileErrors(result.error)).toEqual({
      name: PROFILE_ERRORS.name,
      birthDate: PROFILE_ERRORS.birthDate,
      mobile: PROFILE_ERRORS.mobile,
      cnpj: PROFILE_ERRORS.cnpj,
    })
  })
})
