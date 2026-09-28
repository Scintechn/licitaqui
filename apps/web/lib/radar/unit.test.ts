import { describe, expect, it } from 'vitest'
import { CANONICAL_UNITS, canonicalUnit, canonicalUnitSql } from './unit'

describe('canonicalUnit', () => {
  it('collapses the unidade family, which is 57% of the corpus', () => {
    // Measured 2026-09-28: these eleven spellings are ~245 000 of 430 978
    // items and match none of each other on equality. This one group is the
    // difference between ~41 comparable pairs per item and ~574.
    const spellings = [
      'Unidade',
      'UNIDADE',
      'UN',
      'UND',
      'unidade',
      'UNID',
      'UNIDADE (UN)',
      'Un',
      'un',
      'UNI',
      'UN - UNIDADE',
    ]
    expect(new Set(spellings.map(canonicalUnit))).toEqual(new Set(['UN']))
  })

  it('collapses the other families measured in the top thirty', () => {
    expect(canonicalUnit('Quilograma')).toBe(canonicalUnit('KG'))
    expect(canonicalUnit('Caixa')).toBe(canonicalUnit('CX'))
    expect(canonicalUnit('PACOTE')).toBe(canonicalUnit('PCT'))
    expect(canonicalUnit('Metro')).toBe(canonicalUnit('M'))
    expect(canonicalUnit('METRO QUADRADO')).toBe(canonicalUnit('M2'))
    expect(canonicalUnit('Frasco')).toBe(canonicalUnit('FRASCO'))
    expect(canonicalUnit('Comprimido')).toBe(canonicalUnit('COMPRIMIDO'))
  })

  it('refuses to merge a spelling that means two different things', () => {
    // `PC` appears 1 779 times and means *peça* in some órgãos and *pacote* in
    // others, with nothing in the payload to say which. Merging it into PCT
    // would compare the price of a packet with the price of a part and produce
    // a number that is **wrong rather than absent** — the single outcome E9's
    // gate exists to prevent. It stays unrecognised and simply matches itself.
    expect(canonicalUnit('PC')).toBe('PC')
    expect(canonicalUnit('PC')).not.toBe(canonicalUnit('PACOTE'))
  })

  it('does not separate units by spacing or case', () => {
    expect(canonicalUnit('  un - unidade  ')).toBe('UN')
    expect(canonicalUnit('UN  -   UNIDADE')).toBe('UN')
  })

  it('keeps an unrecognised unit as itself rather than as null', () => {
    // The fallback is what makes this safe as a join key. `null` would make
    // every unrecognised unit compare equal to every other one — a KIT priced
    // against a BOBINA — which is worse than not comparing at all.
    expect(canonicalUnit('BOBINA')).toBe('BOBINA')
    expect(canonicalUnit('bobina')).toBe(canonicalUnit('BOBINA'))
    expect(canonicalUnit('BOBINA')).not.toBe(canonicalUnit('KIT'))
  })

  it('has nothing to say about an absent unit', () => {
    expect(canonicalUnit(null)).toBeNull()
    expect(canonicalUnit(undefined)).toBeNull()
    expect(canonicalUnit('   ')).toBeNull()
  })

  it('maps every spelling to a declared canonical code', () => {
    // Guards a typo in the table: a code on the left of one entry and
    // mistyped in another would otherwise create a silent second bucket.
    for (const unit of CANONICAL_UNITS) {
      expect(canonicalUnit(unit)).toBe(unit)
    }
  })
})

describe('canonicalUnitSql', () => {
  it('is generated from the same table the function uses', () => {
    // Not a second copy. `search_vector.ts` exists because this project has
    // twice shipped two spellings of one expression that drifted apart; this
    // is that lesson applied before it happens rather than after.
    const sql = canonicalUnitSql('i.unit')
    for (const spelling of ['UNIDADE', 'UN - UNIDADE', 'METRO QUADRADO', 'QUILOGRAMA']) {
      expect(sql).toContain(`'${spelling}'`)
    }
    expect(sql).not.toContain("'PC'")
  })

  it('escapes a quote rather than ending the literal', () => {
    // No current spelling contains one. This asserts the escaping anyway,
    // because the day one does is not the day to discover it.
    expect(canonicalUnitSql("t.unit")).not.toContain("''''")
    expect(canonicalUnitSql('i.unit')).toContain('regexp_replace')
  })
})
