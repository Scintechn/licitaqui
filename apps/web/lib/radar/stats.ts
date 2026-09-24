import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'
import { DIVULGADA } from './tender-status'

/**
 * "Hoje no Brasil · [Nº] editais abertos · [Nº] exclusivos ME/EPP · [Nº]
 * suspensos, revogados ou anulados" — the strip at the foot of canvas 01
 * (`Main.dc.html`).
 *
 * Three counts over `tenders`, read at build and at each revalidation: the
 * Landing is a public page and §3.3 gives public pages ISR, so this runs on
 * the server every ten minutes at most, never per visitor. It touches no
 * external API — the numbers come from the cache the worker fills.
 *
 * ## "Aberto" means open, which it did not until 2026-09-23
 *
 * This query counted `proposals_close_at > now()` and nothing else, while the
 * type above it claimed "tenders still receiving proposals". Measured against
 * production the day the status work shipped: **204 of the 8 028 it called
 * `abertos` had been suspended, revoked or annulled by the órgão** — one in
 * 39. They carry a future deadline, which is exactly why they pass a date
 * test. The public page was overstating by 2.5%, and CDC art. 30 makes an
 * advertised figure binding.
 *
 * So `open` and `meEpp` are now gated on `Divulgada no PNCP`, the same
 * allow-list `mayShowUrgency` uses and for the same reason: an unrecognised
 * status is not counted as open.
 *
 * **`halted` is not the complement of that, and must not be written as one.**
 * It first read `status is distinct from 'Divulgada no PNCP'`, which is TRUE
 * for NULL — so any tender the ingest had not classified would have been
 * published on the front page as *suspenso, revogado ou anulado pelo órgão*,
 * a claim about an agency's act that nothing supports. `status` is nullable
 * (`0001_initial.sql`) and the fallback sweep writes whatever
 * `situacao_nome` it got, so NULL is reachable even though production held
 * none when this was written. CDC art. 30 binds an advertised figure; an
 * unclassified tender is counted in neither column.
 *
 * ## `halted` is the differentiator, not a footnote
 *
 * The 204 is the number that says what this product does. On the PNCP a person
 * sees "prazo até 06/10" and learns the tender was suspended only by opening
 * it — if at all. Here it is a chip on the card, and a figure on the front
 * page.
 *
 * **What this number is not:** a rate. `tenders.pncp_updated_at` is the
 * agency's general update timestamp, not a status-change timestamp — all 204
 * had moved within seven days — so nothing here can say "N suspensos esta
 * semana". It is a stock: how many are halted *now*. Saying otherwise would
 * need a status-history row written when the value changes (B10).
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
  /** Tenders still receiving proposals — `Divulgada no PNCP`, deadline ahead. */
  open: number
  /** Of those, the ones whose items are exclusive to ME/EPP, whole or in part. */
  meEpp: number
  /**
   * Deadline still ahead, but the órgão has suspended, revoked or annulled it.
   * Deliberately **not** included in `open`: they are not receiving proposals.
   */
  halted: number
}

type Row = {
  open: string | number
  me_epp: string | number
  halted: string | number
}

export async function openTenderStats(executor?: Executor): Promise<RadarStats | null> {
  try {
    const found = await (executor ?? db()).execute<Row>(sql`
      select count(*) filter (where status = ${DIVULGADA})                       as open,
             count(*) filter (where status = ${DIVULGADA}
                                and me_epp_summary in ('exclusive', 'mixed'))    as me_epp,
             count(*) filter (where status is not null
                                and status <> ${DIVULGADA})                      as halted
        from tenders
       where proposals_close_at > now()
    `)
    const row = found.rows[0]
    if (!row) return null
    const stats = {
      open: Number(row.open),
      meEpp: Number(row.me_epp),
      halted: Number(row.halted),
    }
    return Number.isFinite(stats.open) && stats.open > 0 ? stats : null
  } catch {
    // No database at build time, or the pool is down. The page renders without
    // the strip; nothing else on it depends on this.
    return null
  }
}
