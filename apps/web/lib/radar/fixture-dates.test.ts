import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The seed fixtures' open/closed split, which used to be a property of the day
 * the suite ran.
 *
 * **This is the regression test for B23.** The 20 captured PNCP payloads carry
 * absolute `dataEncerramentoProposta` values, and the database suites split
 * them on `> now()`. Seven were open when they were captured; by 2026-09-28
 * three were, four having expired that morning — which is the morning `main`
 * went red, with `radar.db.test.ts` reading past the end of `openTenders` and
 * `d3.db.test.ts` finding no open tender to count. Two more were due to expire
 * on 30/09 and 01/10, before the 08/10 opening, and CI would not have shown
 * any of it because the database suites had never run there (B22).
 *
 * No database: `loadFixtures` only reads JSON off disk. The clock is moved
 * rather than described, because "it will still work in six months" is a claim
 * about a date and the only honest way to check it is to be there.
 */

/** Re-imports `fixtures.ts` so its module-level `RUN_AT` is taken under the
 * fake clock — the value is captured once at import, on purpose, so that every
 * row in one run is re-dated against a single instant. */
async function loadAt(when: string) {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(when))
  vi.resetModules()
  const { loadFixtures } = await import('./fixtures')
  const fixtures = loadFixtures()
  const now = Date.now()
  const withDeadline = fixtures.filter((f) => f.closeAt !== null)
  return {
    total: fixtures.length,
    noDeadline: fixtures.length - withDeadline.length,
    open: withDeadline.filter((f) => Date.parse(`${f.closeAt}-03:00`) > now).length,
    closed: withDeadline.filter((f) => Date.parse(`${f.closeAt}-03:00`) <= now).length,
    fixtures,
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
})

describe('the seed fixtures keep their open/closed character', () => {
  it.each([
    ['the day they were captured', '2026-09-17T12:00:00-03:00'],
    ['the day main went red', '2026-09-28T15:35:00-03:00'],
    ['opening day', '2026-10-08T19:00:00-03:00'],
    ['six months on', '2027-03-29T09:00:00-03:00'],
    ['three years on', '2029-09-29T09:00:00-03:00'],
  ])('on %s', async (_label, when) => {
    const { total, open, closed, noDeadline } = await loadAt(when)
    expect(total).toBe(20)
    // Seven open is what the corpus held at capture, and it is what the
    // suites are written against: `radar.db.test.ts` destructures three
    // fixtures out of `openTenders.slice(2)`, so it needs five.
    expect(open).toBe(7)
    expect(closed).toBe(9)
    expect(noDeadline).toBe(4)
  })

  it('never lets a tender close before it opened', async () => {
    const { fixtures } = await loadAt('2028-01-01T00:00:00-03:00')
    for (const fixture of fixtures) {
      const openAt = fixture.det.dataAberturaProposta
      if (typeof openAt !== 'string' || fixture.closeAt === null) continue
      expect(
        Date.parse(`${openAt}-03:00`),
        `${fixture.file} opens after it closes`,
      ).toBeLessThanOrEqual(Date.parse(`${fixture.closeAt}-03:00`))
    }
  })

  it('re-dates the payload as well as the column', async () => {
    // `insertFixture` writes `raw` from `det` and `proposals_close_at` from
    // `closeAt`. If only one were shifted, a test reading the payload back
    // would disagree with the column and the disagreement would look like a
    // timezone bug — which this repo has actually had.
    const { fixtures } = await loadAt('2027-06-01T00:00:00-03:00')
    for (const fixture of fixtures) {
      expect(fixture.det.dataEncerramentoProposta).toBe(fixture.closeAt)
    }
  })

  it('preserves the interval between two fixtures', async () => {
    // A shift, not a clamp: the ordering and the gaps are what make "this one
    // closes first" meaningful in the list assertions.
    const early = await loadAt('2026-09-17T12:00:00-03:00')
    const late = await loadAt('2027-09-17T12:00:00-03:00')
    const gap = (set: typeof early) => {
      const dates = set.fixtures
        .filter((f) => f.closeAt !== null)
        .map((f) => Date.parse(`${f.closeAt}-03:00`))
        .sort((a, b) => a - b)
      return (dates.at(-1) as number) - (dates[0] as number)
    }
    expect(gap(late)).toBe(gap(early))
  })
})
