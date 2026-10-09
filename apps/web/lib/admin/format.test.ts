import { describe, expect, it } from 'vitest'
import { formatCnpj, formatWhatsapp } from './founders'
import { gateMet, type Gate, type GateReading } from './gates'
import { ALERT_AT, formatBytes, formatPercent } from './neon'

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
  it('uses the decimal units Neon prices a GB in', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(999)).toBe('999 B')
    expect(formatBytes(1_500)).toBe('1,50 kB')
    expect(formatBytes(412_500_000)).toBe('412,5 MB')
    expect(formatBytes(500_000_000)).toBe('500,0 MB')
    expect(formatBytes(1_690_000_000)).toBe('1,69 GB')
  })
})

describe('formatPercent', () => {
  it('rounds to a whole percent', () => {
    expect(formatPercent(0)).toBe('0%')
    expect(formatPercent(ALERT_AT)).toBe('80%')
    expect(formatPercent(1.234)).toBe('123%')
  })
})

// The Free-plan constants this file used to pin are gone: the project is on
// Launch, which has no such ceilings. What replaced them lives in
// `neon.test.tsx`, and it asserts a shape rather than a number — a metric
// with no ceiling must not produce a ratio. See card B27.

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

  it('has no verdict on a gate with no target, and does not call it met', () => {
    // `target: null` is a card reporting a number nobody set a bar for
    // (`cnpj_search_count`). `true` would accent it and badge it as passed;
    // `false` would badge it as failing. Neither is a fact about it.
    const none = gate({ state: 'counted', value: 9_000 }, { target: null })
    expect(gateMet(none)).toBeNull()
    expect(gateMet(gate({ state: 'counted', value: 0 }, { target: null }))).toBeNull()
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
