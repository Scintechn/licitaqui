import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'

/**
 * When each price feed last did **real work** — card B37.
 *
 * ## Why this exists, and why "real work" is the whole point
 *
 * B35 computes a `refreshed_codes` figure and writes it to `events`. B36's two
 * jobs write their own rows. **Nothing read any of them.** What existed instead
 * was the watchdog's wording, in two docstrings as *"phrase it as…"* — which is
 * `CLAUDE.md`'s *"a later in a comment is not a task"* on the one mechanism
 * whose absence **is** B32: that feed stopped on 2026-09-29 and nobody noticed
 * for two days, because a feed that stops enqueuing also stops failing, and 916
 * broken jobs looked like silence.
 *
 * So the rule, from B32's card: **alarm on "0 done in N days", never on "0
 * queued".**
 *
 * ## The trap this card is built around
 *
 * B35's own review found it: `refreshed_codes` counts codes that gained *any*
 * `catalog_bands` row — **and a refusal is a band row.** Measured 2026-10-04
 * over a full nightly pass: 1 028 codes refreshed, of which **947 were
 * `spread_too_wide`** and only 74 produced a band. So a feed writing nothing but
 * refusals reads as perfectly healthy if you count rows.
 *
 * Hence `bands` and `refusals` are counted separately, and staleness is measured
 * from the last row that is **not** a refusal. A pass that refuses everything is
 * reported, not hidden — but it does not reset the clock.
 *
 * ## Three feeds, three clocks
 *
 * They fail on different cadences, so one threshold would be wrong for two of
 * them: the vocabulary mirror is weekly (Sunday 03:20 BRT), the item→code map
 * daily (04:10), the price refresh daily (04:40). The thresholds below are each
 * roughly twice the cadence, so one missed run is not an alarm and two are.
 */

export type FeedKey = 'catalog_vocabulary' | 'item_codes' | 'catalog_prices'

export type FeedReading =
  /** Last real work, and how long ago. `detail` is the feed's own counters. */
  | { state: 'fresh' | 'stale'; at: Date; hours: number; detail: string }
  /**
   * The feed has written rows but **none of them real work** — the shape the
   * row-counting version of this card could not see.
   */
  | { state: 'refusals_only'; at: Date; hours: number; detail: string }
  /** Never run. Not the same as stale, and not an error. */
  | { state: 'never'; note: string }
  /** The query failed. A code, never a driver message. */
  | { state: 'error'; reason: string }

export type Feed = {
  key: FeedKey
  label: string
  /** Hours of silence before this feed is stale — about two cadences. */
  thresholdHours: number
  /** What the feed does, printed under the reading. */
  source: string
  reading: FeedReading
}

const FEEDS: ReadonlyArray<Omit<Feed, 'reading'>> = Object.freeze([
  {
    key: 'catalog_vocabulary',
    label: 'Vocabulário do catálogo',
    thresholdHours: 24 * 15,
    source:
      'sync_catalog_vocabulary, domingo 03:20 BRT. Espelha os PDMs e o CATSER ativos.',
  },
  {
    key: 'item_codes',
    label: 'Itens mapeados para códigos',
    thresholdHours: 24 * 3,
    source: 'map_item_codes, diário 04:10 BRT. Sem chamada externa.',
  },
  {
    key: 'catalog_prices',
    label: 'Faixas de preço',
    thresholdHours: 24 * 3,
    source:
      'refresh_catalog_prices, diário 04:40 BRT. Conta faixas, não linhas: uma recusa também grava linha.',
  },
])

/**
 * The newest row per feed that represents work, and the newest of any kind.
 *
 * Two timestamps per feed because the difference between them is the finding:
 * `worked_at` null while `wrote_at` is recent means the feed is running and
 * producing nothing, which is `refusals_only`.
 *
 * `events.name` is matched by equality or a prefix, and `events_name_created_idx`
 * covers both — the prices feed writes one `catalog_prices_swept` row per sweep
 * plus one `catalog_prices:<code>` attempt marker per code, and only the first
 * is a pass.
 */
const FEEDS_SQL = sql`
  with sweeps as (
    select
      max(created_at) filter (
        where name = 'catalog_vocabulary_synced'
      ) as vocab_wrote,
      max(created_at) filter (
        where name = 'catalog_vocabulary_synced'
          and coalesce((props->>'pdm_active')::int, 0) > 0
      ) as vocab_worked,
      max(created_at) filter (where name = 'item_codes_mapped') as codes_wrote,
      max(created_at) filter (
        where name = 'item_codes_mapped'
          and coalesce((props->'by_rule'->>'exact')::int, 0) > 0
      ) as codes_worked,
      max(created_at) filter (where name = 'catalog_prices_swept') as prices_wrote
      from events
     where created_at > now() - interval '90 days'
       and name in ('catalog_vocabulary_synced', 'item_codes_mapped',
                    'catalog_prices_swept')
  ),
  -- A band, not a row. "refused_reason is null" is the whole distinction, and
  -- measured 2026-10-04 it is 74 rows of 1 028.
  bands as (
    select max(computed_at) filter (where refused_reason is null) as prices_worked,
           count(*) filter (where refused_reason is null) as band_count,
           count(*) filter (where refused_reason is not null) as refusal_count
      from catalog_bands
  )
  select s.vocab_wrote, s.vocab_worked, s.codes_wrote, s.codes_worked,
         s.prices_wrote, b.prices_worked, b.band_count, b.refusal_count
    from sweeps s cross join bands b
`

function hoursSince(at: Date, now: Date): number {
  return (now.getTime() - at.getTime()) / 3_600_000
}

function reading(
  wrote: Date | null,
  worked: Date | null,
  thresholdHours: number,
  detail: string,
  now: Date,
): FeedReading {
  if (worked === null) {
    if (wrote === null) {
      return {
        state: 'never',
        note: 'nunca rodou — não é o mesmo que atrasado',
      }
    }
    // Running, writing, producing nothing. The state a row count cannot see.
    return { state: 'refusals_only', at: wrote, hours: hoursSince(wrote, now), detail }
  }
  const hours = hoursSince(worked, now)
  return { state: hours > thresholdHours ? 'stale' : 'fresh', at: worked, hours, detail }
}

/** Every feed's reading. Never throws: a failure is a row, like a gate's. */
export async function readFeeds(executor?: Executor, now = new Date()): Promise<Feed[]> {
  let row: Record<string, unknown> | undefined
  try {
    const found = await (executor ?? db()).execute<Record<string, unknown>>(FEEDS_SQL)
    row = found.rows[0]
  } catch {
    return FEEDS.map((feed) => ({
      ...feed,
      reading: { state: 'error', reason: 'query_failed' },
    }))
  }

  const at = (key: string): Date | null => {
    const value = row?.[key]
    return value === null || value === undefined ? null : new Date(value as string)
  }
  const count = (key: string): number => Number(row?.[key] ?? 0)

  const bands = count('band_count')
  const refusals = count('refusal_count')

  return FEEDS.map((feed) => {
    if (feed.key === 'catalog_vocabulary') {
      return {
        ...feed,
        reading: reading(at('vocab_wrote'), at('vocab_worked'), feed.thresholdHours,
                         'PDMs e serviços ativos espelhados', now),
      }
    }
    if (feed.key === 'item_codes') {
      return {
        ...feed,
        reading: reading(at('codes_wrote'), at('codes_worked'), feed.thresholdHours,
                         'itens resolvidos para um código exato', now),
      }
    }
    return {
      ...feed,
      reading: reading(at('prices_wrote'), at('prices_worked'), feed.thresholdHours,
                       `${bands} faixas · ${refusals} recusas`, now),
    }
  })
}
