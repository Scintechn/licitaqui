import { describe, expect, it } from 'vitest'
import {
  type AlertLimits,
  clampPreferences,
  keywordFields,
  MAX_KEYWORD_CHARS,
  NO_LIMITS,
  UNCAPPED_KEYWORD_FIELDS,
} from './quota'

/**
 * §8: "quota checks: always server-side". The screen renders one state select
 * and one keyword field because `plan_limits` says so; this is the same numbers
 * applied to whatever actually arrives in the POST.
 */

const BASICO: AlertLimits = { perWeek: 1, keywords: 1, states: 1 }

describe('clamping a submission to the plan', () => {
  it('keeps one state on Básico, however many were sent', () => {
    const out = clampPreferences({ states: ['SP', 'RJ', 'MG'], keywords: [] }, BASICO)
    expect(out.states).toEqual(['SP'])
  })

  it('keeps one keyword on Básico', () => {
    const out = clampPreferences({ states: [], keywords: ['  material hospitalar '] }, BASICO)
    expect(out.keywords).toEqual(['material hospitalar'])
  })

  it('keeps ten on Essencial, which is the whole of E18', () => {
    // `plan_limits` has granted `essencial` ten since `0002_plan_limits`. The
    // product delivered one, because `clampPreferences` read the count as a
    // boolean — `keyword && limits.keywords !== 0` — so Essencial's alert was
    // identical to Básico's. Sci found it on his own account.
    const ten = Array.from({ length: 12 }, (_unused, index) => `palavra ${index}`)
    const out = clampPreferences({ states: [], keywords: ten }, { ...BASICO, keywords: 10 })
    expect(out.keywords).toHaveLength(10)
    expect(out.keywords[0]).toBe('palavra 0')
    expect(out.keywords).not.toContain('palavra 10')
  })

  it('drops blanks and duplicates rather than storing them', () => {
    // An empty keyword reaches `websearch_to_tsquery`, which accepts it and
    // matches every open tender in Brazil — the portal this product replaces.
    // `alerts_keywords_check` (migration 0010) refuses them at the column too.
    // Ten fields with one word typed twice is nine keywords and a wasted slot.
    const out = clampPreferences(
      { states: [], keywords: ['papel', '   ', 'papel', '', 'toner'] },
      { ...BASICO, keywords: 10 },
    )
    expect(out.keywords).toEqual(['papel', 'toner'])
  })

  it('caps an uncapped plan at a form that ends', () => {
    const out = clampPreferences(
      { states: [], keywords: ['a', 'b', 'c'] },
      { ...BASICO, keywords: null },
    )
    expect(out.keywords).toEqual(['a', 'b', 'c'])
  })

  it('normalises and de-duplicates the states', () => {
    const out = clampPreferences(
      { states: ['sp', 'SP', ' rj '], keywords: [] },
      { ...BASICO, states: 5 },
    )
    expect(out.states).toEqual(['SP', 'RJ'])
  })

  it.each([['', 'Brasil'], ['S', 'S'], ['SPX', 'SPX'], ['1!', '1!']])(
    'drops %s, which is not a UF',
    (value) => {
      expect(clampPreferences({ states: [value], keywords: [] }, NO_LIMITS).states).toEqual([])
    },
  )

  it('drops a blank keyword rather than storing an empty string', () => {
    expect(clampPreferences({ states: [], keywords: ['   '] }, BASICO).keywords).toEqual([])
  })

  it('truncates a pasted keyword', () => {
    const out = clampPreferences({ states: [], keywords: ['x'.repeat(500)] }, BASICO)
    expect(out.keywords[0]).toHaveLength(MAX_KEYWORD_CHARS)
  })

  it('drops every keyword for a plan whose limit is zero', () => {
    const out = clampPreferences(
      { states: ['SP'], keywords: ['papel', 'toner'] },
      { ...BASICO, keywords: 0 },
    )
    expect(out.keywords).toEqual([])
    expect(out.states).toEqual(['SP'])
  })

  it('leaves everything alone when the plan has no caps recorded', () => {
    const out = clampPreferences(
      { states: ['SP', 'RJ', 'MG'], keywords: ['papel', 'toner'] },
      NO_LIMITS,
    )
    expect(out.states).toEqual(['SP', 'RJ', 'MG'])
    expect(out.keywords).toEqual(['papel', 'toner'])
  })
})

describe('keywordFields — the form offers what the plan grants', () => {
  /**
   * **The guard that did not exist.** `alerts-view.tsx` drew exactly one
   * keyword field on every plan while `plan_limits` granted Essencial ten, and
   * nothing compared the two — so Essencial's alert was identical to Básico's
   * and *"10 palavras-chave"* on the plans card was false. D6 passed over the
   * same sentence and did not see it; Sci found it by using his own account.
   *
   * The general form of this check is card **F6**.
   */
  it.each([
    [1, 1],
    [10, 10],
    [0, 0],
  ])('grants %s, offers %s fields', (limit, expected) => {
    expect(keywordFields(limit)).toHaveLength(expected)
  })

  it('ends the form even for an uncapped plan', () => {
    // `null` is uncapped, and an unbounded form is not a screen.
    expect(keywordFields(null)).toHaveLength(UNCAPPED_KEYWORD_FIELDS)
  })

  it('never offers more fields than clampPreferences will keep', () => {
    // The two halves of the same rule. If the form ever offers more than the
    // clamp keeps, a person types into a box whose contents are discarded on
    // save without a word — which is how a wrong number stays invisible.
    for (const limit of [0, 1, 3, 10, null]) {
      const fields = keywordFields(limit)
      const typed = fields.map((index) => `palavra ${index}`)
      const kept = clampPreferences({ states: [], keywords: typed }, { ...BASICO, keywords: limit })
      expect(kept.keywords).toHaveLength(fields.length)
    }
  })
})
