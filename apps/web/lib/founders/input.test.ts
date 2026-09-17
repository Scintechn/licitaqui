import { describe, expect, it } from 'vitest'
import { fieldErrors, normaliseCnpj, normaliseWhatsapp, signupInput } from './input'

const valid = {
  name: '  Maria   Souza ',
  email: '  Maria@Empresa.COM.BR ',
  whatsapp: '(11) 99999-9999',
  cnpj: '00.394.429/0001-00',
  sells: '  material de escritório ',
  contactConsent: true,
  acceptedTerms: true,
}

describe('normaliseWhatsapp', () => {
  it('accepts the shapes a Brazilian actually types', () => {
    expect(normaliseWhatsapp('(11) 99999-9999')).toBe('+5511999999999')
    expect(normaliseWhatsapp('11999999999')).toBe('+5511999999999')
    expect(normaliseWhatsapp('+55 (11) 99999-9999')).toBe('+5511999999999')
    expect(normaliseWhatsapp('55 11 99999 9999')).toBe('+5511999999999')
    expect(normaliseWhatsapp('(11) 3333-4444')).toBe('+551133334444')
  })

  it('rejects a number that cannot be dialled', () => {
    expect(normaliseWhatsapp('99999-9999')).toBeNull() // no area code
    expect(normaliseWhatsapp('(01) 99999-9999')).toBeNull() // no such area code
    expect(normaliseWhatsapp('(11) 89999-9999')).toBeNull() // mobiles start with 9
    expect(normaliseWhatsapp('')).toBeNull()
    expect(normaliseWhatsapp('abc')).toBeNull()
  })
})

describe('normaliseCnpj', () => {
  it('keeps 14 digits and drops the punctuation', () => {
    expect(normaliseCnpj('00.394.429/0001-00')).toBe('00394429000100')
    expect(normaliseCnpj('00394429000100')).toBe('00394429000100')
  })

  it('rejects the wrong length, repeated digits and bad check digits', () => {
    expect(normaliseCnpj('0039442900010')).toBeNull()
    expect(normaliseCnpj('11111111111111')).toBeNull()
    expect(normaliseCnpj('00394429000101')).toBeNull()
  })
})

describe('signupInput', () => {
  it('trims, lowercases and normalises everything it stores', () => {
    const parsed = signupInput.parse(valid)
    expect(parsed).toMatchObject({
      name: 'Maria Souza',
      email: 'maria@empresa.com.br',
      whatsapp: '+5511999999999',
      cnpj: '00394429000100',
      sells: 'material de escritório',
    })
  })

  it('requires the CNPJ (Sci\'s decision) and leaves "o que você vende" optional', () => {
    expect(signupInput.safeParse({ ...valid, cnpj: undefined }).success).toBe(false)
    expect(signupInput.safeParse({ ...valid, cnpj: '123' }).success).toBe(false)

    const withoutSells = signupInput.parse({ ...valid, sells: '   ' })
    expect(withoutSells.sells).toBeUndefined()
    expect(signupInput.parse({ ...valid, sells: undefined }).sells).toBeUndefined()
  })

  it('refuses a signup whose consent boxes are not both ticked', () => {
    expect(signupInput.safeParse({ ...valid, contactConsent: false }).success).toBe(false)
    expect(signupInput.safeParse({ ...valid, acceptedTerms: false }).success).toBe(false)
    expect(signupInput.safeParse({ ...valid, contactConsent: undefined }).success).toBe(false)
  })

  it('answers with catalogue keys, never with sentences', () => {
    const parsed = signupInput.safeParse({
      name: '',
      email: 'nope',
      whatsapp: '1',
      cnpj: '1',
      contactConsent: false,
      acceptedTerms: false,
    })
    expect(parsed.success).toBe(false)
    expect(parsed.success ? {} : fieldErrors(parsed.error)).toEqual({
      name: 'nameRequired',
      email: 'emailInvalid',
      whatsapp: 'whatsappInvalid',
      cnpj: 'cnpjInvalid',
      contactConsent: 'foundersRequired',
      acceptedTerms: 'termsRequired',
    })
  })

  it('keeps `source` to a utm-shaped token', () => {
    expect(signupInput.parse({ ...valid, source: 'instagram_bio' }).source).toBe('instagram_bio')
    expect(signupInput.safeParse({ ...valid, source: 'maria@empresa.com' }).success).toBe(false)
    expect(signupInput.parse({ ...valid, source: '' }).source).toBeUndefined()
  })
})
