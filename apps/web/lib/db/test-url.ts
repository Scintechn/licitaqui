import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/**
 * Resolves `TEST_DATABASE_URL` for the database tests, following the same house
 * pattern as `db/migrate.py`: the environment first, then the repo-root env
 * files. Tests import this; the app never does.
 *
 * The value is returned, never printed, never logged and never written
 * anywhere. Nothing in the repo may echo it.
 *
 * Returns `undefined` when no test database is configured, which is how CI runs
 * (no secrets on a fork's pull request): the database suites skip themselves
 * rather than fail.
 */

const ENV_FILES = ['.env.neon-roles.local', '.env.local'] as const

/**
 * The default variable. A task with its own isolated database passes its own
 * name instead — task O1 uses `TEST_DATABASE_URL_O1` — so two suites running at
 * once cannot delete each other's rows.
 */
const VARIABLE = 'TEST_DATABASE_URL'

function readFromFile(path: string, variable: string): string | undefined {
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith(`${variable}=`)) continue
    const value = trimmed.slice(variable.length + 1).trim().replace(/^["']|["']$/g, '')
    if (value) return value
  }
  return undefined
}

/** Walks up from `apps/web` looking for the repo root's env files. */
function fromEnvFiles(variable: string): string | undefined {
  let directory = resolve(process.cwd())
  for (let depth = 0; depth < 6; depth += 1) {
    for (const file of ENV_FILES) {
      const path = join(directory, file)
      if (existsSync(path)) {
        const value = readFromFile(path, variable)
        if (value) return value
      }
    }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

export function testDatabaseUrl(variable: string = VARIABLE): string | undefined {
  return process.env[variable]?.trim() || fromEnvFiles(variable)
}
