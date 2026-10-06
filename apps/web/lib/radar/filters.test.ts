import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import type { Executor } from '@/lib/db'
import {
  ME_EPP_FILTERS,
  ME_EPP_OPTIONS,
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

/** The statement as Postgres would receive it, with its parameters. */
function render(chunk: Parameters<PgDialect['sqlToQuery']>[0]) {
  const query = dialect.sqlToQuery(chunk)
  return { sql: query.sql, params: query.params }
}

describe('the vocabulary', () => {
  it('maps every slug to one exact `modality_name`', () => {
    // The three values measured on Neon `main` on 2026-10-06 over all 57 878
    // rows. Spelled out rather than derived: if PNCP's wording changes, this
    // test is the thing that must fail, and a test that reads the same
    // constant it is checking cannot fail at all.
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
  it('matches one exact modality, as a bound parameter', () => {
    const query = render(modalityCondition('dispensa')!)
    expect(query.sql).toBe('t.modality_name = $1')
    expect(query.params).toEqual(['Dispensa'])
  })

  it('is no condition at all for *Todas*, so an unknown modality still shows', () => {
    expect(modalityCondition(null)).toBeNull()
    expect(modalityCondition(undefined)).toBeNull()
    expect(meEppCondition(null)).toBeNull()
    expect(meEppCondition(undefined)).toBeNull()
  })

  it('reads ME/EPP off `me_epp_summary` — the column the card tags', () => {
    expect(render(meEppCondition('exclusive')!).sql).toBe("t.me_epp_summary = 'exclusive'")
  })

  /**
   * The single most important line in the card: 2 105 of today's open tenders
   * have no `me_epp_summary` at all, and `<> 'exclusive'` is `unknown` for
   * every one of them. Asserted as code because the difference between the two
   * spellings is invisible in a row count.
   */
  it('includes the rows PNCP is silent about in *Não exclusivo*', () => {
    const query = render(meEppCondition('other')!)
    expect(query.sql).toBe("t.me_epp_summary is distinct from 'exclusive'")
    expect(query.sql).not.toContain('<>')
    expect(query.sql).not.toContain('!=')
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
  't.modality_name = ',
  "t.me_epp_summary = 'exclusive'",
  "t.me_epp_summary is distinct from 'exclusive'",
] as const

/**
 * The conditions one statement scopes `tenders` by.
 *
 * Read from `from tenders t` onwards, so the projection — which selects
 * `t.modality_name` and `t.me_epp_summary` as **columns** — cannot be mistaken
 * for a filter on them. That distinction is the whole point: the card shows
 * both values whether or not anybody is filtering on them.
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
      statements.push(dialect.sqlToQuery(chunk).sql)
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
      expect(scopeOf(statement)).toContain('t.modality_name = ')
      expect(scopeOf(statement)).toContain("t.me_epp_summary is distinct from 'exclusive'")
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
