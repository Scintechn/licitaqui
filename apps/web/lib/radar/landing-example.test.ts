import { describe, expect, it } from 'vitest'
import { TENDER_GROUPS } from './contract'
import { money } from './format'
import { EXAMPLE_AS_OF, EXAMPLE_TENDERS, exampleCounts } from './landing-example'

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
   * The example is dated, and the date has to make sense: three tenders
   * *receiving proposals* as of 17/09/2026 cannot have closed before it.
   *
   * Note what this does **not** assert: that the deadlines are still ahead of
   * today. They are not, from 01/10/2026, and that is honest — the caption says
   * which day these were transcribed. What must never happen is the panel
   * putting urgency copy over one of them, which is a property of the *render*
   * and is pinned in `app/(public)/example-radar.test.tsx` at five clocks,
   * including 2030.
   */
  it('closes after the date the caption says it was taken', () => {
    const [day, month, year] = EXAMPLE_AS_OF.split('/').map(Number)
    // 23:59:59 Brasília on the as-of day, as an instant: the latest moment the
    // transcription could have been made.
    const asOf = Date.parse(
      `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T23:59:59-03:00`,
    )
    expect(EXAMPLE_AS_OF).toBe('17/09/2026')
    for (const tender of EXAMPLE_TENDERS) {
      expect(tender.proposalsCloseAt).toMatch(/^2026-09-30T/)
      expect(Date.parse(tender.proposalsCloseAt ?? '')).toBeGreaterThan(asOf)
    }
  })

  /**
   * **There is no clock in this file, and there must not be one again.**
   *
   * `EXAMPLE_NOW` was a `Date` frozen at 17/09/2026 that the panel measured its
   * countdowns against, which is how three passed deadlines came to sit under
   * "13 dias" (card D11). A duration is a claim about *now*; this module states
   * facts about three editais. Re-introducing an instant here under any name —
   * and every date-shaped export is one — fails this.
   */
  it('exports facts, never an instant', async () => {
    const exported = await import('./landing-example')
    for (const [name, value] of Object.entries(exported)) {
      expect(value, `${name} is a Date: the panel's clock is the real one`).not.toBeInstanceOf(Date)
    }
  })
})
