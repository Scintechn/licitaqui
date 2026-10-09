import { FOUNDERS } from '@/lib/product'
import { sql } from 'drizzle-orm'
import { db, type Executor } from '@/lib/db'

/**
 * The six Phase 0 gate numbers (spec §14, gate date 2026-11-06):
 *
 * > founders signed up (≥ 150), CNPJs searched (≥ 300), Telegram linked
 * > (≥ 100), concierge users paying (≥ 6 of 20), founder seats paid (≥ 15 of
 * > seats), weekly digest open rate (≥ 50%).
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
  | 'cnpj_search_count'
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
  /**
   * The Phase 0 threshold, or `null` for a card that reports a number nobody
   * set a bar for. **Nullable rather than 0**: a `meta ≥ 0` is a bar that is
   * always met, which is the D4d mistake — when a limit turns out not to
   * exist, change the shape, not the constant. The card draws no target and
   * no badge for a `null`.
   */
  target: number | null
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
 * Distinct businesses looked up — one row per CNPJ anybody has ever entered.
 *
 * **Corrected 2026-10-09. The old query counted identities, not searches, and
 * could not move for a returning searcher.** It was the union of
 * `visitors.cnpj` and `users.cnpj`, which is *the CNPJ currently attached to
 * each identity* — one per row, and **both writers cap it at one**:
 *
 *  - `rememberUserCnpj` (`lib/auth/session.ts`) is `update users set cnpj = …
 *    where … and cnpj is null`. It only ever fills a NULL. That is E3's
 *    deliberate ruling — *changing a company is an account setting, not a side
 *    effect of one search* — so it is the gate that was wrong, not the writer.
 *    A signed-in person with a CNPJ already set moves this number **never**.
 *  - `attachCnpj` (`lib/radar/visitor.ts`) overwrites the visitor's row, so a
 *    browser that searches ten businesses still contributes one.
 *
 * Found by Sci on 2026-10-09: he searched several different CNPJs and the card
 * stayed at 13.
 *
 * **Why `companies` and not the `cnpj_searched` event.** The event is fired on
 * every search and is the right source for *how many searches* (see
 * `cnpjSearchCount`), but it deliberately keeps the CNPJ out of `props`, so it
 * cannot answer *how many distinct businesses*. `companies` can: it is the
 * BrasilAPI cache, its primary key **is** the CNPJ, and `ensureCompanyRow`
 * inserts into it on the search path with `on conflict do nothing`. Counting
 * it needs no new column, no new event, and loses no history — every business
 * ever searched already has its row.
 *
 * It also counts a CNPJ saved on an account at `/conta/empresa`, which takes
 * the same path. That is still a business somebody entered, which is what the
 * gate asks.
 */
async function cnpjsSearched(database: Executor): Promise<GateReading> {
  const value = await scalar(database, sql`select count(*)::text as value from companies`)
  return { state: 'counted', value }
}

/**
 * How many CNPJ searches were made — the activity number beside the reach one.
 *
 * `POST /api/radar/cnpj` records `cnpj_searched` on every search, including
 * repeats and including a CNPJ already cached, so this moves when
 * `cnpjsSearched` correctly does not. Two people searching the same business
 * is two here and one there, and the pair is more useful than either alone.
 *
 * **No target.** Gate 0 asks for ≥ 300 *businesses*; this is context for that
 * number, not a second bar to clear — and it counts our own testing too.
 */
async function cnpjSearchCount(database: Executor): Promise<GateReading> {
  const value = await scalar(
    database,
    sql`select count(*)::text as value from events where name = 'cnpj_searched'`,
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
 * An active subscription on the Promocional plan — the founder price only a
 * seat can buy (§10, and `docs/product.json` for what it is; this comment used
 * to name R$ 26, which stopped being the price on 2026-10-05).
 *
 * **F2 settled the vocabulary, so this narrowed from `in ('active',
 * 'confirmed')` to `= 'active'`.** `status` is now our own five-word
 * vocabulary rather than Asaas's, held by `0015`'s CHECK, and `confirmed` is
 * not in it: an Asaas subscription is `ACTIVE` from the moment it is created,
 * before anybody has paid, so storing Asaas's own word here would have made
 * this gate count unpaid signups. `pending` is a created-and-unpaid
 * subscription and this does not count it, which is the whole point of the
 * separate vocabulary.
 *
 * `confirmed` was a guess made before any of that existed; nothing has ever
 * written it, and the CHECK would now refuse it. A branch that can never match
 * is worse than no branch, because it reads as cover.
 *
 * `lower(...)` stays: it costs nothing and the column has no CHECK on case.
 */
async function founderSeatsPaid(database: Executor): Promise<GateReading> {
  const value = await scalar(
    database,
    sql`
      select count(*)::text as value
        from subscriptions
       where lower(coalesce(plan, '')) = 'promocional'
         and lower(coalesce(status, '')) = 'active'
    `,
  )
  // **Not a literal.** This read "of: 48" while `docs/product.json` sells 25,
  // so the Gate 0 dashboard measured paid founders against a denominator the
  // product does not have. Third category of the same leak found on
  // 2026-09-29, after the account page and the opening e-mail — and the only
  // one of the three that was executable rather than prose.
  return { state: 'counted', value, of: FOUNDERS.seatsTotal }
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
  const [founders, cnpjs, searches, telegram, seats, digest] = await Promise.all([
    attempt(() => foundersSignedUp(database)),
    attempt(() => cnpjsSearched(database)),
    attempt(() => cnpjSearchCount(database)),
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
      source: 'Linhas em companies: um CNPJ distinto por empresa pesquisada.',
      reading: cnpjs,
    },
    {
      key: 'cnpj_search_count',
      label: 'Buscas por CNPJ',
      target: null,
      unit: 'count',
      source: 'Eventos cnpj_searched, repetições incluídas.',
      reading: searches,
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
      targetOf: FOUNDERS.seatsTotal,
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

/**
 * Whether a gate has already cleared its threshold. `null` when unknown.
 *
 * **A gate with no target is `null`, not `true`.** It has nothing to clear, so
 * "met" is not false — it is not a question. Returning `true` would accent the
 * card and badge it as passed on a number nobody set a bar for.
 */
export function gateMet(gate: Gate): boolean | null {
  if (gate.target === null) return null
  switch (gate.reading.state) {
    case 'counted':
      return gate.reading.value >= gate.target
    case 'rate':
      return gate.reading.percent >= gate.target
    default:
      return null
  }
}
