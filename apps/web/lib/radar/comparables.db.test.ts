import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, db } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import { comparablesForItem } from './comparables'
import { RUN_ID } from './fixtures'
import { priceBand } from './price-band'

/**
 * `comparablesForItem` against the real database, the real SQL and the real
 * product gate.
 *
 * ## Why this file exists
 *
 * Because nothing exercised that function. `app/api/tenders/[id]/band/route.test.ts`
 * mocks `@/lib/radar/comparables`, so the gate is invisible to it; there is no
 * e2e journey that touches a band, and `e2e/fixtures/world.ts` never seeds
 * `awards`. The only coverage of the gate was `product-key.test.ts`, a pure
 * string test — which means **every claim of the form "this is what the query
 * now returns" was reproducible only by hand**, and a mistake in how the
 * filter was wired into `comparablesForItem` would have been invisible to a
 * green suite. That is CLAUDE.md §4b's pattern exactly, and a review caught it
 * here rather than production.
 *
 * ## Isolation
 *
 * The query joins candidates on `j.segment = s.segment`, so a **segment string
 * unique to this run** is a complete isolation boundary: no row another run
 * inserted can be a candidate for these, and no row of these can be a
 * candidate for another run's. That is stronger than deleting by prefix
 * afterwards, and it is per-run rather than per-task — the failure CLAUDE.md
 * names, where two concurrent runs of one suite delete each other's fixtures.
 */

const url = testDatabaseUrl('TEST_DATABASE_URL_R2') ?? testDatabaseUrl()
const suite = url ? describe : describe.skip

/** Nothing outside this run shares it, so nothing outside this run can match. */
const SEGMENT = `Teste comparáveis ${RUN_ID}`
const UNIT = 'Unidade'
const TENDER = `99${RUN_ID}000000-1-000001/2026`

/** One awarded item in a tender of its own, so each counts as a distinct edital. */
async function award(n: number, description: string, value: number): Promise<void> {
  // `tenders` is unique on (agency_cnpj, year, sequence), so the sequence has
  // to be distinct from the subject's and from every sibling's — the id alone
  // is not the only key.
  const sequence = n + 10
  const id = `99${RUN_ID}${String(sequence).padStart(6, '0')}-1-${String(sequence).padStart(6, '0')}/2026`
  await db().execute(sql`
    insert into tenders (id, agency_cnpj, year, sequence, object)
    values (${id}, ${`99${RUN_ID}000000`.slice(0, 14)}, 2026, ${sequence}, 'fixture')
    on conflict (id) do nothing`)
  await db().execute(sql`
    insert into tender_items (tender_id, number, description, segment, unit)
    values (${id}, 1, ${description}, ${SEGMENT}, ${UNIT})
    on conflict (tender_id, number) do nothing`)
  await db().execute(sql`
    insert into awards (tender_id, item_number, unit_awarded_value, awarded_on, quality)
    values (${id}, 1, ${value}, now() - interval '2 months', 'OK')
    on conflict do nothing`)
}

suite('comparablesForItem, against the database', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = url
    await db().execute(sql`
      insert into tenders (id, agency_cnpj, year, sequence, object)
      values (${TENDER}, ${`99${RUN_ID}000000`.slice(0, 14)}, 2026, 1, 'fixture')
      on conflict (id) do nothing`)
    // **The real descriptions, verbatim.** The first version of this file
    // used short hand-written ones and passed with the gate removed: PNCP
    // strings are long, and it is their shared attribute scaffolding that
    // carries them over the 0.3 trigram floor. Short fixtures never reach
    // it, so the query returned nothing to filter and the test proved
    // nothing — the same shape the review had just found in an e2e spec.
    await db().execute(sql`
      insert into tender_items (tender_id, number, description, segment, unit)
      values (${TENDER}, 37, 'Perfurador Papel material: ferro fundido, tipo: mesa, capacidade perfuração: 100, funcionamento: manual, características adicionais: furo redondo, margeador, regulagem de profundidade, quantidade furos: 2', ${SEGMENT}, ${UNIT})
      on conflict (tender_id, number) do nothing`)

    // Five cadernos and a roll of toilet paper, in six editais, at prices
    // tight enough to clear `MAX_SPREAD` — the set that produced R$ 9,35.
    await award(1, 'Caderno características adicionais: brochura, capa dura, costurado, comprimento: 200, gramatura folhas: 56, largura: 140, material: papel off-set, material capa: papelão revestida com papel-couché, quantidade folhas: 96, tipo: 1/4', 4.85)
    await award(2, 'Caderno tipo: 1/4, material: papel off-set, gramatura folhas: 56, material capa: papelão revestida com papel-couché, comprimento: 200, largura: 140, quantidade folhas: 96, características adicionais: brochura, capa dura, costurado', 8.9)
    await award(3, 'Caderno características adicionais: lombada em espiral, personalizado, 4x0 cores, acab, comprimento: 14,8, largura: 21, material: papel off-set, material capa: papelão, quantidade folhas: 70, tipo: capa dura', 9.6)
    await award(4, 'Caderno tipo: horizontal sem pauta, material: celulose vegetal, gramatura folhas: 56, gramatura capa: 63, material capa: papelão, comprimento: 275, largura: 200, quantidade folhas: 96, características adicionais: brochura, capa dura com laminação brilho', 9.64)
    await award(5, 'Papel Higiênico material: celulose virgem, comprimento: 30, largura: 10, tipo: picotado, quantidade folhas: dupla, cor: branca, características adicionais: extra macio e sem perfume', 11.15)
    // And the one real punch, at twenty times their price, which had the
    // *lowest* similarity of the eleven and was outvoted.
    await award(6, 'PERFURADOR DE PAPEL 02 FUROS DE AÇO FUNDIDO RESISTENTE COM CAPACIDADE PARA 100 FOLHAS', 204)
    await award(7, 'Perfurador Papel material: metal, tipo: pequeno, tratamento superficial: pintado, capacidade perfuração: 10, funcionamento: manual', 10.35)
  })

  afterAll(async () => {
    await db().execute(sql`delete from awards where tender_id like ${`99${RUN_ID}%`}`)
    await db().execute(sql`delete from tender_items where tender_id like ${`99${RUN_ID}%`}`)
    await db().execute(sql`delete from tenders where id like ${`99${RUN_ID}%`}`)
    await closeDb()
  })

  it('returns only the punch, not the five cadernos', async () => {
    const found = await comparablesForItem(TENDER, 37)
    expect(found.map((c) => c.unitAwardedValue).sort((a, b) => a - b)).toEqual([10.35, 204])
  })

  /**
   * The assertion that matters, and the one no string test can make: with the
   * gate, this item shows **nothing** rather than a confident wrong number.
   *
   * Without it the five cadernos are five editais with a spread of nothing —
   * `MIN_SAMPLE` met, `MAX_SPREAD` passed — and the screen would quote a band
   * around R$ 10 for a punch the edital values at R$ 168,78.
   */
  it('produces no band at all, where the cadernos would have made a confident one', async () => {
    expect(priceBand(await comparablesForItem(TENDER, 37))).toBeNull()
  })

  /**
   * The gate must not be doing this by returning nothing for everybody: an
   * item whose comparables really are the same product still gets them.
   */
  it('still prices an item whose comparables are the same product', async () => {
    await db().execute(sql`
      insert into tender_items (tender_id, number, description, segment, unit)
      values (${TENDER}, 38, 'Caderno tipo: 1/4, material: papel off-set, gramatura folhas: 56, material capa: papelão revestida com papel-couché, comprimento: 200, largura: 140, quantidade folhas: 96, características adicionais: brochura, capa dura, costurado', ${SEGMENT}, ${UNIT})
      on conflict (tender_id, number) do nothing`)

    const found = await comparablesForItem(TENDER, 38)
    // The four other cadernos — not the toilet paper, not either punch.
    expect(found).toHaveLength(4)
    expect(Math.max(...found.map((c) => c.unitAwardedValue))).toBeLessThan(11)
  })
})
