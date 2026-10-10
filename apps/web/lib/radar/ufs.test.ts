import { describe, expect, it } from 'vitest'
import { messages } from '@/lib/messages'
import { canonicalUfs, normaliseUf, readUfs, UF_CODES, UF_REGIONS, ufSummary } from './ufs'

describe('canonicalUfs', () => {
  it('one order however they were ticked, and no repeats', () => {
    expect(canonicalUfs(['SP', 'rj', 'MG', 'SP'])).toEqual(['MG', 'RJ', 'SP'])
    expect(canonicalUfs(['MG', 'RJ', 'SP'])).toEqual(canonicalUfs(['SP', 'RJ', 'MG']))
  })

  it('reads repeated and comma-separated values as the same search', () => {
    expect(canonicalUfs(['SP,RJ'])).toEqual(canonicalUfs(['SP', 'RJ']))
  })

  it('drops what is not a UF', () => {
    expect(canonicalUfs(['SP', 'ZZ', '', null, undefined, ' rj '])).toEqual(['RJ', 'SP'])
  })

  it('all 27 is the whole country, spelled as nothing', () => {
    expect(canonicalUfs(UF_CODES)).toEqual([])
  })

  it('reads every `uf` of a query string, not the first', () => {
    expect(readUfs(new URLSearchParams('uf=SP&uf=RJ&cnpj=1'))).toEqual(['RJ', 'SP'])
    expect(readUfs(new URLSearchParams('cnpj=1'))).toEqual([])
    expect(normaliseUf('xx')).toBeNull()
  })
})

describe('ufSummary — the strings Sci approved on 2026-10-09', () => {
  it('none is Todo o Brasil', () => {
    expect(ufSummary([])).toBe(messages.radar.ufAll)
    expect(ufSummary(UF_CODES)).toBe(messages.radar.ufAll)
  })

  it('one is its name and code', () => {
    expect(ufSummary(['SP'])).toBe('São Paulo (SP)')
  })

  it('exactly one whole region is the region', () => {
    expect(ufSummary(['SP', 'RJ', 'MG', 'ES'])).toBe('Sudeste')
    expect(ufSummary(['PR', 'SC', 'RS'])).toBe('Sul')
    for (const region of UF_REGIONS) {
      expect(ufSummary(region.ufs)).toBe(messages.radar.ufRegions[region.id])
    }
  })

  it('two or three are listed with "e"', () => {
    expect(ufSummary(['SP', 'RJ'])).toBe('RJ e SP')
    expect(ufSummary(['SP', 'RJ', 'MG'])).toBe('MG, RJ e SP')
  })

  it('four or more name three and count the rest', () => {
    expect(ufSummary(['SP', 'RJ', 'MG', 'BA', 'PE'])).toBe('BA, MG, PE e mais 2')
  })

  it('a region plus one more is a list, not the region', () => {
    expect(ufSummary(['PR', 'SC', 'RS', 'SP'])).toBe('PR, RS, SC e mais 1')
  })

  it('every UF is in exactly one region', () => {
    const all = UF_REGIONS.flatMap((region) => [...region.ufs])
    expect(new Set(all).size).toBe(all.length)
    expect([...all].sort()).toEqual([...UF_CODES].sort())
  })
})
