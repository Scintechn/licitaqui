import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import type { Executor } from '@/lib/db'
import {
  ME_EPP_FILTERS,
  ME_EPP_OPTIONS,
  MODALITY_CODES,
  MODALITY_NAMES,
  MODALITY_OPTIONS,
  MODALITY_SLUGS,
  readMeEpp,
  readModality,
} from './filters'
import {
  countGroups,
  listTenders,
  meEppCondition,
  modalityCondition,
  type CompanyMatch,
  type TenderFilters,
} from './tenders'

/**
 * D52's two filters, as **mechanism**: the vocabulary, the two SQL predicates,
 * and the one fact the whole card turns on — that the tab count above the page
 * is filtered by exactly what the page is filtered by.
 *
 * What this file deliberately does not do is claim that Postgres returns the
 * rows these predicates describe. `is distinct from` including a null is a
 * fact about Postgres, not about this string, so it is asserted against a real
 * database in `filters.db.test.ts`; the layout of the five-control row is
 * measured in `e2e/journeys/radar-filters.spec.ts` (CLAUDE.md §4c: this runner
 * has no boxes). Here the assertions are on the code.
 */

const dialect = new PgDialect()

/**
 * The statement as Postgres would receive it, with its parameters.
 *
 * Whitespace collapsed, because the ME/EPP negative is two clauses written on
 * two lines and the assertions below are about the clauses, not the layout.
 */
function render(chunk: Parameters<PgDialect['sqlToQuery']>[0]) {
  const query = dialect.sqlToQuery(chunk)
  return { sql: query.sql.replace(/\s+/g, ' ').trim(), params: query.params }
}

describe('the vocabulary', () => {
  it('maps every slug to the PNCP code the sweep asks for', () => {
    // `DEFAULT_MODALITIES = (6, 8, 4)` in `worker/licitaqui/tenders.py` — the
    // three the sweep collects. Spelled out rather than derived: a test that
    // reads the same constant it is checking cannot fail at all.
    expect(MODALITY_CODES).toEqual({
      'pregao-eletronico': 6,
      'concorrencia-eletronica': 4,
      dispensa: 8,
    })
    expect(Object.keys(MODALITY_CODES).sort()).toEqual([...MODALITY_SLUGS].sort())
  })

  it('keeps the names for the labels, and only for the labels', () => {
    expect(MODALITY_NAMES).toEqual({
      'pregao-eletronico': 'Pregão - Eletrônico',
      'concorrencia-eletronica': 'Concorrência - Eletrônica',
      dispensa: 'Dispensa',
    })
    expect(Object.keys(MODALITY_NAMES).sort()).toEqual([...MODALITY_SLUGS].sort())
  })

  it('reads a known slug and refuses anything else', () => {
    expect(readModality('dispensa')).toBe('dispensa')
    expect(readModality(' DISPENSA ')).toBe('dispensa')
    expect(readModality('Dispensa ')).toBe('dispensa')
    // Not a slug: the filter is dropped rather than applied as something else.
    expect(readModality('leilao-eletronico')).toBeNull()
    expect(readModality('Pregão - Eletrônico')).toBeNull()
    expect(readModality('')).toBeNull()
    expect(readModality(null)).toBeNull()
  })

  it('reads the two ME/EPP choices and refuses anything else', () => {
    expect(ME_EPP_FILTERS).toEqual(['exclusive', 'other'])
    expect(readMeEpp('exclusive')).toBe('exclusive')
    expect(readMeEpp('other')).toBe('other')
    // `quota`, `mixed` and `none` are column values, not filter choices: the
    // product offers *Exclusivo* and *Não exclusivo*, and nothing else.
    expect(readMeEpp('quota')).toBeNull()
    expect(readMeEpp('none')).toBeNull()
    expect(readMeEpp(null)).toBeNull()
  })

  it('offers *Todas* first, with the empty value, on both selects', () => {
    // The empty value is what makes "no filter" the default and an unknown
    // modality visible: see `filters.ts`.
    expect(MODALITY_OPTIONS[0]?.value).toBe('')
    expect(ME_EPP_OPTIONS[0]?.value).toBe('')
    expect(MODALITY_OPTIONS.map((option) => option.value)).toEqual(['', ...MODALITY_SLUGS])
    expect(ME_EPP_OPTIONS.map((option) => option.value)).toEqual(['', ...ME_EPP_FILTERS])
    // The modality labels are PNCP's own words, the ones the tender screen
    // prints — not a second spelling in the catalogue.
    expect(MODALITY_OPTIONS.map((option) => option.label).slice(1)).toEqual(
      MODALITY_SLUGS.map((slug) => MODALITY_NAMES[slug]),
    )
  })
})

describe('the two predicates', () => {
  it('matches PNCP\'s code, not the text it writes beside it', () => {
    const query = render(modalityCondition('dispensa')!)
    expect(query.sql).toBe('t.modality_id = $1')
    expect(query.params).toEqual([8])
    // Asserted negatively too: `modality_name` is free text from two different
    // PNCP endpoints, and one re-worded hyphen would make this option find
    // nothing while the screen says nothing is open.
    expect(query.sql).not.toContain('modality_name')
  })

  it('is no condition at all for *Todas*, so an unknown modality still shows', () => {
    expect(modalityCondition(null)).toBeNull()
    expect(modalityCondition(undefined)).toBeNull()
    expect(meEppCondition(null)).toBeNull()
    expect(meEppCondition(undefined)).toBeNull()
  })

  /**
   * `mixed` is *Exclusivo* (Sci, 2026-10-06): the edital has exclusive items, so
   * it is part of the answer to "where do I get a reserved lane". Asserted as
   * the predicate rather than as a count, because the count would also pass if
   * `mixed` were in both buckets.
   */
  it('reads ME/EPP off `me_epp_summary`, and *Exclusivo* holds `mixed` too', () => {
    expect(render(meEppCondition('exclusive')!).sql).toBe(
      "t.me_epp_summary in ('exclusive', 'mixed')",
    )
  })

  /**
   * The single most important line in the card: 2 086 of today's open tenders
   * have no `me_epp_summary` at all, and **every** shorter spelling of this
   * predicate is `unknown` for all of them — `<> 'exclusive'`, and now
   * `not in ('exclusive','mixed')` as well, which is the easy mistake to make
   * when a second value joins the positive side. Asserted as code because the
   * difference between the spellings is invisible in a row count.
   */
  it('includes the rows PNCP is silent about in *Não exclusivo*', () => {
    const query = render(meEppCondition('other')!)
    expect(query.sql).toBe(
      "t.me_epp_summary is distinct from 'exclusive' " +
        "and t.me_epp_summary is distinct from 'mixed'",
    )
    // One `is distinct from` per excluded value, and no spelling that goes
    // `unknown` on a null.
    expect(query.sql.match(/is distinct from/g)).toHaveLength(2)
    expect(query.sql).not.toContain('<>')
    expect(query.sql).not.toContain('!=')
    expect(query.sql).not.toContain('not in')
  })
})

/**
 * `scope()` is private, so it is read where it is used: through the two
 * functions that must never disagree about it.
 *
 * A fake executor records the statement instead of running it. That is enough
 * for this question — *does the count see the same `where` as the page* — and
 * it is the question D52 turns on, because a filter that applies to the list
 * and not to "Compatíveis 13" above it is the defect the shared function was
 * written to prevent.
 */
const MATCH: CompanyMatch = { compatible: ['Informática / TI'], check: ['Alimentos'], fits: [] }

/**
 * Every condition `scope()` can add, spelled as it reaches Postgres.
 *
 * The comparison below is on this **set** rather than on the raw text, because
 * the two statements legitimately differ: they bind their parameters in a
 * different order (`$3` against `$4`) and one ends in `group by 1` where the
 * other ends in a cursor's `order by`. What must not differ is which of these
 * seven conditions each one applies.
 */
const CONDITIONS = [
  't.proposals_close_at > now()',
  't.state = ',
  't.search @@ websearch_to_tsquery',
  't.segments && ',
  't.modality_id = ',
  "t.me_epp_summary in ('exclusive', 'mixed')",
  "t.me_epp_summary is distinct from 'exclusive' and t.me_epp_summary is distinct from 'mixed'",
] as const

/**
 * The conditions one statement scopes `tenders` by.
 *
 * Read from `from tenders t` onwards, so the projection — which selects
 * `t.me_epp_summary` as a **column** — cannot be mistaken for a filter on it.
 * That distinction is the whole point: the card shows the value whether or not
 * anybody is filtering on it.
 */
function scopeOf(statement: string): string[] {
  const at = statement.indexOf('from tenders t')
  expect(at, 'every statement here reads from tenders').toBeGreaterThan(-1)
  const where = statement.slice(at)
  return CONDITIONS.filter((condition) => where.includes(condition))
}

function recorder() {
  const statements: string[] = []
  const executor = {
    execute(chunk: Parameters<PgDialect['sqlToQuery']>[0]) {
      // Whitespace collapsed for the same reason `render` does it: the ME/EPP
      // negative is two clauses on two lines, and `scopeOf` looks for both.
      statements.push(dialect.sqlToQuery(chunk).sql.replace(/\s+/g, ' '))
      return Promise.resolve({ rows: [] })
    },
  } as unknown as Executor
  return { statements, executor }
}

async function statementsFor(filters: TenderFilters) {
  const list = recorder()
  const counts = recorder()
  await listTenders(MATCH, 'compatible', filters, list.executor)
  await countGroups(MATCH, filters, counts.executor)
  expect(list.statements).toHaveLength(1)
  expect(counts.statements).toHaveLength(1)
  return { list: list.statements[0]!, counts: counts.statements[0]! }
}

describe('the counts are filtered by what the page is filtered by', () => {
  it('puts both conditions in the list query and in the count query', async () => {
    const { list, counts } = await statementsFor({
      q: 'papel',
      modality: 'dispensa',
      meEpp: 'other',
    })
    for (const statement of [list, counts]) {
      expect(scopeOf(statement)).toContain('t.modality_id = ')
      expect(scopeOf(statement)).toContain(
        "t.me_epp_summary is distinct from 'exclusive' and t.me_epp_summary is distinct from 'mixed'",
      )
    }
  })

  it('puts neither in either query when both are *Todas*', async () => {
    const { list, counts } = await statementsFor({ q: 'papel' })
    for (const statement of [list, counts]) {
      expect(scopeOf(statement)).toEqual([
        't.proposals_close_at > now()',
        't.search @@ websearch_to_tsquery',
      ])
    }
  })

  /**
   * The mutation this test exists to catch: a predicate added to the list query
   * **outside** `scope()` would satisfy the two tests above for the page and
   * leave the tab count unfiltered — which is exactly the defect that shared
   * function was written to prevent, and it would pass every other test in the
   * suite. So the two condition sets are compared to each other.
   */
  it.each([
    { modality: 'dispensa', meEpp: null },
    { modality: null, meEpp: 'exclusive' },
    { modality: 'pregao-eletronico', meEpp: 'other' },
    { modality: null, meEpp: null },
  ] as const)('scopes the count exactly as the page for %o', async (filters) => {
    const { list, counts } = await statementsFor({ q: 'papel', state: 'SP', ...filters })
    expect(scopeOf(counts)).toEqual(scopeOf(list))
  })
})
