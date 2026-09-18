import { describe, expect, it } from 'vitest'
import { cnpjRef, formatCnpj, normaliseCnpj } from './cnpj'
import { normaliseCnpj as fromFoundersInput } from './founders/input'
import { companyJobKey } from './jobs'

describe('normaliseCnpj', () => {
  it('strips punctuation and keeps the 14 digits', () => {
    expect(normaliseCnpj('00.394.429/0001-00')).toBe('00394429000100')
    expect(normaliseCnpj(' 00394429000100 ')).toBe('00394429000100')
  })

  it('rejects the wrong length, repeated digits and bad check digits', () => {
    expect(normaliseCnpj('0039442900010')).toBeNull()
    expect(normaliseCnpj('003944290001000')).toBeNull()
    // 00000000000000 satisfies mod-11 and is not a CNPJ.
    expect(normaliseCnpj('00000000000000')).toBeNull()
    expect(normaliseCnpj('11111111111111')).toBeNull()
    // The Banco Central's CNPJ with its last digit changed.
    expect(normaliseCnpj('00394429000101')).toBeNull()
  })

  it('is the same function the founders form uses', () => {
    // It moved here in R1 so the Radar and the offer page cannot drift apart.
    expect(fromFoundersInput).toBe(normaliseCnpj)
  })
})

describe('cnpjRef', () => {
  it('reproduces the worker’s digest exactly', () => {
    // `licitaqui.company.cnpj_ref` is `sha256(cnpj)[:16]` over the 14 ASCII
    // digits. These are the values Python produces. If this test fails, the web
    // and the worker will each queue their own `company_lookup` for one CNPJ
    // and the `jobs_dedupe` index will not stop them, because the keys differ.
    expect(cnpjRef('00394429000100')).toBe('95ad8a4712d4cae7')
    expect(cnpjRef('11222333000181')).toBe('74fcb98ff7bb1884')
  })

  it('builds the job key the worker looks for, without the CNPJ in it', () => {
    const key = companyJobKey('00394429000100')
    expect(key).toBe('company:95ad8a4712d4cae7')
    // §12: the queue can be read by an operator; a CNPJ must not be in it.
    expect(key).not.toContain('00394429000100')
  })
})

describe('formatCnpj', () => {
  it('formats for display and leaves anything else alone', () => {
    expect(formatCnpj('00394429000100')).toBe('00.394.429/0001-00')
    expect(formatCnpj('not a cnpj')).toBe('not a cnpj')
  })
})
