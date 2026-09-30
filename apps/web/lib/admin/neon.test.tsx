import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UsageCard } from '@/app/admin/usage-card'
import {
  ALERT_AT,
  boundedMetric,
  formatBytes,
  formatUsd,
  LAUNCH_STORAGE_USD_PER_GB_MONTH,
  neonApiConfigured,
  PLAN_NAME,
  readNeonUsage,
  storageCostUsd,
  unboundedMetric,
  type NeonUsage,
} from './neon'

/**
 * The Neon usage card — card **B27**.
 *
 * ## The defect these are written against
 *
 * This card was built for the **Free** plan and the project is on **Launch**.
 * With `FREE_STORAGE_BYTES = 500_000_000` and a database at 1,69 GB it would
 * have rendered **338% and a red alert** on a database in no danger — a false
 * alarm on the one screen whose purpose is warning before Neon stops the
 * database.
 *
 * The first attempt at a fix was to swap the constant for Launch's "10 GB".
 * **Launch has no such number**: it removes Free's limits and prices storage
 * per GB-month. That fix would have hardcoded a second fiction, which is why
 * the assertions below are about the *shape* of the answer — a metric without
 * a ceiling must not produce a ratio — and not about any particular limit.
 */

const size = 1_690_000_000

function usage(overrides: Partial<NeonUsage> = {}): NeonUsage {
  return {
    databaseSize: unboundedMetric(size),
    storageUsdPerMonth: storageCostUsd(size),
    projectStorage: { state: 'pending', limit: null, writtenBy: 'neon_consumption (B27)' },
    computeHours: { state: 'pending', limit: null, writtenBy: 'neon_consumption (B27)' },
    plan: PLAN_NAME,
    ...overrides,
  }
}

describe('a metric with no ceiling', () => {
  it('has no ratio and cannot alert, however large it is', () => {
    // 1,69 GB is 338% of the old Free constant. Under Launch it is just 1,69 GB.
    const metric = unboundedMetric(size)
    expect(metric.limit).toBeNull()
    expect(metric.ratio).toBeNull()
    expect(metric.alert).toBe(false)
  })

  it('still alerts when a ceiling genuinely exists', () => {
    // The shape is kept rather than deleted: a future metric that *does* have
    // a limit must still warn before the line, not at it.
    expect(boundedMetric(80, 100).alert).toBe(true)
    expect(boundedMetric(79, 100).alert).toBe(false)
    expect(ALERT_AT).toBe(0.8)
  })
})

describe('storage cost', () => {
  it('is arithmetic on the published rate, not an estimate', () => {
    expect(LAUNCH_STORAGE_USD_PER_GB_MONTH).toBe(0.35)
    expect(storageCostUsd(1_000_000_000)).toBeCloseTo(0.35, 10)
    expect(storageCostUsd(size)).toBeCloseTo(0.5915, 4)
    expect(storageCostUsd(0)).toBe(0)
  })

  it('formats in the currency Neon bills in', () => {
    expect(formatUsd(0.5915)).toBe('US$ 0,59')
    expect(formatUsd(7.86)).toBe('US$ 7,86')
  })
})

describe('neonApiConfigured', () => {
  it('needs both variables, and ignores whitespace', () => {
    expect(neonApiConfigured({ NEON_API_KEY: 'k', NEON_PROJECT_ID: 'p' })).toBe(true)
    expect(neonApiConfigured({ NEON_API_KEY: 'k' })).toBe(false)
    expect(neonApiConfigured({ NEON_API_KEY: '  ', NEON_PROJECT_ID: 'p' })).toBe(false)
    expect(neonApiConfigured({})).toBe(false)
  })
})

describe('readNeonUsage tells apart "no credentials" from "nothing written yet"', () => {
  // The bug: `readNeonUsage` returned `not_configured` unconditionally and
  // never called its own `neonApiConfigured()`, so the card said the
  // credentials were missing while both sat in the environment. Two different
  // problems needing two different fixes from whoever is reading the screen.
  const database = { execute: async () => ({ rows: [{ bytes: String(size) }] }) } as never

  it('says not_configured only when a variable is actually absent', async () => {
    const read = await readNeonUsage(database, {})
    expect(read.projectStorage.state).toBe('not_configured')
  })

  it('says pending when both are set', async () => {
    const read = await readNeonUsage(database, { NEON_API_KEY: 'k', NEON_PROJECT_ID: 'p' })
    expect(read.projectStorage.state).toBe('pending')
    expect(read.computeHours.state).toBe('pending')
  })

  it('measures the size without a ceiling, and prices it', async () => {
    const read = await readNeonUsage(database, {})
    expect(read.databaseSize).toMatchObject({ state: 'measured', value: size, limit: null })
    expect(read.storageUsdPerMonth).toBeCloseTo(0.5915, 4)
    expect(read.plan).toBe(PLAN_NAME)
  })
})

describe('the rendered card', () => {
  // Rendered, not inspected as props. The defect was something a person would
  // have *seen* — a red 338% — and every unit test passed while it was there.
  it('never prints a percentage or an alert for a metric with no ceiling', () => {
    const html = renderToStaticMarkup(<UsageCard usage={usage()} />)

    expect(html).toContain(formatBytes(size))
    expect(html).not.toMatch(/\d+%/)
    expect(html).not.toContain('80% do limite')
    // The bar is a ratio drawn: no ratio, no bar.
    expect(html).not.toContain('style="width:')
  })

  it('names the plan it is reading against, so it cannot silently describe another', () => {
    expect(renderToStaticMarkup(<UsageCard usage={usage()} />)).toContain(PLAN_NAME)
    expect(renderToStaticMarkup(<UsageCard usage={usage()} />)).not.toContain('Free')
  })

  it('shows what the storage actually costs', () => {
    expect(renderToStaticMarkup(<UsageCard usage={usage()} />)).toContain('US$ 0,59')
  })

  it('distinguishes the two API states in words a reader can act on', () => {
    const pending = renderToStaticMarkup(<UsageCard usage={usage()} />)
    expect(pending).toContain('Credenciais configuradas')

    const missing = renderToStaticMarkup(
      <UsageCard
        usage={usage({
          projectStorage: {
            state: 'not_configured',
            limit: null,
            missing: ['NEON_API_KEY', 'NEON_PROJECT_ID'],
          },
        })}
      />,
    )
    expect(missing).toContain('NEON_API_KEY')
  })

  it('still draws the bar and the alert when a ceiling is real', () => {
    const html = renderToStaticMarkup(
      <UsageCard usage={usage({ databaseSize: boundedMetric(90, 100) })} />,
    )
    expect(html).toContain('90%')
    expect(html).toContain('80% do limite')
  })
})
