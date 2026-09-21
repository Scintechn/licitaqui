import { describe, expect, it } from 'vitest'
import { deadlineLabel } from '@/app/radar/tender-card'
import { TENDER_GROUPS } from './contract'
import { money } from './format'
import {
  EXAMPLE_AS_OF,
  EXAMPLE_NOW,
  EXAMPLE_TENDERS,
  exampleCounts,
} from './landing-example'

/**
 * The Landing's example panel makes factual claims about three real tenders.
 * These tests pin the claims to the answer keys the POCs checked by hand on
 * 16/09/2026 (`gabaritos/`), so a later edit cannot quietly change what the
 * page tells a visitor a tender was worth.
 */
describe('the Landing example tenders', () => {
  it('is one tender per Radar group, in the board’s order', () => {
    expect(EXAMPLE_TENDERS.map((tender) => tender.group)).toEqual([...TENDER_GROUPS])
    expect(exampleCounts()).toEqual({ compatible: 1, check: 1, keyword: 1 })
  })

  it('carries the PNCP control number of each real tender', () => {
    expect(EXAMPLE_TENDERS.map((tender) => tender.id)).toEqual([
      '51885242000140-1-000744/2026',
      '47018676000176-1-000383/2026',
      '45781176000166-1-000804/2026',
    ])
  })

  it('states the values the answer keys record', () => {
    const [batteries, hospital, saas] = EXAMPLE_TENDERS
    expect(batteries.estimatedValue).toBe('48196.00')
    expect(batteries.itemCount).toBe(7)
    expect(batteries.meEppSummary).toBe('exclusive')

    expect(hospital.estimatedValue).toBe('1249376.49')
    expect(hospital.itemCount).toBe(20)
    expect(hospital.meEppSummary).toBe('mixed')

    expect(saas.estimatedValue).toBe('4330766.67')
    expect(saas.favoredTreatment).toBe(true)
  })

  it('renders the money the way the board writes it', () => {
    expect(money(EXAMPLE_TENDERS[0].estimatedValue)).toBe('R$ 48.196')
    expect(money(EXAMPLE_TENDERS[1].estimatedValue)).toBe('R$ 1,25 mi')
    expect(money(EXAMPLE_TENDERS[2].estimatedValue)).toBe('R$ 4,33 mi')
  })

  /**
   * The whole point of freezing the clock: the panel reads "13 dias" — the
   * board's number — today and in two years, instead of counting down to a
   * deadline in the past and telling a visitor an old tender is still open.
   */
  it('counts every deadline from the frozen date, not from today', () => {
    for (const tender of EXAMPLE_TENDERS) {
      expect(deadlineLabel(tender.proposalsCloseAt, EXAMPLE_NOW)).toBe('13 dias')
    }
    expect(EXAMPLE_AS_OF).toBe('17/09/2026')
  })

  it('is stated as of a date that is in the past, and says so', () => {
    expect(EXAMPLE_NOW.getTime()).toBeLessThan(Date.now() + 86_400_000)
    for (const tender of EXAMPLE_TENDERS) {
      expect(tender.proposalsCloseAt).toMatch(/^2026-09-30T/)
    }
  })
})
