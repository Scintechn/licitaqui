import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'

/**
 * The six Phase 0 gate numbers (spec §14, gate date 2026-11-06):
 *
 * > founders signed up (≥ 150), CNPJs searched (≥ 300), Telegram linked
 * > (≥ 100), concierge users paying (≥ 6 of 20), founder seats paid (≥ 15 of
 * > 48), weekly digest open rate (≥ 50%).
 *
 * Most of them are zero today, and one of them cannot be measured at all yet.
 * Every row is rendered anyway, saying which it is: a hidden row is a gate
 * nobody is watching, and "0 de 150" in week three is information.
 *
 * Each gate carries the sentence that describes its source, and the page prints
 * it under the number. When a figure looks wrong at the gate review, the first
 * question is always "counted how?", and this is the answer being on screen
 * rather than in a file someone has to find.
 */

export type GateKey =
  | 'founders_signed_up'
  | 'cnpjs_searched'
  | 'telegram_linked'
  | 'concierge_paying'
  | 'founder_seats_paid'
  | 'digest_open_rate'

export type GateReading =
  /** A real count. `of` is the denominator when the target is "x of y". */
  | { state: 'counted'; value: number; of?: number }
  /** A real rate, and the sample it came from. */
  | { state: 'rate'; percent: number; opened: number; sent: number }
  /** Nothing has happened yet, and a rate over an empty sample is not 0%. */
  | { state: 'no_data'; note: string }
  /** Nothing in the database can answer this yet. Not the same as zero. */
  | { state: 'no_source'; note: string }
  /** The query failed. A code, never a driver message. */
  | { state: 'error'; reason: string }

export type Gate = {
  key: GateKey
  /** pt-BR, for the card. */
  label: string
  /** The Phase 0 threshold. */
  target: number
  /** The denominator in "6 de 20", when the target has one. */
  targetOf?: number
  unit: 'count' | 'percent'
  /** How this number is produced, in one sentence. Printed on the card. */
  source: string
  reading: GateReading
}

async function scalar(database: Executor, query: ReturnType<typeof sql>): Promise<number> {
  const { rows } = await database.execute<{ value: string }>(query)
  return Number(rows[0]?.value ?? 0)
}

async function attempt(read: () => Promise<GateReading>): Promise<GateReading> {
  try {
    return await read()
  } catch (error) {
    const code = (error as { code?: string } | null)?.code ?? 'unknown'
    return { state: 'error', reason: code }
  }
}

/**
 * Founders signed up.
 *
 * Counted from `founders_list`, not from `events`: the list is the record, one
 * row per person, unique by e-mail. The events table has two spellings of this
 * fact (`founder_signup` from task F1, `founder_signed_up` in §14 — see
 * `lib/events`) and would also double-count a retried insert. Where a table
 * holds the fact itself, the gate counts the table.
 */
async function foundersSignedUp(database: Executor): Promise<GateReading> {
  const value = await scalar(database, sql`select count(*)::text as value from founders_list`)
  return { state: 'counted', value }
}

/**
 * Distinct CNPJs searched.
 *
 * A search writes a `visitors` row (spec §8, `POST /api/radar/cnpj`) and a
 * logged-in user's CNPJ sits on `users`, so the gate is the union of the two,
 * de-duplicated: the same CNPJ typed on a phone and then on a laptop is one
 * business, which is what the gate is asking about.
 */
async function cnpjsSearched(database: Executor): Promise<GateReading> {
  const value = await scalar(
    database,
    sql`
      select count(*)::text as value
        from (
          select cnpj from visitors where cnpj is not null
          union
          select cnpj from users    where cnpj is not null
        ) as searched
    `,
  )
  return { state: 'counted', value }
}

/** Telegram accounts linked: a `telegram_links` row that actually completed. */
async function telegramLinked(database: Executor): Promise<GateReading> {
  const value = await scalar(
    database,
    sql`select count(*)::text as value from telegram_links where linked_at is not null`,
  )
  return { state: 'counted', value }
}

/**
 * Founder seats paid.
 *
 * An active subscription on the Promocional plan — the R$ 26 price only a
 * founder seat can buy (§10). Task F2 owns the writing of these rows; the
 * plan string is assumed to be `promocional` and the Asaas status `ACTIVE`,
 * compared case-insensitively. If F2 settles on different values this query is
 * the one place to change, and the number to check on the day it goes live.
 */
async function founderSeatsPaid(database: Executor): Promise<GateReading> {
  const value = await scalar(
    database,
    sql`
      select count(*)::text as value
        from subscriptions
       where lower(coalesce(plan, '')) = 'promocional'
         and lower(coalesce(status, '')) in ('active', 'confirmed')
    `,
  )
  return { state: 'counted', value, of: 48 }
}

/**
 * Weekly digest open rate.
 *
 * `alert_deliveries` records one row per (alert, tender) with `sent_at` and
 * `opened_at` (§6.3). The rate is opened ÷ sent over rows actually sent. With
 * nothing sent there is no rate — 0% would read as "nobody opens it" when the
 * truth is "nothing has gone out".
 */
async function digestOpenRate(database: Executor): Promise<GateReading> {
  const { rows } = await database.execute<{ sent: string; opened: string }>(sql`
    select count(*) filter (where sent_at is not null)::text   as sent,
           count(*) filter (where opened_at is not null)::text as opened
      from alert_deliveries
  `)
  const sent = Number(rows[0]?.sent ?? 0)
  const opened = Number(rows[0]?.opened ?? 0)
  if (sent === 0) {
    return { state: 'no_data', note: 'Nenhum digest enviado ainda (tasks E1/O2).' }
  }
  return { state: 'rate', percent: (opened / sent) * 100, opened, sent }
}

/**
 * Concierge users paying — the one gate with no source.
 *
 * The concierge cohort (20 hand-held users) is not modelled: no table says who
 * is in it, so "6 of 20 are paying" cannot be computed from a subscription
 * count without inventing the cohort. Shown as what it is, with what it needs.
 */
const CONCIERGE_NOTE =
  'Sem fonte de dados: nenhuma tabela marca quem está no concierge. ' +
  'Precisa da coorte (task O2) antes de virar número.'

export async function readGates(database: Executor = db()): Promise<Gate[]> {
  const [founders, cnpjs, telegram, seats, digest] = await Promise.all([
    attempt(() => foundersSignedUp(database)),
    attempt(() => cnpjsSearched(database)),
    attempt(() => telegramLinked(database)),
    attempt(() => founderSeatsPaid(database)),
    attempt(() => digestOpenRate(database)),
  ])

  return [
    {
      key: 'founders_signed_up',
      label: 'Fundadores inscritos',
      target: 150,
      unit: 'count',
      source: 'Linhas em founders_list.',
      reading: founders,
    },
    {
      key: 'cnpjs_searched',
      label: 'CNPJs pesquisados',
      target: 300,
      unit: 'count',
      source: 'CNPJs distintos em visitors + users.',
      reading: cnpjs,
    },
    {
      key: 'telegram_linked',
      label: 'Telegram conectados',
      target: 100,
      unit: 'count',
      source: 'telegram_links com linked_at preenchido.',
      reading: telegram,
    },
    {
      key: 'concierge_paying',
      label: 'Concierge pagando',
      target: 6,
      targetOf: 20,
      unit: 'count',
      source: 'Ainda não há de onde contar.',
      reading: { state: 'no_source', note: CONCIERGE_NOTE },
    },
    {
      key: 'founder_seats_paid',
      label: 'Vagas de fundador pagas',
      target: 15,
      targetOf: 48,
      unit: 'count',
      source: 'subscriptions no plano promocional com status ativo.',
      reading: seats,
    },
    {
      key: 'digest_open_rate',
      label: 'Abertura do digest semanal',
      target: 50,
      unit: 'percent',
      source: 'alert_deliveries: abertos ÷ enviados.',
      reading: digest,
    },
  ]
}

/** Whether a gate has already cleared its threshold. `null` when unknown. */
export function gateMet(gate: Gate): boolean | null {
  switch (gate.reading.state) {
    case 'counted':
      return gate.reading.value >= gate.target
    case 'rate':
      return gate.reading.percent >= gate.target
    default:
      return null
  }
}
