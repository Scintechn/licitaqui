import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
import type { Alert } from './types'

export async function readUserAlerts(userId: number, executor = db()): Promise<Alert[]> {
  const result = await executor.execute<{
    id: number
    user_id: number
    kind: string | null
    keywords: string[]
    states: string[]
    channel: string
    frequency: string
    active: boolean
  }>(sql`
    select id, user_id, kind, keywords, states, channel, frequency, active
    from alerts
    where user_id = ${userId}::bigint
    order by active desc, id desc
  `)

  return result.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    kind: (row.kind as 'keyword' | 'cnae' | null) ?? null,
    keywords: row.keywords ?? [],
    states: row.states ?? [],
    channel: row.channel,
    frequency: (row.frequency as 'daily' | 'weekly' | 'telegram') ?? 'weekly',
    active: row.active,
  }))
}
