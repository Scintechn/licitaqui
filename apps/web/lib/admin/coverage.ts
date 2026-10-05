import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'

/**
 * Whether the Radar still holds the open editais it promises — card **B17**,
 * watched the way **B37** watches the price feeds.
 *
 * ## Why this reader exists
 *
 * The product's main sentence — *"os editais abertos que combinam com o que a
 * sua empresa já faz"* — rests on one measurable fact, and `coverage_check`
 * measures it. Measured 2026-10-05, that job had run **three times ever**, all
 * on 2026-09-30, over **one** keyword, and **nothing read the result**: no
 * card, no alarm. Its last row said `ratio: 1.0, held: 119, missing: 0`
 * against `baseline_2026_09_27: {held: 57, ratio: 0.416}` — so B17's gap was
 * measured closed and **nobody would notice if it came back**.
 *
 * That is B32's shape exactly: a feed stopped on 2026-09-29 and went unnoticed
 * for two days, because a feed that stops enqueuing also stops failing. The
 * `docs/CLAIMS.md` row for that sentence comes due **17/10**.
 *
 * ## The rule, from B32's card
 *
 * **Alarm on absence of success, never on absence of queueing.** Nothing here
 * reads `jobs`: a `coverage_check` job that is never enqueued, or one that
 * raises on every query, produces exactly the same thing — no `events` row —
 * and that silence is the alarm. A queue with nothing in it is not thereby
 * healthy.
 *
 * ## Six states, because four of them are different kinds of bad
 *
 * The distinction this file is built around is **`stale` against `short`**:
 *
 * - `short` — we measured, recently, and at least one keyword is under target.
 *   The gap B17 closed has come back. A fact about the Radar.
 * - `stale` — nothing measured inside the threshold. We do **not know** what
 *   the coverage is, and the last reading, however good, has stopped being
 *   evidence. A fact about the watchdog.
 * - `incomplete` — measured, everything above target, and a keyword of the
 *   standing set has no recent reading of its own. One segment went dark while
 *   the aggregate stayed green.
 * - `adhoc_only` — the only recent readings are from somebody's one-off
 *   `check_coverage.py --q …`. The standing set was not measured, so nothing
 *   here can say it is in order.
 *
 * Reporting a stale reading as healthy is how B32 lasted two days, and
 * reporting it as *short* would be the opposite error — a red alarm about the
 * Radar when the fact is that the measurement did not run.
 *
 * ## The age is the OLDEST reading, not the newest
 *
 * Found by this card's own review, and it is the difference between a true
 * sentence and a false one. The threshold is applied per keyword, so a run
 * where one broad keyword keeps answering and six are refused every night
 * leaves six readings ageing quietly while the seventh is always fresh.
 * Reporting the newest of them would print *"medido há 0 h, em 7
 * palavras-chave — todas na meta"* on a set six-sevenths of which had not been
 * measured for three days. So the reported age — and the staleness decision —
 * is the **oldest** current reading of the standing set.
 *
 * ## Why the worst keyword decides, and not the average
 *
 * `coverage_check` measures seven keywords: B17's baseline plus one per
 * segment in `sync_awards.DEFAULT_SEGMENTS`, the six the CNAE map covers most
 * heavily (455 of its 572 codes — **not** one per segment; there are fourteen,
 * and B42 is the rest). The sentence is addressed to *each* company, so an
 * average over seven segments can sit comfortably above target while the
 * segment one founder actually works in holds nothing. The state is therefore
 * set by the **weakest** keyword; the aggregate is printed beside it as
 * context, never as the pass.
 *
 * ## `query_set`, `standing`, and the keyword that fails every night
 *
 * An empty walk is never recorded — not even as 0% — because PNCP refusing an
 * origin and the Radar holding nothing look identical from one machine
 * (`memory: empty-result-is-not-absence`). So a keyword that cannot be
 * measured leaves **no row**, and a reader counting rows would see six
 * keywords rather than six of seven. Every row therefore carries the whole set
 * it belonged to, and whether that set is the **standing** one — because an
 * ad-hoc single-keyword run is the newest row afterwards, and taking the set
 * from it would quietly redefine "complete" as that one word.
 */

/**
 * Hours of silence before a reading stops being evidence.
 *
 * Three cadences of a daily job, matching what B37 gives its two daily feeds:
 * one missed run is not an alarm, three are. (It is three, not two — the
 * review caught the comment that said otherwise.)
 */
export const COVERAGE_THRESHOLD_HOURS = 24 * 3

export type CoverageQuery = {
  /** The keyword asked of PNCP. */
  q: string
  /** The segment it reaches, through the product's own classifier. */
  segment: string | null
  at: Date
  hours: number
  ratio: number
  held: number
  collected: number
  /** PNCP's own count, which exceeds `collected` when the walk truncated. */
  pncpTotal: number | null
  met: boolean
  /** The walk hit its page ceiling, so the ratio is over the newest N. */
  truncated: boolean
}

export type CoverageReading =
  /** Measured inside the threshold, every keyword of the set at or above target. */
  | { state: 'fresh'; at: Date; hours: number; summary: CoverageSummary }
  /** Measured, and the weakest keyword is under target. B17's gap is back. */
  | { state: 'short'; at: Date; hours: number; summary: CoverageSummary }
  /** Measured and above target, but a keyword of the set has no recent reading. */
  | { state: 'incomplete'; at: Date; hours: number; summary: CoverageSummary }
  /** Recent readings exist, but none of them is the standing set. */
  | { state: 'adhoc_only'; at: Date; hours: number; summary: CoverageSummary }
  /**
   * Nothing measured inside the threshold. **Not the same as short**: the last
   * reading is carried so the card can say what it was and how old it is.
   */
  | { state: 'stale'; at: Date; hours: number; last: CoverageQuery }
  /** Never measured, at any date. Not stale, not an error. */
  | { state: 'never'; note: string }
  /** The query failed. A code, never a driver message. */
  | { state: 'error'; reason: string }

export type CoverageSummary = {
  /** The current reading per keyword, weakest first. */
  queries: CoverageQuery[]
  /**
   * The standing set itself, as the worker last declared it. Carried because
   * it is the honest denominator: `queries.length + missing.length` would
   * count an ad-hoc keyword measured today as an eighth member of a set of
   * seven.
   */
  expected: string[]
  /** Keywords of the standing set with no reading inside the threshold. */
  missing: string[]
  /** Held over collected across `queries` — context, never the pass. */
  ratio: number
  held: number
  collected: number
  /** The keyword the state was decided on. */
  worst: CoverageQuery
  /**
   * The target the worker measured against, read from the row it wrote, and
   * `null` on a row that carried none. **Not restated here**: `TARGET_RATIO`
   * lives in `coverage_check.py`, and a second copy of a threshold is the
   * shape D29 came from. A null prints nothing rather than a number this file
   * invented.
   */
  target: number | null
}

export type Coverage = {
  thresholdHours: number
  /** What produces the reading, printed under it. */
  source: string
  reading: CoverageReading
}

/** The job, the cadence and the clock — the card prints this verbatim. */
const SOURCE =
  'coverage_check, diário 05:10 BRT. Compara o que o PNCP chama de aberto com o que o Radar tem.'

/**
 * The newest `coverage_check` row **per keyword**, weakest first.
 *
 * `distinct on (props->>'q')` with `created_at desc` is the whole query: one
 * reading per keyword, so a keyword measured twice today does not count twice
 * and a keyword measured once last week is still visible as a last known
 * reading.
 *
 * **No date predicate, deliberately.** An earlier version looked back 30 days,
 * which meant a watchdog dead for a month stopped being `stale` and became
 * *"nunca mediu"* in grey — the alarm getting quieter as the problem got
 * older, which is B32's shape. Age is decided in TypeScript, where the
 * distinction between "no row ever" and "no recent row" survives. The volume
 * is seven rows a day against `events_name_created_idx`.
 *
 * The three `props ?` guards are about row **shape**, not name. A row without
 * a ratio, a held or a collected is not a measurement, and letting one through
 * is the only way a `0%` could appear on this card that no walk produced.
 */
const COVERAGE_SQL = sql`
  select distinct on (props->>'q')
         props->>'q'                                      as q,
         props->>'segment'                                as segment,
         created_at,
         (props->>'ratio')::float8                        as ratio,
         (props->>'held')::int                            as held,
         (props->>'collected')::int                       as collected,
         -- numeric, not int: this is the only field PNCP writes rather than
         -- the worker, so it is the only one that could arrive as "1.0" or
         -- with a separator, and a cast that throws here would blank the whole
         -- card for all seven keywords. The review caught it.
         (props->>'pncp_total')::numeric                  as pncp_total,
         (props->>'target')::float8                       as target,
         (props->>'met')::boolean                         as met,
         coalesce((props->>'truncated')::boolean, false)  as truncated,
         coalesce((props->>'standing')::boolean, false)   as standing,
         props->'query_set'                               as query_set
    from events
   where name = 'coverage_check'
     and props ? 'ratio'
     and props ? 'held'
     and props ? 'collected'
   order by props->>'q', created_at desc
`

function hoursSince(at: Date, now: Date): number {
  return (now.getTime() - at.getTime()) / 3_600_000
}

type Row = Record<string, unknown>

/** `null` when the row is not a usable reading — never a zero stood in for one. */
function toQuery(row: Row, now: Date): CoverageQuery | null {
  const at = new Date(row.created_at as string)
  const num = (key: string): number | null => {
    const value = row[key]
    if (value === null || value === undefined) return null
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  const ratio = num('ratio')
  const held = num('held')
  const collected = num('collected')
  // No `?? 0` anywhere above: a missing count defaulting to zero is how a row
  // that is not a measurement would render as "0 de 0" — and a 0% on this
  // card means the Radar holds none of them, which is the one thing it must
  // never say without a walk behind it.
  if (ratio === null || held === null || collected === null || Number.isNaN(at.getTime())) {
    return null
  }
  return {
    q: String(row.q ?? ''),
    segment: row.segment === null || row.segment === undefined ? null : String(row.segment),
    at,
    hours: hoursSince(at, now),
    ratio,
    held,
    collected,
    pncpTotal: num('pncp_total'),
    met: row.met === true,
    truncated: row.truncated === true,
  }
}

/** The most recently written row, among those matching `where`. */
function newestRow(rows: Row[], where: (row: Row) => boolean = () => true): Row | undefined {
  return rows.filter(where).reduce<Row | undefined>((newest, row) => {
    if (newest === undefined) return row
    const a = new Date(row.created_at as string).getTime()
    const b = new Date(newest.created_at as string).getTime()
    return a > b ? row : newest
  }, undefined)
}

type StandingSet =
  /** The worker declared this set, on a run that measured the standing one. */
  | { kind: 'declared'; set: string[] }
  /**
   * A set exists — some row names one — but no **standing** run is on record,
   * so what is here is somebody's one-off. Not a set this card may call
   * complete.
   */
  | { kind: 'adhoc' }
  /**
   * No row names a set at all. The three rows of 2026-09-30 predate both
   * fields, so the only honest reading is "whatever was measured", with
   * nothing reported missing — incomplete in a way this code cannot know
   * about, rather than a false alarm.
   */
  | { kind: 'unknown' }

/**
 * What the standing set is, read from the data rather than restated here.
 *
 * A copy of the keyword list in this file would drift from
 * `coverage_check.DEFAULT_QUERIES` and the two would disagree about what
 * "complete" means.
 *
 * The `adhoc` case is a false green the review found: with the scheduled job
 * dead and no standing row left, one `check_coverage.py --commit --q saas`
 * would have been the only row, its `query_set` would have been `["saas"]`,
 * nothing would have been missing, and the card would have said *"em dia"*
 * under a `source` line still promising a daily run. A row that carries a
 * `query_set` but is not standing is **evidence that a standing set exists and
 * that this is not it**.
 */
function standingSet(rows: Row[]): StandingSet {
  const declared = newestRow(rows, (row) => row.standing === true)?.query_set
  if (Array.isArray(declared) && declared.length > 0) {
    return { kind: 'declared', set: declared.map((q) => String(q)) }
  }
  const named = rows.some((row) => Array.isArray(row.query_set) && row.query_set.length > 0)
  return named ? { kind: 'adhoc' } : { kind: 'unknown' }
}

/** Never throws: a failure is a state, like a gate's or a feed's. */
export async function readCoverage(executor?: Executor, now = new Date()): Promise<Coverage> {
  const base = { thresholdHours: COVERAGE_THRESHOLD_HOURS, source: SOURCE }

  let rows: Row[]
  try {
    const found = await (executor ?? db()).execute<Row>(COVERAGE_SQL)
    rows = found.rows
  } catch {
    return { ...base, reading: { state: 'error', reason: 'query_failed' } }
  }

  const readings = rows
    .map((row) => toQuery(row, now))
    .filter((query): query is CoverageQuery => query !== null)

  if (readings.length === 0) {
    return {
      ...base,
      reading: { state: 'never', note: 'nunca mediu — não é o mesmo que estar em dia' },
    }
  }

  const standing = standingSet(rows)
  // Everything outside the standing set is excluded from the headline, the
  // aggregate and the state. The review's case: an ad-hoc `--q limpeza` at 40%
  // would otherwise become the card's `worst` and raise *"a lacuna do B17
  // voltou em limpeza"* — a real alarm about a keyword the set never agreed a
  // target for.
  const inSet =
    standing.kind === 'declared'
      ? readings.filter((query) => standing.set.includes(query.q))
      : readings
  const current = inSet
    .filter((query) => query.hours <= COVERAGE_THRESHOLD_HOURS)
    .sort((a, b) => a.ratio - b.ratio)

  if (current.length === 0) {
    // Stale, and the last reading comes with it: "97% há 9 dias" is a very
    // different sentence from "97%", and collapsing the two is how a watchdog
    // reports a dead feed as healthy.
    const pool = inSet.length > 0 ? inSet : readings
    const last = pool.reduce((newest, query) => (query.at > newest.at ? query : newest))
    return { ...base, reading: { state: 'stale', at: last.at, hours: last.hours, last } }
  }

  // **The oldest current reading, not the newest.** See the module comment.
  const oldest = current.reduce((worst, query) => (query.hours > worst.hours ? query : worst))
  const expected = standing.kind === 'declared' ? standing.set : current.map((query) => query.q)
  const missing = expected.filter((q) => !current.some((query) => query.q === q))
  const held = current.reduce((total, query) => total + query.held, 0)
  const collected = current.reduce((total, query) => total + query.collected, 0)
  const target = Number(newestRow(rows)?.target ?? Number.NaN)

  const summary: CoverageSummary = {
    queries: current,
    expected,
    missing,
    held,
    collected,
    ratio: collected === 0 ? 0 : held / collected,
    worst: current[0],
    target: Number.isFinite(target) && target > 0 ? target : null,
  }

  // Precedence, and it is the point of the card: the Radar being short is a
  // worse fact than the measurement being incomplete, which is worse than the
  // standing set not having been measured at all being mistaken for health.
  const state =
    standing.kind === 'adhoc'
      ? 'adhoc_only'
      : current.some((query) => !query.met)
        ? 'short'
        : missing.length > 0
          ? 'incomplete'
          : 'fresh'

  return { ...base, reading: { state, at: oldest.at, hours: oldest.hours, summary } }
}
