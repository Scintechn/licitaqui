import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'

/**
 * "Hoje no Brasil · [Nº] editais abertos · [Nº] exclusivos ME/EPP" — the strip
 * at the foot of canvas 01 (`Main.dc.html`).
 *
 * Two counts over `tenders`, read at build and at each revalidation: the
 * Landing is a public page and §3.3 gives public pages ISR, so this runs on
 * the server every ten minutes at most, never per visitor. It touches no
 * external API — the numbers come from the cache the worker fills.
 *
 * ## Why it may answer `null`
 *
 * `next build` runs with no `DATABASE_URL` (see `lib/db/index.ts`), and a
 * marketing figure is not worth failing a deploy over. When the count cannot
 * be taken the strip is left out of the page entirely, which is better than
 * printing "0 editais abertos" on a product whose promise is that there are
 * thousands.
 */

export type RadarStats = {
  /** Tenders still receiving proposals. */
  open: number
  /** Of those, the ones whose items are exclusive to ME/EPP, whole or in part. */
  meEpp: number
}

export async function openTenderStats(executor?: Executor): Promise<RadarStats | null> {
  try {
    const found = await (executor ?? db()).execute<{ open: string | number; me_epp: string | number }>(sql`
      select count(*) as open,
             count(*) filter (where me_epp_summary in ('exclusive', 'mixed')) as me_epp
        from tenders
       where proposals_close_at > now()
    `)
    const row = found.rows[0]
    if (!row) return null
    const stats = { open: Number(row.open), meEpp: Number(row.me_epp) }
    return Number.isFinite(stats.open) && stats.open > 0 ? stats : null
  } catch {
    // No database at build time, or the pool is down. The page renders without
    // the strip; nothing else on it depends on this.
    return null
  }
}
