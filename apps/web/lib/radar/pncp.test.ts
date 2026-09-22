import { describe, expect, it } from 'vitest'
import { parsePncpId, pncpEditalUrl } from './pncp'

/**
 * The malformed cases are the reason this file exists. A parser that returns
 * *something* for a broken id ships a link to a PNCP page that does not exist,
 * on the one screen whose job is to let a user verify us against the source.
 * Every bad input below must produce `null`, not a best effort.
 */

describe('parsePncpId', () => {
  it('reads the four fields of the worked example', () => {
    expect(parsePncpId('87612826000190-1-000958/2026')).toEqual({
      cnpj: '87612826000190',
      instrument: 1,
      sequence: 958,
      year: 2026,
    })
  })

  it('strips the leading zeros from the sequence', () => {
    expect(parsePncpId('01614516000199-1-000040/2026')?.sequence).toBe(40)
    expect(parsePncpId('01298975000100-1-000157/2026')?.sequence).toBe(157)
  })

  it('keeps a sequence that is already longer than six digits', () => {
    // Fortaleza publishes past 24 000 a year; the id is not padded to six.
    expect(parsePncpId('07954480000179-1-024424/2026')?.sequence).toBe(24424)
  })

  it('keeps the CNPJ unpunctuated and its own leading zeros', () => {
    expect(parsePncpId('01298975000100-1-000157/2026')?.cnpj).toBe('01298975000100')
  })

  it('tolerates surrounding whitespace, because ids get pasted', () => {
    expect(parsePncpId('  87612826000190-1-000958/2026\n')?.sequence).toBe(958)
  })

  it.each([
    ['empty', ''],
    ['not an id at all', 'not-an-id'],
    ['no year', '87612826000190-1-000958'],
    ['no instrument segment', '87612826000190/2026'],
    ['a CNPJ that is too short', '8761282600019-1-000958/2026'],
    ['a CNPJ that is too long', '876128260001900-1-000958/2026'],
    ['letters in the CNPJ', '8761282600019O-1-000958/2026'],
    ['letters in the sequence', '87612826000190-1-0009S8/2026'],
    ['a two-digit year', '87612826000190-1-000958/26'],
    ['a zero sequence', '87612826000190-1-000000/2026'],
    ['a zero year', '87612826000190-1-000958/0000'],
    ['a sequence past the safe integer range', `87612826000190-1-${'9'.repeat(20)}/2026`],
    ['a trailing path segment', '87612826000190-1-000958/2026/extra'],
    ['an embedded URL', 'https://pncp.gov.br/87612826000190-1-000958/2026'],
    ['a second slash', '87612826000190-1-000958/2026/2026'],
  ])('refuses %s', (_why, id) => {
    expect(parsePncpId(id)).toBeNull()
  })

  it('refuses a non-string', () => {
    expect(parsePncpId(null)).toBeNull()
    expect(parsePncpId(undefined)).toBeNull()
  })
})

describe('pncpEditalUrl', () => {
  it('builds the portal address the task card verified by hand', () => {
    expect(pncpEditalUrl('87612826000190-1-000958/2026')).toBe(
      'https://pncp.gov.br/app/editais/87612826000190/2026/958',
    )
  })

  it.each([
    // One live id per modality, checked against the portal on 2026-09-22.
    ['Pregão - Eletrônico', '01614516000199-1-000040/2026', '01614516000199/2026/40'],
    ['Dispensa', '01298975000100-1-000157/2026', '01298975000100/2026/157'],
    ['Concorrência - Eletrônica', '18663401000197-1-000233/2026', '18663401000197/2026/233'],
  ])('holds for %s', (_modality, id, tail) => {
    expect(pncpEditalUrl(id)).toBe(`https://pncp.gov.br/app/editais/${tail}`)
  })

  it('answers null for a malformed id rather than a broken link', () => {
    expect(pncpEditalUrl('87612826000190-1-000958')).toBeNull()
    expect(pncpEditalUrl('')).toBeNull()
  })

  it('never emits a URL with an empty or undefined path segment', () => {
    for (const bad of ['', 'x', '87612826000190--/2026', '-1-000958/2026']) {
      const url = pncpEditalUrl(bad)
      expect(url).toBeNull()
    }
  })
})
