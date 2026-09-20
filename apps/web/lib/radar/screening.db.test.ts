import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db, pool } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import { readScreening } from './screening'

/**
 * `readScreening` and an amended tender (spec §3.2).
 *
 * The worker retires a superseded analysis by **key**, not by deleting it: the
 * digest of the tender's active document list is part of `ai_analyses`'s unique
 * key, so an errata produces a new row and leaves the old one in place. A read
 * that takes the newest usable row therefore serves the superseded analysis for
 * as long as nobody re-screens — which is the whole bug. These tests pin the
 * three cases: current, superseded, and never synced.
 *
 * `TEST_DATABASE_URL_FH` is this task's own isolated, migrated database. The
 * connection string is resolved programmatically and never printed. Without it
 * the file skips, so `pnpm test` stays green on a machine with no database —
 * and note that `ci-web.yml` deliberately runs with **no secrets at all**, so
 * this suite, like `radar.db.test.ts`, only really runs locally.
 *
 * Every row is scoped by a per-run id inside a fictitious agency CNPJ, so two
 * concurrent runs cannot delete each other's fixtures (CLAUDE.md).
 */

const url = testDatabaseUrl('TEST_DATABASE_URL_FH') ?? testDatabaseUrl()
const suite = url ? describe : describe.skip

/** Not a valid CNPJ. Per **run**, not per task: a task constant is not isolation. */
const RUN_ID = String(Math.floor(Math.random() * 1e8)).padStart(8, '0')
/** 14 digits: `99` + this run + a tail that keeps it clear of the worker's. */
const AGENCY_CNPJ = `99${RUN_ID}9995`

const MODE = 'lite'
const HASH_BEFORE = `fh-${RUN_ID}-before`
const HASH_AFTER = `fh-${RUN_ID}-after`

function tenderId(sequence: number) {
  return `${AGENCY_CNPJ}-1-${String(sequence).padStart(6, '0')}/2026`
}

async function givenTender(sequence: number): Promise<string> {
  const id = tenderId(sequence)
  await pool().query(
    `insert into tenders (id, agency_cnpj, year, sequence, object, state)
     values ($1, $2, 2026, $3, 'Aquisição de pilhas alcalinas', 'SP')
     on conflict (id) do nothing`,
    [id, AGENCY_CNPJ, sequence],
  )
  return id
}

async function givenAnalysis(tender: string, filesHash: string, note: string) {
  await pool().query(
    `insert into ai_analyses (tender_id, mode, model, prompt_version, extraction_version,
                              files_hash, status, result)
     values ($1, $2, 'test/model', 'lite-v2', 1, $3, 'ok', $4::jsonb)`,
    [tender, MODE, filesHash, JSON.stringify({ note })],
  )
}

/** What `licitaqui.files.mark_synced` writes after every `sync_files` run. */
async function givenSyncMarker(tender: string, filesHash: string) {
  await pool().query('delete from events where name = $1', [`sync_files:${tender}`])
  await pool().query('insert into events (name, props) values ($1, $2::jsonb)', [
    `sync_files:${tender}`,
    JSON.stringify({ tender_id: tender, files_hash: filesHash, invalidated: true }),
  ])
}

async function cleanup() {
  await pool().query('delete from events where name like $1', [`sync_files:${AGENCY_CNPJ}-%`])
  // `ai_analyses` cascades from `tenders`.
  await pool().query('delete from tenders where agency_cnpj = $1', [AGENCY_CNPJ])
}

suite('readScreening and the file list it was keyed on', () => {
  beforeAll(() => {
    process.env.DATABASE_URL = url
  })
  beforeEach(cleanup)
  afterAll(async () => {
    await cleanup()
    await closeDb()
  })

  it('serves the analysis when it is keyed on the current list', async () => {
    const tender = await givenTender(1)
    await givenAnalysis(tender, HASH_BEFORE, 'original')
    await givenSyncMarker(tender, HASH_BEFORE)

    const found = await readScreening(tender, db())
    expect(found?.status).toBe('ok')
    expect(found?.result).toEqual({ note: 'original' })
  })

  it('does not serve an analysis of documents the agency has replaced', async () => {
    const tender = await givenTender(2)
    await givenAnalysis(tender, HASH_BEFORE, 'original')
    await givenSyncMarker(tender, HASH_AFTER)

    // The row is still there — §3.2 keeps AI results for ever — it is simply
    // not this tender's current answer, so the caller queues a fresh screening.
    expect(await readScreening(tender, db())).toBeNull()
  })

  it('serves the new analysis once the worker has written it', async () => {
    const tender = await givenTender(3)
    await givenAnalysis(tender, HASH_BEFORE, 'original')
    await givenSyncMarker(tender, HASH_AFTER)
    await givenAnalysis(tender, HASH_AFTER, 'amended')

    const found = await readScreening(tender, db())
    expect(found?.result).toEqual({ note: 'amended' })
  })

  it('serves the old analysis again if the amendment itself is withdrawn', async () => {
    const tender = await givenTender(4)
    await givenAnalysis(tender, HASH_BEFORE, 'original')
    await givenAnalysis(tender, HASH_AFTER, 'amended')
    await givenSyncMarker(tender, HASH_BEFORE)

    // Reverting the list reverts the key, and the first analysis is a hit
    // again: correct, and free.
    const found = await readScreening(tender, db())
    expect(found?.result).toEqual({ note: 'original' })
  })

  it('falls back to the newest usable row when the list was never synced', async () => {
    const tender = await givenTender(5)
    await givenAnalysis(tender, HASH_BEFORE, 'original')

    // No marker: `sync_files` has not reached this tender (seed data, a fresh
    // collector). The filter must not be able to make a tender un-analysable.
    const found = await readScreening(tender, db())
    expect(found?.result).toEqual({ note: 'original' })
  })

  it('ignores a failed row, with or without a marker', async () => {
    const tender = await givenTender(6)
    await pool().query(
      `insert into ai_analyses (tender_id, mode, prompt_version, extraction_version,
                                files_hash, status)
       values ($1, $2, 'lite-v2', 1, $3, 'failed')`,
      [tender, MODE, HASH_BEFORE],
    )
    await givenSyncMarker(tender, HASH_BEFORE)

    expect(await readScreening(tender, db())).toBeNull()
  })
})
