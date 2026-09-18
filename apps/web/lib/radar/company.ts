import { sql } from 'drizzle-orm'
import { readOrEnqueue, TTL, type Cached, type CacheRead } from '@/lib/cache'
import { db, type Executor } from '@/lib/db'
import { companyJobKey, JOB_KINDS } from '@/lib/jobs'
import type { CompanyView, SegmentFit } from './contract'

/**
 * The company behind a CNPJ, and the segments its CNAEs reach
 * (spec §6.2, §8 `POST /api/radar/cnpj`, migration 0003).
 *
 * ## The join the Radar is built on
 *
 * A tender's `segments` are POC 1's 14 Portuguese labels, written by the
 * worker's `sync_items` from the items' NCM codes and descriptions. A company's
 * CNAEs are 7-digit IBGE subclasses from BrasilAPI. `cnae_segments` (task B6)
 * maps the second onto the first **using the same label strings on purpose**,
 * so the Radar's match is `tenders.segments && company's segments` and nothing
 * has to translate anything at read time.
 *
 * The `company_segments` view applies B6's rule — `compatible` requires the
 * **main** CNAE, a segment reached only through secondary CNAEs is capped at
 * `check` — and this module reads the view rather than re-deriving it, so the
 * badge on the Radar and the badge the worker's alerts compute cannot disagree.
 *
 * ## Never in a log
 *
 * Nothing here logs. A CNPJ and a legal name identify a person when the company
 * is a MEI (§12); the job key carries `cnpjRef()` precisely so the queue can be
 * inspected without them.
 */

type CompanyRow = {
  cnpj: string
  legal_name: string | null
  trade_name: string | null
  main_cnae: string | null
  size: string | null
  is_mei: boolean | null
  state: string | null
  city: string | null
  registration_status: string | null
  updated_at: Date | string
  segments: SegmentFit[] | null
}

export type CompanyRead = {
  company: CompanyView
  /**
   * `main_cnae is null` — the worker's `MANUAL_CNAE_PREDICATE`. BrasilAPI has
   * no SLA (§9); when it cannot answer, the row exists as a placeholder and the
   * user has to pick their CNAE by hand.
   */
  manualCnae: boolean
  registrationStatus: string | null
}

const SELECT = sql`
  select c.cnpj, c.legal_name, c.trade_name, c.main_cnae, c.size, c.is_mei,
         c.state, c.city, c.registration_status, c.updated_at,
         (select json_agg(json_build_object(
                    'segment', s.segment,
                    'fit', s.fit,
                    'fromMainCnae', s.from_main_cnae,
                    'fromSecondaryCnae', s.from_secondary_cnae)
                  -- Compatible first, then the main activity, then A–Z: the
                  -- order the Radar draws the chips in, decided once here
                  -- rather than in every screen that shows them.
                  order by (s.fit = 'compatible') desc, s.from_main_cnae desc, s.segment)
            from company_segments s
           where s.cnpj = c.cnpj) as segments
    from companies c
`

export async function readCompany(
  cnpj: string,
  database: Executor = db(),
): Promise<CacheRead<CompanyRead> | null> {
  const found = await database.execute<CompanyRow>(sql`${SELECT} where c.cnpj = ${cnpj}`)
  const row = found.rows[0]
  if (!row) return null

  const manualCnae = row.main_cnae === null
  return {
    data: {
      company: {
        cnpj: row.cnpj,
        legalName: row.legal_name,
        tradeName: row.trade_name,
        mainCnae: row.main_cnae,
        size: row.size,
        isMei: row.is_mei,
        state: row.state,
        city: row.city,
        segments: row.segments ?? [],
      },
      manualCnae,
      registrationStatus: row.registration_status,
    },
    updatedAt: new Date(row.updated_at),
    // A placeholder row is not a 30-day fact (`licitaqui.company.FALLBACK_TTL`).
    ttl: manualCnae ? TTL.companyUnresolved : TTL.company,
  }
}

/**
 * §3.1 applied to a CNPJ: serve the cached company, refresh it behind the
 * screen when it is old, and answer "analyzing" the first time anyone asks.
 */
export async function companyOrLookup(
  cnpj: string,
  options: { executor?: Executor; now?: Date } = {},
): Promise<Cached<CompanyRead>> {
  return readOrEnqueue<CompanyRead>({
    read: (executor) => readCompany(cnpj, executor),
    ttl: TTL.company,
    refresh: {
      kind: JOB_KINDS.companyLookup,
      key: companyJobKey(cnpj),
      // The worker reads the CNPJ from here, so this is the one place in the
      // web app where a CNPJ leaves a row and enters a queue. It is a database
      // value, not a log line (§12).
      payload: { cnpj },
    },
    executor: options.executor,
    now: options.now,
  })
}

/** The segment labels the company matches, split the way the Radar groups. */
export function segmentsByFit(segments: SegmentFit[]): {
  compatible: string[]
  check: string[]
} {
  const compatible = segments.filter((s) => s.fit === 'compatible').map((s) => s.segment)
  const check = segments.filter((s) => s.fit === 'check').map((s) => s.segment)
  return { compatible, check }
}
