import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeDb, pool } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import { recordEvent } from '@/lib/events'
import { signupInput } from '@/lib/founders/input'
import { DUPLICATE_EVENT, signUpFounder, SIGNUP_EVENT } from '@/lib/founders/signup'
import { foundersCsv, listAllFounders, listFounders, countFounders } from './founders'
import { readGates } from './gates'
import { databaseSizeBytes, readNeonUsage } from './neon'

/**
 * The `/admin` reads, against a real Postgres.
 *
 * The connection string comes from `TEST_DATABASE_URL_O1` — task O1's own
 * migrated database — resolved programmatically and never printed. Without it
 * the file skips, so `pnpm test` stays green on a machine or a CI job with no
 * database.
 *
 * Unlike F1's suite this one does not demand an empty `founders_list`: it
 * measures **deltas** around the rows it inserts and deletes only those, so it
 * is safe to run against a database that already has data in it.
 */

const url = testDatabaseUrl('TEST_DATABASE_URL_O1') ?? testDatabaseUrl()
const suite = url ? describe : describe.skip

/** `.invalid` can never resolve (RFC 2606): no real person is ever mailed. */
const DOMAIN = 'o1.test.licitaqui.invalid'

/** A real, checksum-valid CNPJ (the Banco Central's). The column is not unique. */
const CNPJ = '00.394.429/0001-00'

/** Tags every event this file writes, so cleanup can find them and only them. */
const MARKER = `o1-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

function founder(index: number, name = `Fundador O1 ${index}`) {
  return signupInput.parse({
    name,
    email: `o1-${MARKER}-${index}@${DOMAIN}`,
    whatsapp: `(11) 9${String(index).padStart(8, '0')}`,
    cnpj: CNPJ,
    sells: 'material de escritório',
    source: 'o1-test',
    contactConsent: true,
    acceptedTerms: true,
  })
}

async function cleanup(): Promise<void> {
  const ids = (
    await pool().query<{ id: string }>('select id from founders_list where email like $1', [
      `%@${DOMAIN}`,
    ])
  ).rows.map((row) => row.id)

  if (ids.length > 0) {
    await pool().query('delete from jobs where key = any($1::text[])', [
      ids.map((id) => `founders:${id}`),
    ])
    await pool().query(
      "delete from events where (props->>'founders_list_id')::bigint = any($1::bigint[])",
      [ids],
    )
    await pool().query('delete from founders_list where id = any($1::bigint[])', [ids])
  }

  await pool().query("delete from events where props->>'o1_marker' = $1", [MARKER])
}

suite('/admin reads (database)', () => {
  beforeAll(() => {
    process.env.DATABASE_URL = url
  })

  afterAll(async () => {
    await cleanup()
    await closeDb()
  })

  it('reads the six Phase 0 gates, every one of them rendered', async () => {
    const gates = await readGates()

    expect(gates.map((gate) => gate.key)).toEqual([
      'founders_signed_up',
      'cnpjs_searched',
      'telegram_linked',
      'concierge_paying',
      'founder_seats_paid',
      'digest_open_rate',
    ])

    // Every query must actually run: an `error` state here means the SQL is
    // wrong against the real schema, which is the point of this test.
    const failed = gates.filter((gate) => gate.reading.state === 'error')
    expect(failed.map((gate) => gate.key)).toEqual([])

    // The one gate with nothing behind it says so instead of showing a zero.
    const concierge = gates.find((gate) => gate.key === 'concierge_paying')
    expect(concierge?.reading.state).toBe('no_source')
  })

  it('counts a new founder in the gate and in the table', async () => {
    const before = await readGates()
    const beforeCount = before.find((gate) => gate.key === 'founders_signed_up')?.reading
    expect(beforeCount?.state).toBe('counted')
    const start = beforeCount?.state === 'counted' ? beforeCount.value : -1

    const outcome = await signUpFounder(founder(1))
    expect(outcome.status === 'seated' || outcome.status === 'waitlisted').toBe(true)

    const after = await readGates()
    const afterCount = after.find((gate) => gate.key === 'founders_signed_up')?.reading
    expect(afterCount).toMatchObject({ state: 'counted', value: start + 1 })

    expect(await countFounders()).toBe(start + 1)
    const listed = await listFounders()
    expect(listed[0]?.email).toBe(`o1-${MARKER}-1@${DOMAIN}`)
    expect(listed[0]?.contactConsent).toBe(true)
  })

  it('keeps F1 signup events writing the same name and props through the shared helper', async () => {
    const email = `o1-${MARKER}-2@${DOMAIN}`
    const created = await signUpFounder(founder(2))

    const { rows } = await pool().query<{ name: string; props: Record<string, unknown> }>(
      "select name, props from events where (props->>'founders_list_id')::bigint = $1 order by id",
      [created.id],
    )

    expect(rows.map((row) => row.name)).toEqual([SIGNUP_EVENT])
    expect(rows[0].props).toMatchObject({
      founders_list_id: created.id,
      source: 'o1-test',
      contact_consent: true,
      terms_accepted: true,
    })
    // The consent record of §12 survived the refactor.
    expect(rows[0].props).toHaveProperty('terms_version')
    expect(rows[0].props).toHaveProperty('privacy_consent_at')
    // Nothing that identifies the person is in the event itself.
    expect(JSON.stringify(rows[0].props)).not.toContain(email)

    // The duplicate path writes the second name, also through the helper.
    await signUpFounder(founder(2))
    const { rows: after } = await pool().query<{ name: string }>(
      "select name from events where (props->>'founders_list_id')::bigint = $1 order by id",
      [created.id],
    )
    expect(after.map((row) => row.name)).toEqual([SIGNUP_EVENT, DUPLICATE_EVENT])
  })

  it('records an event through the helper, with its props', async () => {
    await recordEvent({ name: 'offer_viewed', props: { o1_marker: MARKER, variant: 'test' } })

    const { rows } = await pool().query<{
      name: string
      props: Record<string, unknown>
      user_id: string | null
      visitor_id: string | null
    }>("select name, props, user_id, visitor_id from events where props->>'o1_marker' = $1", [
      MARKER,
    ])

    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe('offer_viewed')
    expect(rows[0].props).toMatchObject({ variant: 'test' })
    expect(rows[0].user_id).toBeNull()
    expect(rows[0].visitor_id).toBeNull()
  })

  it('exports a CSV whose rows survive a name full of punctuation', async () => {
    const nasty = 'Silva, "Duda" & Cia\nfilial'
    await signUpFounder(founder(3, nasty))

    const csv = foundersCsv(await listAllFounders())
    const line = csv.split('\r\n').find((row) => row.includes('Silva'))
    expect(line).toBeDefined()
    // Quoted and doubled, so the columns after it are still their own columns.
    expect(line).toContain('"Silva, ""Duda"" & Cia')
    expect(csv).toContain(`o1-${MARKER}-3@${DOMAIN}`)
  })

  it('measures the database size and admits it cannot see the Neon figures', async () => {
    const bytes = await databaseSizeBytes()
    expect(bytes).toBeGreaterThan(0)

    const usage = await readNeonUsage()
    expect(usage.databaseSize).toMatchObject({ state: 'measured' })
    expect(usage.projectStorage.state).toBe('not_configured')
    expect(usage.computeHours.state).toBe('not_configured')
    if (usage.projectStorage.state === 'not_configured') {
      expect(usage.projectStorage.missing).toContain('NEON_API_KEY')
    }
  })
})
