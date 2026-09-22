import { describe, expect, it } from 'vitest'
import { bestGroup, everyGroupEmpty, otherPopulatedGroup, readGroup } from './group'

/**
 * The counts below are real: they come from `/api/radar/tenders` on production
 * for CNPJ 36955612000185, and each one is a query Sci could type today.
 */
const PAVING = { compatible: 0, check: 0, keyword: 36 } // q=pavimentação asfáltica
const BEEF = { compatible: 0, check: 11, keyword: 43 } // q=carne bovina
const XYLOPHONE = { compatible: 0, check: 1, keyword: 0 } // q=xilofone
const NO_KEYWORD = { compatible: 140, check: 352, keyword: 0 } // the CNPJ alone
const NOTHING = { compatible: 0, check: 0, keyword: 0 }

describe('readGroup', () => {
  it('reads the three groups the contract has', () => {
    expect(readGroup('compatible')).toBe('compatible')
    expect(readGroup('check')).toBe('check')
    expect(readGroup('keyword')).toBe('keyword')
  })

  it('answers null — not "compatible" — for absent or nonsense', () => {
    // This single line is the bug: returning 'compatible' here made "nothing
    // chosen" indistinguishable from "Compatíveis, chosen", so the screen
    // could not open a populated tab without also overriding a real choice.
    expect(readGroup(null)).toBeNull()
    expect(readGroup('')).toBeNull()
    expect(readGroup('Compatible')).toBeNull()
    expect(readGroup('todos')).toBeNull()
  })
})

describe('bestGroup', () => {
  it('keeps compatible first whenever it has anything at all', () => {
    expect(bestGroup(NO_KEYWORD)).toBe('compatible')
    expect(bestGroup({ compatible: 1, check: 999, keyword: 999 })).toBe('compatible')
  })

  it('opens the populated tab when compatible is empty', () => {
    expect(bestGroup(PAVING)).toBe('keyword')
    expect(bestGroup(BEEF)).toBe('check')
    expect(bestGroup(XYLOPHONE)).toBe('check')
  })

  it('falls back to compatible when everything is empty, and when it knows nothing', () => {
    expect(bestGroup(NOTHING)).toBe('compatible')
    expect(bestGroup(null)).toBe('compatible')
  })
})

describe('everyGroupEmpty', () => {
  it('separates "this tab is empty" from "there is nothing anywhere"', () => {
    expect(everyGroupEmpty(NOTHING)).toBe(true)
    expect(everyGroupEmpty(PAVING)).toBe(false)
    expect(everyGroupEmpty(XYLOPHONE)).toBe(false)
  })

  it('is false while the counts are unknown: nothing is not the same as not yet', () => {
    expect(everyGroupEmpty(null)).toBe(false)
  })
})

describe('otherPopulatedGroup', () => {
  it('finds the tab to send someone to from an empty one', () => {
    expect(otherPopulatedGroup(PAVING, 'compatible')).toBe('keyword')
    expect(otherPopulatedGroup(BEEF, 'compatible')).toBe('check')
  })

  it('never points at the tab you are already on', () => {
    expect(otherPopulatedGroup(NO_KEYWORD, 'compatible')).toBe('check')
    expect(otherPopulatedGroup({ compatible: 0, check: 0, keyword: 5 }, 'keyword')).toBeNull()
  })

  it('has nothing to offer when the other tabs are empty too', () => {
    expect(otherPopulatedGroup(NOTHING, 'compatible')).toBeNull()
    expect(otherPopulatedGroup(null, 'compatible')).toBeNull()
  })
})
