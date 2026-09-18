import { sql, type SQL } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'

/**
 * The one way to write a row into `events` (spec §6.3, §14).
 *
 * Every Phase 0 gate number is a `select` over this table, so the value of the
 * table is entirely in its consistency: one misspelled `name` and a gate reads
 * zero forever. Hence a closed catalogue (`EventName`) instead of a `string`,
 * and one place that knows the column list and the casts.
 *
 * Two entry points, because the callers are genuinely different:
 *
 *  - `recordEvent()` — a statement of its own. Anything that is not already
 *    inside a transaction it must join.
 *  - `eventInsertSelect()` — an `insert … select` fragment to embed in a
 *    data-modifying CTE, for a flow that must write the event in the *same*
 *    statement as the thing it is recording (the founders signup: seat, event
 *    and welcome job are atomic or they are wrong). The caller appends its own
 *    `from …`.
 *
 * Nothing here logs. `props` is written to the database and never printed, so a
 * caller may put an internal id in it — but never a name, an e-mail, a phone
 * number or a CPF (§12): the row these events point at already holds those, and
 * `events` is the table the analytics queries read.
 */

/**
 * The event names of spec §14, verbatim and in the spec's order.
 *
 * `props` is free-form per event; what each one carries is documented by the
 * code that writes it.
 */
export const SPEC_EVENT_NAMES = [
  'offer_viewed',
  'founder_signed_up',
  'cnpj_searched',
  'screening_requested',
  'screening_viewed',
  'tender_opened',
  'account_created',
  'telegram_linked',
  'alert_sent',
  'alert_opened',
  'locked_block_clicked',
  'checkout_opened',
  'subscription_active',
  'cancelled',
] as const

/**
 * Names in use that §14 does not list.
 *
 * `founder_signup` is task F1's spelling of §14's `founder_signed_up`, and
 * `founder_signup_duplicate` is F1's addition: a repeat submit of an e-mail
 * already on the list, which takes no seat and queues no second welcome.
 *
 * O1 deliberately did **not** rename `founder_signup`: the card says to move
 * F1's two writes onto this helper without changing their semantics, and the
 * name is what the rows already in the database say. The consequence is that
 * one fact has two possible spellings, so the "founders signed up" gate counts
 * `founders_list` rows — the record itself — rather than events
 * (`lib/admin/gates.ts`). Reconciling the two spellings (rename + backfill, or
 * amend §14) is a decision for Sci, listed as a follow-up on the O1 PR.
 */
export const EXTRA_EVENT_NAMES = ['founder_signup', 'founder_signup_duplicate'] as const

export const EVENT_NAMES = [...SPEC_EVENT_NAMES, ...EXTRA_EVENT_NAMES] as const

export type EventName = (typeof EVENT_NAMES)[number]

const KNOWN = new Set<string>(EVENT_NAMES)

/** Whether `name` is in the catalogue. For validating a name read at runtime. */
export function isEventName(name: string): name is EventName {
  return KNOWN.has(name)
}

export type EventProps = Record<string, unknown>

export type EventInput = {
  name: EventName
  /** `events.user_id` — references `users(id)`, so it must be a real user. */
  userId?: number | null
  /** `events.visitor_id` — references `visitors(id)`, so it must be a real visitor. */
  visitorId?: string | null
  props?: EventProps | null
}

type ColumnSource = SQL | number | string | null | undefined

/**
 * `insert into events (…) select …` with no `from` clause, for embedding in a
 * CTE. Pass SQL fragments to read the values out of the enclosing query.
 *
 * Every parameter is cast: inside a `select` list Postgres cannot infer the
 * type of a bare parameter (42P18), and `null` without a cast fails outright.
 */
export function eventInsertSelect(event: {
  name: EventName
  userId?: ColumnSource
  visitorId?: ColumnSource
  props?: SQL | null
}): SQL {
  return sql`
    insert into events (user_id, visitor_id, name, props)
    select ${column(event.userId, 'bigint')},
           ${column(event.visitorId, 'uuid')},
           ${event.name}::text,
           ${event.props ?? sql`null::jsonb`}
  `
}

function column(value: ColumnSource, type: 'bigint' | 'uuid'): SQL {
  if (value === null || value === undefined) return sql.raw(`null::${type}`)
  if (typeof value === 'number' || typeof value === 'string') {
    return sql`${value}::${sql.raw(type)}`
  }
  return value
}

/**
 * Writes one event. Runs on the pool, or inside the transaction you hand it.
 *
 * It does not swallow errors: a caller that considers the event optional says
 * so with `recordEventSafely()`.
 */
export async function recordEvent(event: EventInput, database: Executor = db()): Promise<void> {
  const props = event.props ?? null
  await database.execute(sql`
    ${eventInsertSelect({
      name: event.name,
      userId: event.userId,
      visitorId: event.visitorId,
      props: props === null ? null : sql`${JSON.stringify(props)}::jsonb`,
    })}
  `)
}

/**
 * `recordEvent()` for the cases where losing the event is better than failing
 * the request it belongs to — a page view, a click. Returns whether it landed.
 *
 * The failure is logged as a code and a name, never the props: §12 forbids
 * personal data in logs and a caller cannot be trusted to have kept it out.
 */
export async function recordEventSafely(
  event: EventInput,
  database: Executor = db(),
): Promise<boolean> {
  try {
    await recordEvent(event, database)
    return true
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'unknown'
    console.error(`events: could not record ${event.name} (${code})`)
    return false
  }
}
