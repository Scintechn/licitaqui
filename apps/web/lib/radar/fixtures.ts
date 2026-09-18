import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sql, type SQL } from 'drizzle-orm'
import { cnpjRef } from '@/lib/cnpj'
import type { Executor } from '@/lib/db'

/**
 * The seed fixtures, loaded into a test database under a per-run identity.
 *
 * Test support, imported only by `*.db.test.ts`. It is not `*.test.ts` itself,
 * so Vitest does not collect it, and nothing in `app/` may import it.
 *
 * ## Why these payloads and not hand-built rows
 *
 * `db/seed/fixtures/pncp/` holds 20 real PNCP responses captured by the POCs —
 * 940 items, five of the tenders still open, the rest closed, one with no
 * proposal dates at all, agencies in eleven states. Rows invented for a test
 * agree with whatever the test expects; these disagree, the way PNCP does, and
 * that is the point: the contract tests below run against the shapes the
 * product will actually meet.
 *
 * ## Why they are re-inserted rather than read where `pnpm db:seed` put them
 *
 * A seeded row's key is a real PNCP id, which is a **shared** natural key. Two
 * concurrent runs of this suite would classify, age and delete each other's
 * tenders — the failure mode CLAUDE.md names and this project has already paid
 * for four times. So every row here is scoped by `RUN_ID`, including the keys
 * that look like they could not be: the agency CNPJ inside the tender id, and
 * the company CNPJ the Radar searches for.
 *
 * ## The one transformation that must not drift
 *
 * PNCP sends **naive Brasília local time**. `db/seed.py` casts it with
 * `::timestamp at time zone 'America/Sao_Paulo'`, and so does this file. Left
 * as a bare `timestamptz` cast, Postgres would read `2026-09-28T08:30:00` as
 * UTC and store every deadline three hours early — on a product whose whole
 * promise is "before the deadline". `radar.db.test.ts` asserts the instant.
 */

/** Scopes every row this Vitest process creates. Per run, never per task. */
export const RUN_ID = randomUUID().replace(/-/g, '').slice(0, 8)

const RUN_NUMBER = Number.parseInt(RUN_ID, 16)

/**
 * The fictitious agency every fixture tender is re-published under, so cleanup
 * can delete exactly this run's rows. Mirrors `B2_CNPJ` in
 * `worker/tests/conftest.py`: 14 digits, matching nothing real in PNCP.
 */
export const RUN_AGENCY_CNPJ = `99${String(RUN_NUMBER).padStart(12, '0')}`.slice(0, 14)

/**
 * The company the Radar searches for. Unlike the agency this one must pass
 * `normaliseCnpj`, because it goes in through `POST /api/radar/cnpj` — so the
 * two check digits are computed rather than invented.
 */
export const RUN_COMPANY_CNPJ = withCheckDigits(`88${String(RUN_NUMBER).padStart(10, '0')}`.slice(0, 12))

/**
 * A second run-scoped company, for the tests that have to age a visitor.
 *
 * The 3-day window is counted per device **and** per CNPJ (§8, decision 5 in
 * §17), so back-dating one visitor of `RUN_COMPANY_CNPJ` expires every other
 * visitor of that CNPJ — including the ones later tests create. That is the
 * rule working; it just needs its own company to work on.
 */
export const RUN_EXPIRED_CNPJ = withCheckDigits(`77${String(RUN_NUMBER).padStart(10, '0')}`.slice(0, 12))

/** Every company key this run writes, for cleanup. */
export const RUN_CNPJS = [RUN_COMPANY_CNPJ, RUN_EXPIRED_CNPJ]

function withCheckDigits(base: string): string {
  const digit = (slice: string): number => {
    let weight = slice.length - 7
    let sum = 0
    for (const character of slice) {
      sum += Number(character) * weight
      weight -= 1
      if (weight < 2) weight = 9
    }
    const rest = sum % 11
    return rest < 2 ? 0 : 11 - rest
  }
  const first = digit(base)
  return `${base}${first}${digit(`${base}${first}`)}`
}

export type SeedFixture = {
  file: string
  /** The real PNCP id, for reference. Never inserted. */
  seedId: string
  /** The run-scoped id the row is inserted under. */
  id: string
  state: string | null
  object: string
  closeAt: string | null
  items: number
  det: Record<string, unknown>
  itens: Record<string, unknown>[]
}

const FIXTURES = fileURLToPath(new URL('../../../../db/seed/fixtures/pncp', import.meta.url))

/** The 20 captured PNCP payloads, re-keyed onto this run's agency. */
export function loadFixtures(): SeedFixture[] {
  return readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((file) => {
      const payload = JSON.parse(readFileSync(`${FIXTURES}/${file}`, 'utf8')) as {
        det: Record<string, unknown>
        itens: Record<string, unknown>[]
      }
      const det = payload.det
      const seedId = String(det.numeroControlePNCP)
      const unit = (det.unidadeOrgao ?? {}) as Record<string, unknown>
      return {
        file,
        seedId,
        // `<14-digit agency>-<digit>-<6-digit sequence>/<year>`: swap the agency
        // and the id stays a well-formed `numeroControlePNCP`, which the routes
        // validate before they will look at it.
        id: `${RUN_AGENCY_CNPJ}${seedId.slice(14)}`,
        state: (unit.ufSigla as string | undefined) ?? null,
        object: String(det.objetoCompra ?? ''),
        closeAt: (det.dataEncerramentoProposta as string | null) ?? null,
        items: payload.itens.length,
        det,
        itens: payload.itens,
      }
    })
}

/**
 * A Postgres array literal.
 *
 * Drizzle expands a bare JS array in a template into `($1, $2)` — a record, not
 * an array — so `= any(${list}::text[])` fails with "cannot cast type record".
 * Building the `array[...]` by hand is the spelling that works.
 */
function pgArray(values: readonly string[], type: 'text' | 'char(14)'): SQL {
  if (values.length === 0) return sql.raw(`array[]::${type}[]`)
  return sql`array[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::${sql.raw(type)}[]`
}

/** PNCP `tipoBeneficio`: 1 = exclusive to ME/EPP, 2 = reserved quota. */
function meEppSummary(items: Record<string, unknown>[]): string {
  const codes = new Set(items.map((item) => item.tipoBeneficio))
  const exclusive = codes.has(1)
  const quota = codes.has(2)
  if (exclusive && quota) return 'mixed'
  if (exclusive) return 'exclusive'
  if (quota) return 'quota'
  return 'none'
}

export type InsertOptions = {
  /**
   * The segments to write onto the tender and its items. `sync_items` (task B3)
   * derives these from the items' NCM codes and descriptions; the fixtures were
   * captured before that ran, so a test that needs a classified tender says so
   * explicitly. Testing the classifier is `worker/tests/test_segments.py`'s job;
   * testing the join is this suite's.
   */
  segments?: string[]
  /** Back-date `tenders.updated_at` and every item's, to age the row. */
  updatedAt?: Date
}

/**
 * Insert one fixture, header and items, the way `db/seed.py` does.
 *
 * Not a Drizzle `insert()`: the timezone cast and the `to_tsvector` call have
 * no query-builder spelling, and writing them out is exactly what keeps this
 * agreeing with `db/seed.py`.
 */
export async function insertFixture(
  executor: Executor,
  fixture: SeedFixture,
  options: InsertOptions = {},
): Promise<void> {
  const det = fixture.det
  const unit = (det.unidadeOrgao ?? {}) as Record<string, unknown>
  const organisation = (det.orgaoEntidade ?? {}) as Record<string, unknown>
  const segments = options.segments ?? null
  const updatedAt = options.updatedAt ?? null

  await executor.execute(sql`
    insert into tenders (
      id, agency_cnpj, year, sequence, object, agency_name, unit_name, city, state,
      modality_id, modality_name, status, price_registration,
      proposals_open_at, proposals_close_at, estimated_value, confidential_budget,
      bidding_system_url, me_epp_summary, segments, pncp_updated_at, raw, updated_at
    ) values (
      ${fixture.id}, ${RUN_AGENCY_CNPJ}, ${det.anoCompra ?? null}, ${det.sequencialCompra ?? null},
      ${fixture.object}, ${organisation.razaoSocial ?? null}, ${unit.nomeUnidade ?? null},
      ${unit.municipioNome ?? null}, ${fixture.state},
      ${det.modalidadeId ?? null}, ${det.modalidadeNome ?? null}, ${det.situacaoCompraNome ?? null},
      ${det.srp ?? null},
      -- PNCP sends naive Brasília local time. Read as UTC it would be three
      -- hours early; db/seed.py makes the same cast for the same reason.
      ${det.dataAberturaProposta ?? null}::timestamp at time zone 'America/Sao_Paulo',
      ${fixture.closeAt}::timestamp at time zone 'America/Sao_Paulo',
      ${det.valorTotalEstimado ?? null}, ${det.orcamentoSigilosoCodigo !== 1},
      ${det.linkSistemaOrigem ?? null}, ${meEppSummary(fixture.itens)},
      ${segments === null ? sql`null::text[]` : pgArray(segments, 'text')},
      ${det.dataAtualizacaoGlobal ?? det.dataAtualizacao ?? null}::timestamp at time zone 'America/Sao_Paulo',
      ${JSON.stringify(det)}::jsonb,
      coalesce(${updatedAt?.toISOString() ?? null}::timestamptz, now())
    )
    on conflict (id) do nothing
  `)

  // One statement for every item, not one per item: 163 round trips to a
  // remote Neon for a single tender is the difference between a suite that
  // runs and a suite that times out.
  if (fixture.itens.length > 0) {
    const rows = fixture.itens.map(
      (item) => sql`(
        ${fixture.id}, ${item.numeroItem ?? null}, ${item.descricao ?? null},
        ${String(item.materialOuServico ?? '').slice(0, 1) || null},
        ${item.quantidade ?? null}, ${String(item.unidadeMedida ?? '').trim() || null},
        ${item.valorUnitarioEstimado ?? null}, ${item.valorTotal ?? null},
        ${item.ncmNbsCodigo ?? null}, ${item.criterioJulgamentoNome ?? null},
        ${item.tipoBeneficio ?? null}, ${item.tipoBeneficioNome ?? null},
        ${segments?.[0] ?? null}, ${item.temResultado ?? null},
        ${JSON.stringify(item)}::jsonb,
        coalesce(${updatedAt?.toISOString() ?? null}::timestamptz, now())
      )`,
    )
    await executor.execute(sql`
      insert into tender_items (
        tender_id, number, description, kind, quantity, unit, unit_estimated_value,
        total_value, ncm, judgment_criterion, benefit_id, benefit_name, segment,
        has_award, raw, updated_at
      ) values ${sql.join(rows, sql`, `)}
      on conflict (tender_id, number) do nothing
    `)
  }

  // The `pt_unaccent` vector over the object plus every item description — the
  // index `GET /api/radar/tenders?q=` searches. Same statement as `db/seed.py`.
  await executor.execute(sql`
    update tenders t set search = to_tsvector('pt_unaccent',
      coalesce(t.object, '') || ' ' ||
      coalesce((select string_agg(i.description, ' ') from tender_items i
                 where i.tender_id = t.id), ''))
     where t.id = ${fixture.id}
  `)
}

/**
 * Delete everything this run created. Keyed on the run-scoped agency and
 * company, so it can never touch another run's rows — or a real one's.
 *
 * `tender_items`, `tender_files` and `ai_analyses` go with the tender and
 * `usage` goes with the visitor, by `on delete cascade`. `events.visitor_id` is
 * `on delete set null`, so those rows are deleted first and by hand.
 */
export async function cleanupRun(executor: Executor): Promise<void> {
  await executor.execute(sql`
    delete from events
     where visitor_id in (select id from visitors where cnpj = any(${pgArray(RUN_CNPJS, 'char(14)')}))
        or props->>'tender_id' like ${`${RUN_AGENCY_CNPJ}-%`}
  `)
  await executor.execute(sql`delete from visitors where cnpj = any(${pgArray(RUN_CNPJS, 'char(14)')})`)
  await executor.execute(sql`delete from companies where cnpj = any(${pgArray(RUN_CNPJS, 'char(14)')})`)
  await executor.execute(sql`delete from tenders where agency_cnpj = ${RUN_AGENCY_CNPJ}`)
  await executor.execute(sql`
    delete from jobs
     where key like ${`%${RUN_AGENCY_CNPJ}%`}
        or key = any(${pgArray(
          RUN_CNPJS.map((cnpj) => `company:${cnpjRef(cnpj)}`),
          'text',
        )})
  `)
}
