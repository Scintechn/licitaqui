import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'

/**
 * Whether the dated founders-opening broadcast is still queued — card **E20**,
 * watched the way **B37** watches the price feeds and **B17**'s coverage card
 * reads its own job, rather than as a third idiom.
 *
 * ## Why this exists, and why the card is evidence of itself
 *
 * The opening is **one `jobs` row**, placed by a person running
 * `worker/scripts/schedule_founders_opening.py --commit`. On **2026-10-03** that
 * row — job `103288` — was deleted because Sci moved the opening off 08/10, and
 * **two days passed with nothing scheduled and nothing noticing**. The audit of
 * 2026-10-05 found it by querying `jobs` by hand. Nothing the worker ran on its
 * own asserted it: `selfcheck` renders templates, `preflight` reads environment
 * variables, and `DEFAULT_SCHEDULE` cannot express a single date at all.
 *
 * `opening_broadcast_check` (`worker/licitaqui/opening_check.py`) is that
 * assertion now, twice a day at 09:00 and 15:00 BRT. This file reads what it
 * wrote. The division of labour is deliberate and is the same one B17 uses: the
 * worker measures, because PNCP and the queue are its side of the wall; the card
 * reports, because a number nobody reads is B32.
 *
 * ## B32's rule, pointing the other way
 *
 * `coverage.ts` says it loudly: *alarm on absence of success, never on absence
 * of queueing*, and **nothing there reads `jobs`**. Here the thing being watched
 * **is** a `jobs` row — so the worker reads that table, and the rule moves up one
 * level rather than being suspended. This file still reads only `events`: a
 * check that stops running leaves no row, and that silence is `stale`, which is a
 * fact about the watchdog and must not read like a fact about the broadcast.
 *
 * Those are genuinely different sentences and the card prints different ones:
 *
 * - `missing` — we looked, recently, and **the row is not there**. 2026-10-03.
 * - `stale` — nothing looked inside the threshold. We do **not know** whether
 *   the row is there, and the last reading, however good, has stopped being
 *   evidence.
 *
 * ## The threshold is 30 h, and the arithmetic is the entry's
 *
 * `scheduler.py` holds two entries for this kind, 09:00 and 15:00 BRT, so the
 * longest gap between readings is **18 h**. Thirty hours therefore tolerates one
 * missed run (the previous reading is 24 h old at the next one) and refuses a
 * whole day of silence. That is tighter than the three cadences B37 gives its
 * daily feeds, deliberately: this watches a single dated event, and three days of
 * not knowing is not a watch when the event is eight days away.
 *
 * ## It reports the reading, never its own opinion of the queue
 *
 * The worker decides the state, because the worker is the side that holds the
 * row, the configured instant and the database clock at the same moment. This
 * file re-derives nothing — no second copy of the tolerance, no second
 * conversion of 12:00 BRT. A reading whose `state` this file does not recognise
 * is reported as `unknown` rather than silently styled as healthy: a card whose
 * switch has no arm for a state is how a new state becomes invisible.
 */

/**
 * Hours of silence before a reading stops being evidence.
 *
 * Derived from the two schedule entries, not chosen: the gap between 15:00 BRT
 * and the next 09:00 BRT is 18 h, so this tolerates one missed run and nothing
 * more. `test_opening_check.py` pins the same 18 on the worker side so the two
 * cannot drift apart in silence.
 */
export const OPENING_THRESHOLD_HOURS = 30

/** The states `opening_check.STATES` declares, and nothing else. */
export type OpeningState =
  | 'queued'
  | 'sent'
  | 'missing'
  | 'misdated'
  | 'late'
  | 'fired_early'
  | 'failed'

const STATES: readonly OpeningState[] = [
  'queued',
  'sent',
  'missing',
  'misdated',
  'late',
  'fired_early',
  'failed',
]

/** One reading, as the worker wrote it. Every instant here is a real `Date`. */
export type OpeningReading = {
  /** When the check ran, from the **database's** `now()`, not a container's. */
  at: Date
  hours: number
  state: OpeningState
  /** The worker's own verdict about whether this state is bad. */
  alarm: boolean
  /** The `jobs.key` the check looked for — the question, recorded. */
  expectedKey: string
  /** The opening day the worker is dated by. */
  openingDate: string
  /** `product.OPENING_DATE`, so an env override that disagrees is visible. */
  productOpeningDate: string
  dateMatchesProduct: boolean
  /** `HH:MM` BRT, the hour the broadcast fires. */
  hourBrt: string
  /**
   * Both kill switches **as the deployed worker sees them** — `'send'` or
   * `'dry_run'`, never a credential.
   *
   * This is the only surface that can say so. `preview_founders_opening.py`
   * prints them too, but it reads the environment of the process *it* runs in,
   * so from a laptop its switch lines describe the laptop. The check runs on
   * the worker.
   */
  whatsappDelivery: string | null
  emailDelivery: string | null
  /**
   * Whether a message can leave the process at all. A **second dimension**, not
   * a state: a perfectly queued row with a dead switch sends nothing, and the
   * fix is an env change rather than a command.
   */
  deliveryReady: boolean
  /** The instant the broadcast is due, in UTC. The card prints both clocks. */
  dueAt: Date
  /** Negative once the instant has passed. */
  hoursToDue: number
  jobId: number | null
  jobStatus: string | null
  jobRunAfter: Date | null
  seated: number
  /** Who the sweep reaches with nothing — E5's open decision. */
  waitlisted: number
}

export type Opening =
  /** Checked inside the threshold. `reading.alarm` says whether it is bad. */
  | { kind: 'current'; reading: OpeningReading }
  /**
   * Nothing checked inside the threshold. **Not the same as `missing`**: the
   * last reading comes with it so the card can say what it was and how old.
   */
  | { kind: 'stale'; reading: OpeningReading }
  /** Never checked, at any date. Not stale, not an error. */
  | { kind: 'never'; note: string }
  /** The reading carried a state this build does not know. */
  | { kind: 'unknown'; reading: Omit<OpeningReading, 'state'> & { state: string } }
  /** The query failed. A code, never a driver message. */
  | { kind: 'error'; reason: string }

export type OpeningWatch = {
  thresholdHours: number
  /** What produces the reading, printed under it. */
  source: string
  watch: Opening
}

/** The job, the cadence and the clock — the card prints this verbatim. */
const SOURCE =
  'opening_broadcast_check, 09:00 e 15:00 BRT. Confere se a linha datada do disparo está na fila.'

/**
 * The newest reading, and only the newest.
 *
 * **No date predicate, deliberately** — the same reasoning `coverage.ts` gives:
 * a 30-day window would turn a watchdog dead for a month from `stale` into
 * *"nunca conferiu"* in grey, the alarm getting quieter as the problem got
 * older, which is B32's shape. Age is decided in TypeScript, where "no row ever"
 * and "no recent row" stay different answers.
 *
 * The `props ?` guards are about row **shape**, not name. A row without a state
 * or an expected key is not a reading, and letting one through is the only way
 * this card could render a verdict no check produced.
 */
const OPENING_SQL = sql`
  select props, created_at
    from events
   where name = 'opening_broadcast_check'
     and props ? 'state'
     and props ? 'expected_key'
   order by created_at desc, id desc
   limit 1
`

function hoursSince(at: Date, now: Date): number {
  return (now.getTime() - at.getTime()) / 3_600_000
}

type Row = { props: Record<string, unknown>; created_at: string | Date }

function num(value: unknown): number | null {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function date(value: unknown): Date | null {
  if (typeof value !== 'string' || value === '') return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/** `null` when the row is not a usable reading — never a default stood in for one. */
function toReading(row: Row, now: Date): (Omit<OpeningReading, 'state'> & { state: string }) | null {
  const props = row.props ?? {}
  // `checked_at` is the database clock the worker read; `created_at` is when the
  // row landed. They are the same instant to within a statement, and the
  // recorded one is preferred because it is the clock the state was decided on.
  const at = date(props.checked_at) ?? date(row.created_at) ?? null
  const dueAt = date(props.due_at)
  const state = typeof props.state === 'string' ? props.state : null
  const expectedKey = typeof props.expected_key === 'string' ? props.expected_key : null
  if (at === null || dueAt === null || state === null || expectedKey === null) return null

  const hoursToDue = num(props.hours_to_due)
  return {
    at,
    hours: hoursSince(at, now),
    state,
    alarm: props.alarm === true,
    expectedKey,
    openingDate: String(props.opening_date ?? ''),
    productOpeningDate: String(props.product_opening_date ?? ''),
    // Strictly `=== true`: a row written before this field existed must not
    // read as "the dates disagree" and raise an alarm about nothing.
    dateMatchesProduct: props.date_matches_product !== false,
    hourBrt: String(props.broadcast_hour_brt ?? ''),
    whatsappDelivery:
      typeof props.whatsapp_delivery === 'string' ? props.whatsapp_delivery : null,
    emailDelivery: typeof props.email_delivery === 'string' ? props.email_delivery : null,
    // `!== false` rather than `=== true`: a reading written before this field
    // existed must not raise an alarm about a switch nothing measured. A real
    // `false` arrives through `props->>` as the **string** `"false"`, which is
    // truthy — so this reads the parsed JSON value, not a `->>` text cast, and
    // `opening.db.test.ts` asserts that round trip against a real row.
    deliveryReady: props.delivery_ready !== false,
    dueAt,
    // Recomputed when the row did not carry it, from the same two instants the
    // worker used — never defaulted to 0, which would read as "due now".
    hoursToDue: hoursToDue ?? (dueAt.getTime() - at.getTime()) / 3_600_000,
    jobId: num(props.job_id),
    jobStatus: typeof props.job_status === 'string' ? props.job_status : null,
    jobRunAfter: date(props.job_run_after),
    seated: num(props.seated) ?? 0,
    waitlisted: num(props.waitlisted) ?? 0,
  }
}

/** Never throws: a failure is a state, like a gate's, a feed's or a coverage reading's. */
export async function readOpening(executor?: Executor, now = new Date()): Promise<OpeningWatch> {
  const base = { thresholdHours: OPENING_THRESHOLD_HOURS, source: SOURCE }

  let rows: Row[]
  try {
    const found = await (executor ?? db()).execute<Row>(OPENING_SQL)
    rows = found.rows
  } catch {
    return { ...base, watch: { kind: 'error', reason: 'query_failed' } }
  }

  const loose = rows.length === 0 ? null : toReading(rows[0], now)
  if (loose === null) {
    return {
      ...base,
      watch: {
        kind: 'never',
        note: 'nunca conferiu — não é o mesmo que a linha estar na fila',
      },
    }
  }

  if (!STATES.includes(loose.state as OpeningState)) {
    // A state this build has no sentence for. Reported as such rather than
    // falling through a switch into the healthy arm, which is how a new state
    // would become invisible on the one screen whose job is to be believed.
    return { ...base, watch: { kind: 'unknown', reading: loose } }
  }
  const reading = loose as OpeningReading

  if (reading.hours > OPENING_THRESHOLD_HOURS) {
    return { ...base, watch: { kind: 'stale', reading } }
  }
  return { ...base, watch: { kind: 'current', reading } }
}
