import { describe, expect, it } from 'vitest'
import { type AlertLimits, clampPreferences, MAX_KEYWORD_CHARS, NO_LIMITS } from './quota'

/**
 * §8: "quota checks: always server-side". The screen renders one state select
 * and one keyword field because `plan_limits` says so; this is the same numbers
 * applied to whatever actually arrives in the POST.
 */

const BASICO: AlertLimits = { perWeek: 1, keywords: 1, states: 1 }

describe('clamping a submission to the plan', () => {
  it('keeps one state on Básico, however many were sent', () => {
    const out = clampPreferences({ states: ['SP', 'RJ', 'MG'], keyword: null }, BASICO)
    expect(out.states).toEqual(['SP'])
  })

  it('keeps one keyword on Básico', () => {
    const out = clampPreferences({ states: [], keyword: '  material hospitalar ' }, BASICO)
    expect(out.keyword).toBe('material hospitalar')
  })

  it('normalises and de-duplicates the states', () => {
    const out = clampPreferences(
      { states: ['sp', 'SP', ' rj '], keyword: null },
      { ...BASICO, states: 5 },
    )
    expect(out.states).toEqual(['SP', 'RJ'])
  })

  it.each([['', 'Brasil'], ['S', 'S'], ['SPX', 'SPX'], ['1!', '1!']])(
    'drops %s, which is not a UF',
    (value) => {
      expect(clampPreferences({ states: [value], keyword: null }, NO_LIMITS).states).toEqual([])
    },
  )

  it('turns an empty keyword into null rather than an empty string', () => {
    expect(clampPreferences({ states: [], keyword: '   ' }, BASICO).keyword).toBeNull()
  })

  it('truncates a pasted keyword', () => {
    const out = clampPreferences({ states: [], keyword: 'x'.repeat(500) }, BASICO)
    expect(out.keyword).toHaveLength(MAX_KEYWORD_CHARS)
  })

  it('drops the keyword entirely for a plan whose limit is zero', () => {
    const out = clampPreferences({ states: ['SP'], keyword: 'papel' }, { ...BASICO, keywords: 0 })
    expect(out.keyword).toBeNull()
    expect(out.states).toEqual(['SP'])
  })

  it('leaves everything alone when the plan has no caps recorded', () => {
    const out = clampPreferences({ states: ['SP', 'RJ', 'MG'], keyword: 'papel' }, NO_LIMITS)
    expect(out.states).toEqual(['SP', 'RJ', 'MG'])
    expect(out.keyword).toBe('papel')
  })
})
