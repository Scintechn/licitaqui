import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'

/**
 * Check if a user has completed their profile for checkout.
 *
 * A complete profile requires:
 * - CNPJ (company selection)
 * - WhatsApp/Mobile number
 *
 * Returns true if both are set, false otherwise.
 */
export async function isProfileComplete(
  userId: string | number,
  executor?: Executor
): Promise<boolean> {
  try {
    const database = executor ?? db()
    const result = await database.execute<{
      cnpj: string | null
      whatsapp: string | null
    }>(sql`
      select cnpj, whatsapp from users where id = ${String(userId)}::bigint
    `)

    const row = result.rows[0]
    if (!row) return false

    // Both cnpj and whatsapp must be set and non-empty
    const hasCnpj = Boolean(row.cnpj?.trim())
    const hasWhatsapp = Boolean(row.whatsapp?.trim())

    return hasCnpj && hasWhatsapp
  } catch {
    // If the query fails, default to incomplete profile
    // This is safer than redirecting to checkout with a bad database state
    return false
  }
}

/**
 * Check if a user is newly created by comparing their created_at to now().
 *
 * A user is considered "new" if they were created within the last minute.
 * This provides a reasonable window for the redirect callback to identify
 * users who just signed up.
 */
export async function isNewUser(
  userId: string | number,
  executor?: Executor
): Promise<boolean> {
  try {
    const database = executor ?? db()
    const result = await database.execute<{ created_at: string }>(sql`
      select created_at from users where id = ${String(userId)}::bigint
    `)

    const row = result.rows[0]
    if (!row) return false

    const createdAt = new Date(row.created_at).getTime()
    const now = Date.now()
    const oneMinuteMs = 60 * 1000

    // User is new if created within the last minute
    return now - createdAt < oneMinuteMs
  } catch {
    // If query fails, assume not new (safer default)
    return false
  }
}
