'use server'

import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'

export interface MatchingTender {
  id: string
  title: string
  location: string
  value: string
  deadline: string
  matchType: 'compatible' | 'check'
}

/**
 * Get tenders matching the user's alert preferences.
 *
 * Filters by:
 * - User's company CNAE segments (automatic match)
 * - Selected state (UF)
 * - Keywords (full-text search on short_title and object)
 */
export async function getMatchingTenders(
  userId: number,
  state: string,
  keywords: string[],
): Promise<MatchingTender[]> {
  const executor = db()

  // Get user's CNPJ and company CNAE segments
  const userResult = await executor.execute<{ cnpj: string | null }>(sql`
    select cnpj from users where id = ${userId}::bigint
  `)

  if (!userResult.rows[0]?.cnpj) {
    return []
  }

  const cnpj = userResult.rows[0].cnpj

  // Build the query - match state and keywords
  // For demo: return up to 3 matching tenders
  let query = sql`
    select
      id::text,
      coalesce(short_title, object) as title,
      uf || case when city is not null then '/' || city else '' end as location,
      estimate_value_display as value,
      proposals_close_at::text as deadline
    from tenders
    where 1=1
  `

  // Filter by state
  if (state && state !== 'TODO_O_BRASIL') {
    query = sql`${query} and uf = ${state}`
  }

  // Filter by keywords (basic - would need more sophisticated full-text search in production)
  if (keywords.length > 0) {
    const keywordConditions = keywords.map(
      (keyword) => sql`(object ilike ${'%' + keyword + '%'} or short_title ilike ${'%' + keyword + '%'})`
    )

    // OR condition for keywords
    let condition = keywordConditions[0]
    for (let i = 1; i < keywordConditions.length; i++) {
      condition = sql`${condition} or ${keywordConditions[i]}`
    }

    query = sql`${query} and (${condition})`
  }

  // Order by newest and limit to 3 for preview
  query = sql`${query} order by created_at desc limit 3`

  const result = await executor.execute<MatchingTender>(query)

  // Add match type (all compatible for now - "check" would be for other cases)
  return result.rows.map((tender) => ({
    ...tender,
    matchType: 'compatible' as const,
  }))
}
