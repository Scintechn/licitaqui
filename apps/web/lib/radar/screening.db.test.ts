import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, db, pool } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import { readLimit, FEATURES } from './quota'
import { readScreening, requestScreening, screeningAvailability } from './screening'

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

/** One visitor per run, so `usage` rows are isolated the way the tenders are. */
const VISITOR_ID = `00000000-0000-4000-8000-${RUN_ID}0000`

async function givenVisitor() {
  await pool().query('insert into visitors (id) values ($1) on conflict (id) do nothing', [
    VISITOR_ID,
  ])
}

async function givenSpentOn(tender: string) {
  await givenVisitor()
  await pool().query(
    `insert into usage (visitor_id, feature, reference) values ($1, $2, $3)`,
    [VISITOR_ID, FEATURES.screening, tender],
  )
}

async function usageCount(tender: string): Promise<number> {
  const found = await pool().query<{ n: string }>(
    'select count(*) as n from usage where visitor_id = $1 and reference = $2',
    [VISITOR_ID, tender],
  )
  return Number(found.rows[0]?.n ?? 0)
}

async function cleanup() {
  await pool().query('delete from events where name like $1', [`sync_files:${AGENCY_CNPJ}-%`])
  // `usage` cascades from `visitors`; `ai_analyses` cascades from `tenders`.
  await pool().query('delete from visitors where id = $1', [VISITOR_ID])
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

/**
 * What the Opportunity screen's button is allowed to say.
 *
 * Sci: *"I already have the AI Triage for this item … but the button remains
 * like the first time, for my user."* The screen had no way to know, so these
 * pin the two facts it now reads — and, with them, the answer to the question
 * the button turns on: **does opening a triagem whose analysis already exists
 * charge the user?**
 */
suite('screeningAvailability, and what a cached analysis costs', () => {
  beforeAll(() => {
    process.env.DATABASE_URL = url
  })
  beforeEach(cleanup)
  afterAll(async () => {
    await cleanup()
    await closeDb()
  })

  const spender = { visitorId: VISITOR_ID }
  const limit = () => readLimit('visitor', FEATURES.screening, db())

  it('is neither ready nor spent on a tender nobody has read', async () => {
    const tender = await givenTender(20)
    await givenVisitor()
    expect(await screeningAvailability(tender, spender, await limit(), db())).toEqual({
      ready: false,
      spent: false,
      // `visitor` is 2 per total, so this caller is metered.
      metered: true,
    })
  })

  /**
   * The case that decides the copy. `ai_analyses` has no `user_id` — the
   * reading is shared (§3.2) — but §10 allocates it per user, so a reading can
   * exist that this caller has not paid for. The button must not say "Ver".
   */
  it('is ready but not spent when somebody else paid for the reading', async () => {
    const tender = await givenTender(21)
    await givenAnalysis(tender, HASH_BEFORE, 'original')
    await givenSyncMarker(tender, HASH_BEFORE)
    await givenVisitor()

    expect(await screeningAvailability(tender, spender, await limit(), db())).toEqual({
      ready: true,
      spent: false,
      // `visitor` is 2 per total, so this caller is metered.
      metered: true,
    })
  })

  it('is ready and spent once this caller has paid — Sci’s case', async () => {
    const tender = await givenTender(22)
    await givenAnalysis(tender, HASH_BEFORE, 'original')
    await givenSyncMarker(tender, HASH_BEFORE)
    await givenSpentOn(tender)

    expect(await screeningAvailability(tender, spender, await limit(), db())).toEqual({
      ready: true,
      spent: true,
      // `visitor` is 2 per total, so this caller is metered.
      metered: true,
    })
  })

  /**
   * `ready` is not "a row exists", it is `readScreening`'s own predicate — so
   * a republished edital makes the button honest again without a second notion
   * of freshness being invented for it.
   */
  it('stops being ready when the agency replaces the documents', async () => {
    const tender = await givenTender(23)
    await givenAnalysis(tender, HASH_BEFORE, 'original')
    await givenSyncMarker(tender, HASH_AFTER)
    await givenSpentOn(tender)

    expect(await screeningAvailability(tender, spender, await limit(), db())).toEqual({
      ready: false,
      spent: true,
      // `visitor` is 2 per total, so this caller is metered.
      metered: true,
    })
    // …and it agrees with what the triagem screen would actually show.
    expect(await readScreening(tender, db())).toBeNull()
  })

  it('reports a paid plan as unmetered, straight from plan_limits', async () => {
    // `plan_limits` gives `promocional`, `essencial` and `pro` a null
    // quantity. The Opportunity screen used this to decide whether to print
    // "Usa 1 das suas triagens", and without it every founder who paid on the
    // morning of founders week was told a triagem spends an allowance their
    // plan does not have — under a button on a page whose own feature list
    // says "Triagens de edital sem limite".
    //
    // Read through `readLimit` rather than a literal, so a future row that
    // sets a real number on a paid plan turns this red instead of lying.
    const tender = await givenTender(25)
    for (const plan of ['promocional', 'essencial', 'pro']) {
      const paid = await readLimit(plan, FEATURES.screening, db())
      expect(paid.quantity, `${plan} should be unlimited in plan_limits`).toBeNull()
      const seen = await screeningAvailability(tender, spender, paid, db())
      expect(seen.metered, `${plan} must not be metered`).toBe(false)
    }

    const basic = await readLimit('basico', FEATURES.screening, db())
    expect(basic.quantity).toBe(5)
    expect((await screeningAvailability(tender, spender, basic, db())).metered).toBe(true)
  })

  it('never reports spent for a caller with no identity yet', async () => {
    const tender = await givenTender(24)
    await givenAnalysis(tender, HASH_BEFORE, 'original')
    expect(await screeningAvailability(tender, null, await limit(), db())).toEqual({
      ready: true,
      spent: false,
      // `visitor` is 2 per total, so this caller is metered.
      metered: true,
    })
  })

  /**
   * The charge itself, through the function the route calls — because the
   * button's warning is only honest if this is what happens.
   *
   * Reading a **cached** analysis you have not paid for **does** record usage:
   * `requestScreening` spends before it looks in the cache, which is §8's
   * "returns it and records usage" and §10's allowance counting editais read
   * rather than AI calls made. Reading it **again** is free.
   */
  it('charges a cached reading once, and never again for the same tender', async () => {
    const tender = await givenTender(25)
    await givenAnalysis(tender, HASH_BEFORE, 'original')
    await givenSyncMarker(tender, HASH_BEFORE)
    await givenVisitor()

    const first = await requestScreening(tender, spender, 'visitor', db())
    expect(first.state).toBe('ready')
    expect(await usageCount(tender)).toBe(1)

    const second = await requestScreening(tender, spender, 'visitor', db())
    expect(second.state).toBe('ready')
    // Still one: `spend()` de-duplicates on the tender id, which is why Sci
    // re-opening his own triagem costs him nothing.
    expect(await usageCount(tender)).toBe(1)
  })
})
