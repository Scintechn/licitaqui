import { describe, expect, it } from 'vitest'
import { formatCnpj, formatWhatsapp } from './founders'
import { gateMet, type Gate, type GateReading } from './gates'
import { ALERT_AT, FREE_COMPUTE_HOURS, FREE_STORAGE_BYTES, formatBytes, formatPercent } from './neon'

describe('formatCnpj', () => {
  it('punctuates the 14 digits the way a Brazilian reads them', () => {
    expect(formatCnpj('00394429000100')).toBe('00.394.429/0001-00')
  })

  it('hands back anything that is not 14 digits rather than mangling it', () => {
    expect(formatCnpj('123')).toBe('123')
    expect(formatCnpj(null)).toBeNull()
  })
})

describe('formatWhatsapp', () => {
  it('reads E.164 back into the Brazilian shape', () => {
    expect(formatWhatsapp('+5511999998888')).toBe('+55 (11) 99999-8888')
    expect(formatWhatsapp('+551133334444')).toBe('+55 (11) 3333-4444')
  })

  it('leaves a number it does not recognise alone', () => {
    expect(formatWhatsapp('+1 202 555 0100')).toBe('+1 202 555 0100')
    expect(formatWhatsapp(null)).toBeNull()
  })
})

describe('formatBytes', () => {
  it('uses the same decimal units the Free limit is read in', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1_500)).toBe('1,50 kB')
    expect(formatBytes(412_500_000)).toBe('412,5 MB')
    expect(formatBytes(FREE_STORAGE_BYTES)).toBe('500,0 MB')
  })
})

describe('formatPercent', () => {
  it('rounds to a whole percent', () => {
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(ALERT_AT)).toBe('80%')
    expect(formatPercent(1.234)).toBe('123%')
  })
})

describe('the Free plan limits are the ones in spec §5.1', () => {
  it('reads 0.5 GB as the smaller of the two readings, so the alert is early', () => {
    expect(FREE_STORAGE_BYTES).toBe(500_000_000)
    expect(FREE_STORAGE_BYTES).toBeLessThan(0.5 * 1024 ** 3)
    expect(FREE_COMPUTE_HOURS).toBe(100)
    expect(ALERT_AT).toBe(0.8)
  })
})

describe('gateMet', () => {
  const gate = (reading: GateReading, overrides: Partial<Gate> = {}): Gate => ({
    key: 'founders_signed_up',
    label: 'x',
    target: 150,
    unit: 'count',
    source: 'x',
    reading,
    ...overrides,
  })

  it('compares a count with its target', () => {
    expect(gateMet(gate({ state: 'counted', value: 149 }))).toBe(false)
    expect(gateMet(gate({ state: 'counted', value: 150 }))).toBe(true)
  })

  it('compares a rate with its target', () => {
    const rate = (percent: number) =>
      gate({ state: 'rate', percent, opened: 1, sent: 2 }, { target: 50, unit: 'percent' })
    expect(gateMet(rate(49.9))).toBe(false)
    expect(gateMet(rate(50))).toBe(true)
  })

  it('says "unknown", not "not met", when there is nothing to compare', () => {
    expect(gateMet(gate({ state: 'no_source', note: 'x' }))).toBeNull()
    expect(gateMet(gate({ state: 'no_data', note: 'x' }))).toBeNull()
    expect(gateMet(gate({ state: 'error', reason: '42P01' }))).toBeNull()
  })
})
