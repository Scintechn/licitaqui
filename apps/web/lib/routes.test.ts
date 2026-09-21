import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ACCOUNT_CREATE_PATH, ACCOUNT_HREF, ALERTS_HREF, ALERTS_PATH } from './routes'

/**
 * Nothing may link to a route that does not exist.
 *
 * Next prefetches a `<Link>` as it enters the viewport, so an unbuilt
 * destination is not merely a dead end when clicked — it is a burst of 404s on
 * every page view (eight of them on `/` in the trace that found this) that will
 * hide a real error in the console later. The two assertions below are the
 * cheap version of "does this route exist": the sweep catches a hard-coded
 * href anywhere under `app/`, including in the server components that cannot be
 * rendered without a database.
 *
 * When U1 and E1 build the screens, flip `ACCOUNT_HREF` / `ALERTS_HREF` in
 * `routes.ts` and add `/conta` to `BUILT` here.
 */

const APP = fileURLToPath(new URL('../app', import.meta.url))

/** Route prefixes that resolve to a page today. */
const BUILT = ['/', '/radar', '/fundadores', '/termos', '/privacidade', '/admin']

function sources(directory: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) out.push(...sources(path))
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) out.push(path)
  }
  return out
}

describe('the account destinations', () => {
  it('point somewhere that exists, and both move in one edit', () => {
    expect(BUILT).toContain(ACCOUNT_HREF)
    expect(BUILT).toContain(ALERTS_HREF)
    // The addresses the canvases give them, kept so U1 and E1 do not guess.
    expect(ACCOUNT_CREATE_PATH).toBe('/conta/criar')
    expect(ALERTS_PATH).toBe('/conta/alertas')
    expect(BUILT).not.toContain(ACCOUNT_CREATE_PATH)
  })

  it('are the only way app/ names them: no hard-coded /conta href survives', () => {
    const offenders = sources(APP).filter((path) =>
      /href=["'`]\/conta/.test(readFileSync(path, 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})
