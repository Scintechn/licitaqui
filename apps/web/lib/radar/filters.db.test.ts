import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, describe, it } from 'vitest'
import { closeDb, pool } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import type { TenderGroup } from './contract'
import { MODALITY_CODES, MODALITY_NAMES, type MeEppFilter, type ModalityFilter } from './filters'
import { countGroups, listTenders, type CompanyMatch, type TenderFilters } from './tenders'

/**
 * D52's two filters against a real Postgres, where the claims are actually
 * decidable.
 *
 * `filters.test.ts` pins the mechanism — which predicate is built, and that the
 * count query scopes `tenders` exactly as the page does. Three things it cannot
 * pin, because they are facts about Postgres and not about a string:
 *
 * 1. **`is distinct from` returns the rows PNCP is silent about — in both
 *    clauses.** 2 086 of today's open tenders have `me_epp_summary is null`.
 *    Under `<> 'exclusive'`, or under `not in ('exclusive','mixed')` — the easy
 *    spelling once `mixed` joined the positive side — every one of them vanishes
 *    from both buckets, and a row-count test stays green on a filter that hides
 *    8.4% of the Radar.
 * 2. **The tab count equals the page.** Asserted by comparing `countGroups` to
 *    the number of rows `listTenders` returns, for each group, under every
 *    combination — not by reading the SQL of either.
 * 3. **An unknown modality is still listed under *Todas*.** The list here holds
 *    three slugs; `worker/licitaqui/tenders.py` knows ten modality names and
 *    its sweep takes the set as a job payload, so the row below with
 *    `Leilão - Eletrônico` (id 1) is the fourth modality arriving.
 * 4. **The filter matches PNCP's code and survives PNCP re-wording the name.**
 *    Row 7 is a real `modality_id = 6` carrying `Pregão Eletrônico` — the same
 *    modality spelled without the hyphen, which is what the search endpoint
 *    could send any afternoon (`modalidade_licitacao_nome`, a different field
 *    from the detail API's `modalidadeNome`). It must still be found by the
 *    *Pregão* option, and a `modality_name = …` predicate would lose it.
 *
 * ## Isolation
 *
 * Every row is written under a per-**run** agency CNPJ and carries a nonsense
 * keyword unique to the run, and every query asks for that keyword — so the
 * assertions see this run's seven tenders and nothing else: no other lane's
 * fixtures, no seeded row, and no live sweep. A per-task constant would not do
 * (CLAUDE.md): four lanes are running against this database today.
 *
 * **Isolation runs the other way too, and that half was missed first.** The
 * `object` is the token and nothing else — it used to read `Aquisicao de <token>`,
 * which put two ordinary Portuguese words into the shared search index, where
 * `radar.db.test.ts` picks *"a distinctive word from the tender's own object"*
 * and asserts its own tender is on page 1 of 20. A word in common plus seven
 * extra rows is enough to push it off, and that suite failed once on exactly
 * that test while this file was being written. The deadline is also more than a
 * year out, so even a token collision would sort these rows behind everyone's.
 */

const url = testDatabaseUrl()
const suite = url ? describe : describe.skip
if (url) process.env.DATABASE_URL = url

const RUN = randomUUID().replace(/-/g, '').slice(0, 8)
/**
 * One word, no accents, in no edital anyone has ever published — and the whole
 * `object`, so this run adds no ordinary word to a shared index.
 */
const TOKEN = `zzdfiltro${RUN}`
const AGENCY = `52${randomUUID().replace(/\D/g, '').padEnd(12, '0').slice(0, 12)}`

/** Segment labels scoped to this run, so `grp` is decided by the fixtures. */
const COMPAT = `Teste D52 compat ${RUN}`
const CHECK = `Teste D52 check ${RUN}`

const MATCH: CompanyMatch = { compatible: [COMPAT], check: [CHECK], fits: [] }

type Row = {
  sequence: number
  /** PNCP's code — what the filter matches. */
  modalityId: number
  /** PNCP's text — what the card prints, and what the filter must not need. */
  modalityName: string
  meEpp: string | null
  segments: string[]
  group: TenderGroup
}

/**
 * Six tenders, chosen so that **every filter changes the group counts** — the
 * card's own acceptance criterion. Row 2 is the one that matters most: PNCP
 * published no ME/EPP regime for it at all.
 */
const PREGAO = MODALITY_CODES['pregao-eletronico']
const DISPENSA = MODALITY_CODES.dispensa
const CONCORRENCIA = MODALITY_CODES['concorrencia-eletronica']

const ROWS: Row[] = [
  { sequence: 1, modalityId: PREGAO, modalityName: MODALITY_NAMES['pregao-eletronico'], meEpp: 'exclusive', segments: [COMPAT], group: 'compatible' },
  { sequence: 2, modalityId: PREGAO, modalityName: MODALITY_NAMES['pregao-eletronico'], meEpp: null, segments: [COMPAT], group: 'compatible' },
  { sequence: 3, modalityId: DISPENSA, modalityName: MODALITY_NAMES.dispensa, meEpp: 'exclusive', segments: [CHECK], group: 'check' },
  { sequence: 4, modalityId: DISPENSA, modalityName: MODALITY_NAMES.dispensa, meEpp: 'none', segments: [], group: 'keyword' },
  { sequence: 5, modalityId: CONCORRENCIA, modalityName: MODALITY_NAMES['concorrencia-eletronica'], meEpp: 'mixed', segments: [COMPAT], group: 'compatible' },
  // The fourth modality, which this product's option list does not know.
  { sequence: 6, modalityId: 1, modalityName: 'Leilão - Eletrônico', meEpp: 'quota', segments: [], group: 'keyword' },
  // A Pregão Eletrônico whose *name* PNCP spelled differently. Same code.
  { sequence: 7, modalityId: PREGAO, modalityName: 'Pregão Eletrônico', meEpp: 'none', segments: [CHECK], group: 'check' },
]

const id = (row: Row) => `${AGENCY}-1-${String(row.sequence).padStart(6, '0')}/2026`

async function seed(): Promise<void> {
  for (const row of ROWS) {
    await pool().query(
      `insert into tenders (id, agency_cnpj, year, sequence, object, agency_name, city, state,
                            modality_id, modality_name, status, proposals_close_at,
                            me_epp_summary, segments, search, updated_at)
       values ($1, $2, 2026, $3, $4, 'Prefeitura de Teste', 'Campinas', 'SP',
               $5, $6, 'Divulgada no PNCP', now() + interval '400 days', $7, $8,
               to_tsvector('pt_unaccent', $4), now())
       on conflict (id) do nothing`,
      [
        id(row),
        AGENCY,
        row.sequence,
        TOKEN,
        row.modalityId,
        row.modalityName,
        row.meEpp,
        row.segments,
      ],
    )
  }
}

/** Only this run's rows can match, because only they carry the keyword. */
function filters(extra: Partial<TenderFilters> = {}): TenderFilters {
  return { q: TOKEN, limit: 50, ...extra }
}

async function idsIn(group: TenderGroup, extra: Partial<TenderFilters> = {}): Promise<string[]> {
  const page = await listTenders(MATCH, group, filters(extra))
  return page.tenders.map((tender) => tender.id).sort()
}

const expected = (predicate: (row: Row) => boolean, group: TenderGroup) =>
  ROWS.filter((row) => row.group === group && predicate(row))
    .map(id)
    .sort()

suite('D52 · the two filters, against Postgres', () => {
  beforeAll(seed)

  afterAll(async () => {
    await pool().query('delete from tenders where agency_cnpj = $1', [AGENCY])
    await closeDb()
  })

  it('*Todas* changes nothing, and lists the modality the option list does not know', async () => {
    expect(await countGroups(MATCH, filters())).toEqual({ compatible: 3, check: 2, keyword: 2 })
    // Row 6 is `Leilão - Eletrônico`. It is in the list, under *Todas*, because
    // *Todas* adds no predicate — not because this file knows about leilões.
    expect(await idsIn('keyword')).toEqual(expected(() => true, 'keyword'))
    expect(await idsIn('keyword')).toContain(id(ROWS[5]!))
  })

  it('filters by one exact modalidade', async () => {
    const only = { modality: 'dispensa' as ModalityFilter }
    expect(await countGroups(MATCH, filters(only))).toEqual({
      compatible: 0,
      check: 1,
      keyword: 1,
    })
    expect(await idsIn('check', only)).toEqual([id(ROWS[2]!)])
    expect(await idsIn('keyword', only)).toEqual([id(ROWS[3]!)])
    // And the unknown modality is gone the moment a modality is chosen, which
    // is the honest answer: it is not a Dispensa.
    expect(await idsIn('keyword', only)).not.toContain(id(ROWS[5]!))
  })

  it('finds a Pregão whose name PNCP spelled differently, because it matches the code', async () => {
    const only = { modality: 'pregao-eletronico' as ModalityFilter }
    // Row 7 is `modality_id = 6` with the name `Pregão Eletrônico` — no hyphen.
    // A `modality_name = 'Pregão - Eletrônico'` predicate loses it silently, and
    // the reader is told nothing is open.
    expect(await idsIn('check', only)).toEqual([id(ROWS[6]!)])
    expect(await countGroups(MATCH, filters(only))).toEqual({
      compatible: 2,
      check: 1,
      keyword: 0,
    })
  })

  it('*Exclusivo* is `exclusive` and `mixed`, and nothing else', async () => {
    const only = { meEpp: 'exclusive' as MeEppFilter }
    expect(await countGroups(MATCH, filters(only))).toEqual({
      compatible: 2,
      check: 1,
      keyword: 0,
    })
    // Row 1 is `exclusive`, row 5 is `mixed`.
    expect(await idsIn('compatible', only)).toEqual([id(ROWS[0]!), id(ROWS[4]!)].sort())
  })

  /**
   * Sci's ruling, 2026-10-06, asserted from both sides.
   *
   * A `mixed` edital has exclusive items, and its card says so — *Exclusivos e
   * cotas ME/EPP*. Under the first version of this filter it was in *Não
   * exclusivo*, which is the product contradicting itself on one screen. The
   * second half of this test is what fails if `mixed` is ever moved back.
   */
  it('puts a `mixed` tender under *Exclusivo* and never under *Não exclusivo*', async () => {
    const mixed = id(ROWS[4]!)
    expect(await idsIn('compatible', { meEpp: 'exclusive' })).toContain(mixed)
    expect(await idsIn('compatible', { meEpp: 'other' })).not.toContain(mixed)
  })

  /** A cota is not exclusivity, so `quota` stays on the other side. */
  it('leaves `quota` under *Não exclusivo*', async () => {
    const quota = id(ROWS[5]!)
    expect(await idsIn('keyword', { meEpp: 'other' })).toContain(quota)
    expect(await idsIn('keyword', { meEpp: 'exclusive' })).not.toContain(quota)
  })

  /**
   * The claim both `<> 'exclusive'` and `not in ('exclusive','mixed')` would
   * quietly break, each for the same reason: `unknown` is not `true`.
   */
  it('*Não exclusivo* includes the rows PNCP is silent about', async () => {
    const only = { meEpp: 'other' as MeEppFilter }
    const compatible = await idsIn('compatible', only)
    // Row 2 has `me_epp_summary is null`: no regime published.
    expect(compatible).toContain(id(ROWS[1]!))
    expect(compatible).toEqual([id(ROWS[1]!)])
    expect(await countGroups(MATCH, filters(only))).toEqual({
      compatible: 1,
      check: 1,
      keyword: 2,
    })
  })

  it('partitions the list exactly: *Exclusivo* + *Não exclusivo* = *Todas*', async () => {
    const all = await countGroups(MATCH, filters())
    const exclusive = await countGroups(MATCH, filters({ meEpp: 'exclusive' }))
    const other = await countGroups(MATCH, filters({ meEpp: 'other' }))
    for (const group of ['compatible', 'check', 'keyword'] as const) {
      expect(exclusive[group] + other[group], `${group} must not lose a row`).toBe(all[group])
    }
  })

  it('combines the two filters', async () => {
    const both = { modality: 'pregao-eletronico' as ModalityFilter, meEpp: 'other' as MeEppFilter }
    expect(await idsIn('compatible', both)).toEqual([id(ROWS[1]!)])
    expect(await countGroups(MATCH, filters(both))).toEqual({
      compatible: 1,
      check: 1,
      keyword: 0,
    })
  })

  /**
   * The card's first acceptance criterion, asserted the only way that proves
   * it: the number on the tab is counted, the rows on the page are counted, and
   * they are compared — under every combination, for all three groups.
   *
   * A filter that applied to the page and not to the count would pass every
   * other test in this file.
   */
  it.each([
    { modality: null, meEpp: null },
    { modality: 'dispensa', meEpp: null },
    { modality: 'pregao-eletronico', meEpp: 'exclusive' },
    { modality: 'concorrencia-eletronica', meEpp: 'other' },
    { modality: null, meEpp: 'other' },
    { modality: null, meEpp: 'exclusive' },
  ] as const)('the tab count is the page for %o', async (extra) => {
    const counts = await countGroups(MATCH, filters(extra))
    for (const group of ['compatible', 'check', 'keyword'] as const) {
      const page = await idsIn(group, extra)
      expect(counts[group], `${group} says ${counts[group]} and lists ${page.length}`).toBe(
        page.length,
      )
    }
    // …and the three tabs together are the whole filtered list, so no row is
    // counted twice or dropped between them.
    const total = counts.compatible + counts.check + counts.keyword
    expect(total).toBe(
      ROWS.filter(
        (row) =>
          (!extra.modality || row.modalityId === MODALITY_CODES[extra.modality]) &&
          (!extra.meEpp ||
            (extra.meEpp === 'exclusive'
              ? row.meEpp === 'exclusive' || row.meEpp === 'mixed'
              // `null !== 'exclusive'` is `true` in JavaScript, which is the
              // answer the two `is distinct from` clauses give in Postgres —
              // and the reason this expectation has to be written out rather
              // than taken from the same helper the query uses.
              : row.meEpp !== 'exclusive' && row.meEpp !== 'mixed')),
      ).length,
    )
  })
})
