import { describe, it, expect } from 'vitest'
import type { Executor } from '@/lib/db'
import { isProfileComplete, isNewUser } from './profile-check'

/**
 * Mock executor for testing.
 * Simulates database responses.
 */
function createMockExecutor(data: Record<string, unknown>): Executor {
  return {
    execute: async () => ({
      rows: [data],
      rowCount: 1,
      command: 'SELECT',
    }),
  } as unknown as Executor
}

describe('profile-check', () => {
  describe('isProfileComplete', () => {
    it('returns true when both cnpj and whatsapp are set', async () => {
      const executor = createMockExecutor({
        cnpj: '12345678000195',
        whatsapp: '11999999999',
      })

      const result = await isProfileComplete('123', executor)
      expect(result).toBe(true)
    })

    it('returns false when cnpj is missing', async () => {
      const executor = createMockExecutor({
        cnpj: null,
        whatsapp: '11999999999',
      })

      const result = await isProfileComplete('123', executor)
      expect(result).toBe(false)
    })

    it('returns false when whatsapp is missing', async () => {
      const executor = createMockExecutor({
        cnpj: '12345678000195',
        whatsapp: null,
      })

      const result = await isProfileComplete('123', executor)
      expect(result).toBe(false)
    })

    it('returns false when both are missing', async () => {
      const executor = createMockExecutor({
        cnpj: null,
        whatsapp: null,
      })

      const result = await isProfileComplete('123', executor)
      expect(result).toBe(false)
    })

    it('returns false when cnpj or whatsapp are empty strings', async () => {
      const executor = createMockExecutor({
        cnpj: '  ',
        whatsapp: '11999999999',
      })

      const result = await isProfileComplete('123', executor)
      expect(result).toBe(false)
    })

    it('returns false when user not found', async () => {
      const executor = {
        execute: async () => ({
          rows: [],
          rowCount: 0,
          command: 'SELECT',
        }),
      } as unknown as Executor

      const result = await isProfileComplete('999', executor)
      expect(result).toBe(false)
    })

    it('returns false on database error', async () => {
      const executor = {
        execute: async () => {
          throw new Error('Database error')
        },
      } as unknown as Executor

      const result = await isProfileComplete('123', executor)
      expect(result).toBe(false)
    })
  })

  describe('isNewUser', () => {
    it('returns true when user created within last minute', async () => {
      const now = new Date()
      const thirtySecondsAgo = new Date(now.getTime() - 30 * 1000)

      const executor = createMockExecutor({
        created_at: thirtySecondsAgo.toISOString(),
      })

      const result = await isNewUser('123', executor)
      expect(result).toBe(true)
    })

    it('returns false when user created more than a minute ago', async () => {
      const now = new Date()
      const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000)

      const executor = createMockExecutor({
        created_at: twoMinutesAgo.toISOString(),
      })

      const result = await isNewUser('123', executor)
      expect(result).toBe(false)
    })

    it('returns false when user not found', async () => {
      const executor = {
        execute: async () => ({
          rows: [],
          rowCount: 0,
          command: 'SELECT',
        }),
      } as unknown as Executor

      const result = await isNewUser('999', executor)
      expect(result).toBe(false)
    })

    it('returns false on database error', async () => {
      const executor = {
        execute: async () => {
          throw new Error('Database error')
        },
      } as unknown as Executor

      const result = await isNewUser('123', executor)
      expect(result).toBe(false)
    })

    it('correctly handles ISO timestamp format', async () => {
      const now = new Date()
      const fiftyNineSecondsAgo = new Date(now.getTime() - 59 * 1000)

      const executor = createMockExecutor({
        created_at: fiftyNineSecondsAgo.toISOString(),
      })

      const result = await isNewUser('123', executor)
      expect(result).toBe(true)
    })
  })
})
