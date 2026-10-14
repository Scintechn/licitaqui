import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { isJustCreated } from './first-time-user'

describe('isJustCreated', () => {
  let fakeNow: number

  beforeEach(() => {
    // Mock Date.now()
    fakeNow = new Date('2026-10-14T12:00:00Z').getTime()
    vi.useFakeTimers()
    vi.setSystemTime(fakeNow)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns true if account was created within the last 5 minutes', () => {
    const createdAt = new Date(fakeNow - 2 * 60 * 1000) // 2 minutes ago
    expect(isJustCreated(createdAt)).toBe(true)
  })

  it('returns true if account was just created', () => {
    const createdAt = new Date(fakeNow - 1000) // 1 second ago
    expect(isJustCreated(createdAt)).toBe(true)
  })

  it('returns false if account was created more than 5 minutes ago', () => {
    const createdAt = new Date(fakeNow - 6 * 60 * 1000) // 6 minutes ago
    expect(isJustCreated(createdAt)).toBe(false)
  })

  it('returns false if account was created at the 5-minute boundary (exclusive)', () => {
    const createdAt = new Date(fakeNow - 5 * 60 * 1000) // exactly 5 minutes ago
    expect(isJustCreated(createdAt)).toBe(false)
  })

  it('returns false for future dates', () => {
    const createdAt = new Date(fakeNow + 1000) // 1 second in the future
    expect(isJustCreated(createdAt)).toBe(false)
  })

  it('handles string timestamps', () => {
    const createdAtString = new Date(fakeNow - 2 * 60 * 1000).toISOString()
    expect(isJustCreated(createdAtString)).toBe(true)
  })

  it('returns false for old string timestamps', () => {
    const createdAtString = new Date(fakeNow - 10 * 60 * 1000).toISOString()
    expect(isJustCreated(createdAtString)).toBe(false)
  })
})
