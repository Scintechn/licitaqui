import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { testDatabaseUrl } from './test-url'

/**
 * That every `*.db.test.ts` can actually reach a database.
 *
 * ## The blind spot this closes
 *
 * `test-url.ts` returns `undefined` when no variable is configured, and each
 * database suite turns that into `describe.skip`. That is deliberate and right
 * for a fork's pull request, which has no secrets. It is wrong everywhere the
 * secrets are *supposed* to exist, because a skip reports success.
 *
 * `ci-web.yml` ran `pnpm test` with **no** `TEST_DATABASE_URL*` in its
 * environment from the day it was written, so twelve suites had never run in
 * CI even once: `radar`, `d3`, `screening`, `pagination`, `plan-limits`,
 * `quota-spent`, `rate-limit`, `u1`, `admin`, `e1`, `e3` and `founders/signup`.
 *
 * That last one is not a coincidence. CLAUDE.md §4b records "a 500 on the
 * founders signup shipped hours earlier by the change meant to fix that exact
 * path", and "every one had a green suite". The suite was green because it
 * never ran.
 *
 * ## Why a test rather than a shell step
 *
 * `ci-worker.yml` guards its own secrets with a `[ -z "$VAR" ]` check, which
 * works but hardcodes the list — so the day someone adds a suite needing a new
 * variable, the workflow passes and that suite skips. This derives the list
 * from the suites themselves, so a new one cannot be forgotten: it fails here,
 * in the same run, naming the file and the variable.
 *
 * ## Reading the fallback correctly
 *
 * Most suites are written `testDatabaseUrl('TEST_DATABASE_URL_R1') ??
 * testDatabaseUrl()`, so *either* variable satisfies them. Treating the
 * per-task name as required would demand secrets that do not exist and never
 * needed to. A file is satisfied when **any** variable it names resolves.
 */

const HERE = fileURLToPath(new URL('.', import.meta.url))
const WEB = join(HERE, '..', '..')

/**
 * This file is not a `*.db.test.ts`, so the scan below cannot match it. Stated
 * anyway, and asserted: a previous guard in this repo silently scanned its own
 * text, and blinding the scanner left every one of its tests passing.
 */
const SELF = 'lib/db/database-suites.test.ts'

function databaseSuites(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === 'e2e') continue
    const full = join(directory, entry.name)
    if (entry.isDirectory()) databaseSuites(full, found)
    else if (entry.name.endsWith('.db.test.ts')) found.push(relative(WEB, full))
  }
  return found
}

/**
 * Comments and their contents, removed before the scan.
 *
 * **The guard was one sentence away from being defeated.** `variablesIn` used
 * to match the whole file text, docblocks included — and `d3.db.test.ts` is
 * the only suite with no `?? testDatabaseUrl()` fallback, which is exactly
 * what makes the guard load-bearing for it. Writing the characters
 * `testDatabaseUrl()` anywhere in that file's docblock, which is most of the
 * file, would have added the shared variable to its list, let the shared
 * secret satisfy it, and reported success while the suite skipped.
 *
 * Prose cannot open a database connection, so prose does not get a vote.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/** Every `TEST_DATABASE_URL*` a file could be satisfied by. */
function variablesIn(file: string): string[] {
  const source = stripComments(readFileSync(join(WEB, file), 'utf8'))
  const names = new Set<string>()
  for (const match of source.matchAll(/testDatabaseUrl\(\s*'([A-Z0-9_]+)'\s*\)/g)) {
    names.add(match[1] as string)
  }
  // The bare call falls back to the shared `TEST_DATABASE_URL`.
  if (/testDatabaseUrl\(\s*\)/.test(source)) names.add('TEST_DATABASE_URL')
  return [...names]
}

const SUITES = databaseSuites(WEB)

describe('every database suite can reach a database', () => {
  it('finds the database suites, and is not one of them', () => {
    expect(SUITES.length).toBeGreaterThan(0)
    expect(SUITES).not.toContain(SELF)
    // If this trips, the scan broke rather than the suites vanishing — the
    // failure mode that made a previous guard here pass while blind.
    expect(SUITES.length).toBeGreaterThanOrEqual(12)
  })

  it('does not count a variable that only appears in prose', () => {
    // The defect this guard nearly shipped with. A docblock mentioning the
    // bare call must not satisfy a suite that never makes one — `d3` has no
    // fallback, so for `d3` that is the difference between running and not.
    const pretend = `
      /** Historically this read testDatabaseUrl() before D3 got its own. */
      const url = testDatabaseUrl('TEST_DATABASE_URL_D3')
    `
    expect(stripComments(pretend)).not.toContain('testDatabaseUrl()')
    expect(stripComments(pretend)).toContain("testDatabaseUrl('TEST_DATABASE_URL_D3')")
  })

  it('still sees a real call on the same line as a trailing comment', () => {
    const real = "const url = testDatabaseUrl() // the shared database\n"
    expect(stripComments(real)).toContain('testDatabaseUrl()')
  })

  it.each(SUITES)('%s names at least one database variable', (file) => {
    // A suite that names none would skip for ever and no wiring could fix it.
    expect(variablesIn(file).length).toBeGreaterThan(0)
  })

  /**
   * The assertion that turns a skip into a failure, and **only where the
   * secrets are meant to exist**: `ci-web.yml` sets `REQUIRE_TEST_DATABASE=1`.
   * A fork's pull request has no secrets, does not set it, and still skips.
   */
  const required = process.env.REQUIRE_TEST_DATABASE === '1'
  const whenRequired = required ? it : it.skip

  whenRequired.each(SUITES)('%s resolves a database when one is required', (file) => {
    const names = variablesIn(file)
    const resolved = names.filter((name) => testDatabaseUrl(name) !== undefined)
    expect(
      resolved.length,
      `${file} would skip: none of ${names.join(', ')} is set. ` +
        'Add the secret to ci-web.yml, or this suite is not running.',
    ).toBeGreaterThan(0)
  })
})
