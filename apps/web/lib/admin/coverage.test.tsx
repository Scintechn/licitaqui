import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CoverageCard } from '@/app/admin/coverage-card'
import { COVERAGE_THRESHOLD_HOURS, readCoverage, type Coverage } from './coverage'

/**
 * The coverage watchdog — card **B17**, watched the way **B37** watches the
 * price feeds.
 *
 * ## What these tests are for
 *
 * The defect this card exists against is not a wrong number, it is a **silence
 * read as health**. Measured 2026-10-05, `coverage_check` had run three times
 * ever, all on one keyword, and nothing read the result: its last row said the
 * B17 gap was closed and nobody would have noticed it coming back. That is
 * B32's shape, where a feed stopped on 2026-09-29 and 916 broken jobs looked
 * like silence for two days.
 *
 * So the assertions that matter are the ones about absence:
 *
 * - no row at all is `never`, not `fresh`;
 * - no **recent** row is `stale`, and `stale` must not read as `short` — the
 *   first says we do not know, the second says the Radar is short, and
 *   collapsing them loses the only distinction the card is for;
 * - a keyword that could not be measured leaves no row (an empty walk is never
 *   recorded, not even as 0%), so the absence is detected from `query_set` and
 *   reported rather than averaged away.
 *
 * ## Which test does which (`CLAUDE.md` §4c)
 *
 * The **mechanism** — the state machine, the precedence, the aggregation — is
 * here, with a fake executor and no database. The **SQL** is in
 * `coverage.db.test.ts`, because `feeds.db.test.ts` was written after a
 * mutation to B37's query left all ten of its fake-executor tests green. The
 * **rendering** is here too, through `renderToStaticMarkup`, which is this
 * repo's component-test idiom (`vitest.config.mts` has no jsdom).
 *
 * What none of them can cover: the card in a browser. `/admin` needs Postgres
 * and HTTP Basic, and the Playwright `journeys` project is hermetic by design,
 * so there is no e2e for `/admin` at all today — not for this card and not for
 * the three B37 cards beside it. The card is a server component with no
 * effects and no breakpoint above 720px inside a shell, which is exactly the
 * pair of defects §4c says the node environment cannot see, so the exposure is
 * stated rather than papered over.
 */

const NOW = new Date('2026-10-05T12:00:00Z')

type Row = Record<string, unknown>

function executor(rows: Row[]) {
  return { execute: async () => ({ rows }) } as never
}

const failing = {
  execute: async () => {
    throw new Error('boom')
  },
} as never

const SET = ['saas', 'merenda', 'pavimentacao', 'medicamento', 'papel', 'pneu', 'notebook']

const SEGMENT: Record<string, string> = {
  saas: 'Software / Sistemas',
  merenda: 'Alimentos',
  pavimentacao: 'Construção / Hidráulica',
  medicamento: 'Saúde / Hospitalar',
  papel: 'Gráfico / Escritório',
  pneu: 'Veículos / Peças',
  notebook: 'Informática / TI',
}

/** One `coverage_check` row, as the worker writes it. */
function row(q: string, over: Row = {}): Row {
  const held = 98
  const collected = 100
  return {
    q,
    segment: SEGMENT[q] ?? null,
    created_at: '2026-10-05T08:10:00Z',
    ratio: held / collected,
    held,
    collected,
    pncp_total: collected,
    target: 0.95,
    met: true,
    truncated: false,
    standing: true,
    query_set: SET,
    ...over,
  }
}

/** The whole standing set, all healthy, measured this morning. */
function healthy(): Row[] {
  return SET.map((q) => row(q))
}

/** `hours` before NOW, as the database would print it. */
function ago(hours: number): string {
  return new Date(NOW.getTime() - hours * 3_600_000).toISOString()
}

const read = (rows: Row[], now = NOW) => readCoverage(executor(rows), now)

describe('readCoverage', () => {
  it('is fresh when every keyword of the set answered inside the threshold', async () => {
    const coverage = await read(healthy())
    expect(coverage.reading.state).toBe('fresh')
    if (coverage.reading.state !== 'fresh') return
    expect(coverage.reading.summary.queries).toHaveLength(SET.length)
    expect(coverage.reading.summary.missing).toEqual([])
    expect(coverage.reading.summary.target).toBe(0.95)
  })

  it('has never measured when there is no row — which is not the same as healthy', async () => {
    const coverage = await read([])
    expect(coverage.reading.state).toBe('never')
  })

  it('reports an error as a state, never by throwing', async () => {
    const coverage = await readCoverage(failing, NOW)
    expect(coverage.reading.state).toBe('error')
    if (coverage.reading.state !== 'error') return
    // A code, never a driver message: this string is rendered.
    expect(coverage.reading.reason).toBe('query_failed')
  })

  it('is short when the weakest keyword is under target, however good the average', async () => {
    /**
     * The point of asking seven keywords. Six segments at 98% and one at 30%
     * averages to 88% — comfortably above nothing in particular — while a
     * company in that seventh segment is being shown a fraction of what is
     * open. The sentence is addressed to each company, so the worst decides.
     */
    const rows = healthy()
    rows[5] = row('pneu', { ratio: 0.3, held: 30, collected: 100, met: false })
    const coverage = await read(rows)

    expect(coverage.reading.state).toBe('short')
    if (coverage.reading.state !== 'short') return
    expect(coverage.reading.summary.worst.q).toBe('pneu')
    // The aggregate is printed, and it is deliberately not the pass.
    expect(coverage.reading.summary.ratio).toBeGreaterThan(0.85)
  })

  it('orders the keywords weakest first, so the reader starts at the problem', async () => {
    const rows = healthy()
    rows[3] = row('medicamento', { ratio: 0.5, held: 50, collected: 100, met: false })
    const coverage = await read(rows)
    if (coverage.reading.state !== 'short') throw new Error('expected short')
    expect(coverage.reading.summary.queries[0].q).toBe('medicamento')
  })

  it('reports the OLDEST current reading, not the newest', async () => {
    /**
     * The review's first finding, and the difference between a true sentence
     * and a false one. PNCP refuses six of the seven keywords for three
     * nights; the seventh keeps answering, so there is always a row minutes
     * old. Reporting the newest would print *"medido há 0 h, em 7
     * palavras-chave — todas na meta"* over a set six-sevenths of which had
     * not been measured since Tuesday.
     */
    const rows = SET.map((q) => row(q, { created_at: q === 'papel' ? ago(0.5) : ago(70) }))
    const coverage = await read(rows)

    expect(coverage.reading.state).toBe('fresh')
    if (coverage.reading.state !== 'fresh') return
    expect(Math.round(coverage.reading.hours)).toBe(70)

    const html = renderToStaticMarkup(<CoverageCard coverage={coverage} />)
    expect(html).toContain('mais antiga em uso tem 70 h')
    // The newest reading is minutes old. Printing it here is the false
    // sentence this test exists for.
    expect(html).not.toContain('mais antiga em uso tem 0 h')
  })

  it('goes incomplete once the keywords that stopped answering pass the threshold', async () => {
    // The same world one night later: six readings are now 94 h old.
    const rows = SET.map((q) => row(q, { created_at: q === 'papel' ? ago(0.5) : ago(94) }))
    const coverage = await read(rows)

    expect(coverage.reading.state).toBe('incomplete')
    if (coverage.reading.state !== 'incomplete') return
    expect(coverage.reading.summary.missing).toHaveLength(6)
    expect(coverage.reading.summary.queries).toHaveLength(1)
  })

  it('refuses to call one ad-hoc keyword healthy when no standing run is on record', async () => {
    /**
     * The review's second finding. The scheduled job is dead and its rows are
     * gone; somebody runs `check_coverage.py --commit --q saas`. That row is
     * a real measurement of one keyword, nothing is missing from a set of one,
     * and the card would have said **"em dia"** under a `source` line still
     * promising a daily run.
     *
     * A row carrying a `query_set` while no row is `standing` is evidence that
     * a standing set exists and that this is not it.
     */
    const coverage = await read([
      row('saas', { standing: false, query_set: ['saas'] }),
    ])

    expect(coverage.reading.state).toBe('adhoc_only')
    const html = renderToStaticMarkup(<CoverageCard coverage={coverage} />)
    expect(html).not.toContain('>em dia<')
    expect(html).toContain('>sem medição padrão<')
  })

  it('keeps an ad-hoc keyword out of the headline, the worst and the aggregate', async () => {
    /**
     * The review's fifth finding. `--q limpeza` coming back at 40% would have
     * become the card's `worst` and raised *"a lacuna do B17 voltou em
     * limpeza"* — a real alarm about a keyword the standing set never agreed a
     * target for, with its counts folded into *"no conjunto"*.
     */
    const rows = healthy()
    rows.push(
      row('limpeza', {
        standing: false,
        query_set: ['limpeza'],
        ratio: 0.4,
        held: 40,
        met: false,
        segment: 'Limpeza / Higiene',
      }),
    )
    const coverage = await read(rows)

    expect(coverage.reading.state).toBe('fresh')
    if (coverage.reading.state !== 'fresh') return
    expect(coverage.reading.summary.queries).toHaveLength(SET.length)
    expect(coverage.reading.summary.queries.map((q) => q.q)).not.toContain('limpeza')
    expect(coverage.reading.summary.collected).toBe(SET.length * 100)
  })

  it('is stale when the standing set has no current reading, however fresh an ad-hoc one is', async () => {
    const rows = SET.map((q) => row(q, { created_at: ago(24 * 9) }))
    rows.push(row('limpeza', { standing: false, query_set: ['limpeza'] }))
    const coverage = await read(rows)

    expect(coverage.reading.state).toBe('stale')
    if (coverage.reading.state !== 'stale') return
    // The last reading reported is the set's own, not the ad-hoc one.
    expect(SET).toContain(coverage.reading.last.q)
  })

  it('stays stale rather than becoming "nunca mediu" as the silence gets longer', async () => {
    /**
     * The review's fourth finding. With a 30-day lookback in the SQL, day 31
     * of a dead watchdog dropped every row out of the window and the card said
     * **"nunca mediu"** in grey — false, and the only transition in this file
     * where the alarm got *quieter* as the problem got older. Which is B32.
     */
    const coverage = await read(SET.map((q) => row(q, { created_at: ago(24 * 45) })))
    expect(coverage.reading.state).toBe('stale')

    const html = renderToStaticMarkup(<CoverageCard coverage={coverage} />)
    expect(html).not.toContain('nunca mediu')
    expect(html).toContain('45 dias')
  })

  it('discards a row that is not a measurement rather than reading it as 0%', async () => {
    /**
     * The `?? 0` the review found: a row carrying a ratio but no `held` or
     * `collected` rendered *"no conjunto 0% (0 de 0)"*. The SQL now guards all
     * three keys and this guards the parse, because a zero on this card means
     * the Radar holds none of them.
     */
    const rows = healthy().filter((r) => r.q !== 'pneu')
    rows.push(row('pneu', { held: null, collected: null, ratio: 0 }))
    const coverage = await read(rows)
    expect(coverage.reading.state).toBe('incomplete')
    if (coverage.reading.state !== 'incomplete') return
    expect(coverage.reading.summary.missing).toEqual(['pneu'])
  })

  it('is stale, not short, when nothing was measured inside the threshold', async () => {
    /**
     * **The distinction this card is built around.** A measurement that did
     * not happen is not a Radar that is short: one is a fact about the
     * watchdog, the other about the product. Reporting the first as the second
     * raises a false alarm about coverage; reporting it as `fresh` is how B32
     * lasted two days.
     */
    const old = '2026-09-26T08:10:00Z'
    const coverage = await read(SET.map((q) => row(q, { created_at: old })))

    expect(coverage.reading.state).toBe('stale')
    if (coverage.reading.state !== 'stale') return
    // And it carries what the last reading said, so the card can print
    // "98% há 9 dias" rather than "98%".
    expect(coverage.reading.last.ratio).toBe(0.98)
    expect(coverage.reading.hours).toBeGreaterThan(COVERAGE_THRESHOLD_HOURS)
  })

  it('stays stale even when the last reading was perfect', async () => {
    const coverage = await read([
      row('saas', { created_at: '2026-09-20T08:10:00Z', ratio: 1, held: 119, collected: 119 }),
    ])
    expect(coverage.reading.state).toBe('stale')
  })

  it('calls a run that lost a keyword incomplete, not fresh', async () => {
    /**
     * An empty walk is never recorded — not even as 0% — because PNCP
     * refusing an origin and the Radar holding nothing look identical from one
     * machine. So a keyword that cannot be measured leaves **no row**, and a
     * reader counting rows would see six keywords and call it a day. Every row
     * carries the set it belonged to for exactly this reason.
     */
    const rows = healthy().filter((r) => r.q !== 'pneu')
    const coverage = await read(rows)

    expect(coverage.reading.state).toBe('incomplete')
    if (coverage.reading.state !== 'incomplete') return
    expect(coverage.reading.summary.missing).toEqual(['pneu'])
  })

  it('prefers short over incomplete — the worse fact wins', async () => {
    const rows = healthy()
      .filter((r) => r.q !== 'pneu')
      .map((r) => (r.q === 'papel' ? row('papel', { ratio: 0.4, held: 40, met: false }) : r))
    const coverage = await read(rows)
    expect(coverage.reading.state).toBe('short')
  })

  it('does not let an ad-hoc single-keyword run redefine what complete means', async () => {
    /**
     * `check_coverage.py --commit --q limpeza` writes a real measurement whose
     * set is one keyword, and it is the newest row afterwards. Taking the set
     * from the newest row would make the card complete and green while six of
     * the seven keywords had not been measured for days — the exact absence
     * it is here to see. The set comes from the newest **standing** row.
     */
    const rows = healthy().filter((r) => r.q !== 'pneu')
    rows.push(
      row('limpeza', {
        created_at: '2026-10-05T11:00:00Z',
        standing: false,
        query_set: ['limpeza'],
        segment: 'Limpeza / Higiene',
      }),
    )
    const coverage = await read(rows)

    expect(coverage.reading.state).toBe('incomplete')
    if (coverage.reading.state !== 'incomplete') return
    expect(coverage.reading.summary.missing).toEqual(['pneu'])
  })

  it('reads the standing set from the row, so this file holds no copy of it', async () => {
    /**
     * `DEFAULT_QUERIES` lives in `coverage_check.py`. A second list here would
     * drift from it and the two would disagree about what "complete" means —
     * the shape D29 came from, two numbers chosen in different places that
     * never met. A set of three measured in full is complete.
     */
    const three = ['obra', 'cadeira', 'uniforme']
    const coverage = await read(three.map((q) => row(q, { query_set: three, standing: true })))
    expect(coverage.reading.state).toBe('fresh')
  })

  it('tolerates the rows written before `query_set` and `standing` existed', async () => {
    // The three rows of 2026-09-30 have neither field; they must not read as a
    // set of one keyword with six missing, and must not throw.
    const coverage = await read([row('saas', { query_set: null, standing: false })])
    expect(coverage.reading.state).toBe('fresh')
    // Distinct from the ad-hoc case above: there, a row *named* a set and this
    // was not it. Here no row names one at all, so there is nothing to be
    // incomplete against.
  })

  it('never reports a zero it was not given', async () => {
    /**
     * The worker refuses to write a 0% from an empty walk, and nothing here
     * may reconstruct one. With no measurement the headline is an em dash, not
     * a number — `memory: empty-result-is-not-absence`.
     */
    const coverage = await read([])
    const html = renderToStaticMarkup(<CoverageCard coverage={coverage} />)
    expect(html).not.toContain('0%')
    expect(html).toContain('—')
  })
})

describe('CoverageCard', () => {
  const cardFor = async (rows: Row[], now = NOW) =>
    renderToStaticMarkup(<CoverageCard coverage={await read(rows, now)} />)

  it('says "em dia" and names the weakest keyword when the set is healthy', async () => {
    const html = await cardFor(healthy())
    expect(html).toContain('em dia')
    expect(html).toContain('pior consulta')
    // Every keyword is listed with the segment it speaks for, because "pneu"
    // alone says less to a reader than "pneu · Veículos / Peças".
    expect(html).toContain('Veículos / Peças')
    // One decimal always: "95%" beside "meta 95%" with an "abaixo da meta"
    // badge was a real rendering of 0,9496 before the review caught it.
    expect(html).toContain('98,0%')
  })

  it('reads differently when short than when stale — the states are not interchangeable', async () => {
    const rows = healthy()
    rows[5] = row('pneu', { ratio: 0.3, held: 30, collected: 100, met: false })
    const short = await cardFor(rows)
    const stale = await cardFor(healthy().map((r) => ({ ...r, created_at: '2026-09-26T08:10:00Z' })))

    // The badge, matched as its own element: the stale note *mentions* the
    // phrase — "não é o mesmo que estar abaixo da meta" — on purpose, so a
    // bare substring match would pass while the card wore the wrong badge.
    expect(short).toContain('>abaixo da meta<')
    expect(short).toContain('A lacuna do B17 voltou')
    expect(short).not.toContain('>sem medição recente<')

    expect(stale).toContain('>sem medição recente<')
    expect(stale).toContain('aqui não sabemos')
    expect(stale).not.toContain('>abaixo da meta<')
  })

  it('counts the missing keywords against the standing set, not against what answered', async () => {
    /**
     * The denominator has to be the set the worker declared. An ad-hoc
     * `--q limpeza` measured today would otherwise be counted as an eighth
     * member of a set of seven, and the card would read "1 de 8".
     */
    const rows = healthy().filter((r) => r.q !== 'pneu')
    rows.push(
      row('limpeza', {
        created_at: '2026-10-05T11:00:00Z',
        standing: false,
        query_set: ['limpeza'],
      }),
    )
    const html = await cardFor(rows)
    expect(html).toContain('1 de 7 palavras-chave')
  })

  it('names the keyword that could not be measured rather than averaging it away', async () => {
    const html = await cardFor(healthy().filter((r) => r.q !== 'medicamento'))
    expect(html).toContain('medição incompleta')
    expect(html).toContain('medicamento')
    expect(html).toContain('sem medição')
  })

  it('prints the cadence and the clock, so the reading can be dated by hand', async () => {
    const html = await cardFor(healthy())
    expect(html).toContain('coverage_check')
    expect(html).toContain('05:10 BRT')
  })

  it('says the ratio is over the newest editais when the walk truncated', async () => {
    const rows = healthy()
    rows[4] = row('papel', { truncated: true })
    const html = await cardFor(rows)
    expect(html).toContain('mais recentes')
  })

  it('does not round a keyword up onto its own target', async () => {
    /**
     * Found by the review, verified in node: 0,9496 rendered as **"95%"**
     * beside *"meta 95%"* and a badge reading *"abaixo da meta"* — a card
     * contradicting itself on the one screen whose job is to be believed. A
     * decimal place is not the fix (94,96% still rounds to 95,0%); rounding
     * **down** is, and it is also the honest direction for a coverage figure.
     */
    const rows = healthy()
    rows[5] = row('pneu', { ratio: 0.9496, held: 9496, collected: 10_000, met: false })
    const html = await cardFor(rows)

    expect(html).toContain('>abaixo da meta<')
    expect(html).toContain('94,9%')
    expect(html).not.toContain('>95,0%<')
  })

  it('still prints a keyword that exactly meets the target as the target', async () => {
    // Flooring must not push a passing keyword under its own goal.
    const rows = healthy()
    rows[5] = row('pneu', { ratio: 0.95, held: 95, collected: 100, met: true })
    const html = await cardFor(rows)
    expect(html).toContain('>em dia<')
    expect(html).toContain('95,0%')
  })

  it("prints PNCP's own total on a truncated row, which is the only place it shows", async () => {
    /**
     * `pncpTotal` was read into the type and rendered nowhere — CLAUDE.md's
     * "a later in a comment is not a task" in its exact shape, and B41's card
     * calls this field "the only trace of the gap". A trace nobody can see is
     * not one.
     */
    const rows = healthy()
    rows[4] = row('papel', { truncated: true, pncp_total: 5000 })
    const html = await cardFor(rows)

    expect(html).toContain('mais recentes')
    expect(html).toContain('5.000 no PNCP')
  })

  it('states a stale age and its threshold in the same unit', async () => {
    // "há 3 dias · alerta depois de 3 dias" read as a contradiction at 73 h.
    const html = await cardFor(SET.map((q) => row(q, { created_at: ago(73) })))
    expect(html).toContain('há 73 h · alerta depois de 72 h')
  })

  it('never claims health from an error', async () => {
    const html = renderToStaticMarkup(<CoverageCard coverage={await readCoverage(failing, NOW)} />)
    expect(html).toContain('O silêncio não é prova de saúde')
    expect(html).not.toContain('em dia')
  })

  it('says it has never measured rather than showing nothing at all', async () => {
    const html = await cardFor([])
    expect(html).toContain('nunca mediu')
  })
})

/** Shape only, so a refactor cannot quietly drop the threshold's meaning. */
describe('the threshold', () => {
  it('is three cadences of a daily job — one missed run is not an alarm, three are', () => {
    const coverage: Coverage['thresholdHours'] = COVERAGE_THRESHOLD_HOURS
    expect(coverage).toBe(72)
  })
})
