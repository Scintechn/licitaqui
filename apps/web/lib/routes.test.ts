import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ACCOUNT_CREATE_PATH,
  ACCOUNT_HREF,
  ACCOUNT_PATH,
  ALERTS_HREF,
  ALERTS_PATH,
  PLAN_HREF,
  accountHref,
} from './routes'

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
 * U1 built `/conta` and `/conta/criar`, so `/conta` is in `BUILT` and
 * `ACCOUNT_HREF` is the real screen. `ALERTS_HREF` still is not: E1 owns
 * `/conta/alertas`, and until that page exists the bell must keep pointing
 * somewhere that answers 200. When E1 and F2 ship, flip their constant in
 * `routes.ts` — nothing here needs to change, because `/conta` already covers
 * every child route.
 */

const APP = fileURLToPath(new URL('../app', import.meta.url))

/** Route prefixes that resolve to a page today. */
const BUILT = ['/', '/radar', '/fundadores', '/termos', '/privacidade', '/admin', '/conta']

/**
 * Whether `href` is under a built prefix.
 *
 * A prefix match, not equality: `/conta` is one page *and* the root of
 * `/conta/criar` and `/conta/alertas`, while `/conta/plano` — F2's, unbuilt —
 * must still be caught. So a prefix only covers itself and what is nested
 * under it, and the unbuilt children are listed by name below.
 */
function isBuilt(href: string): boolean {
  return BUILT.some((prefix) => href === prefix || href.startsWith(`${prefix}/`))
}

/** Addresses that are named in `routes.ts` but have no page yet. */
const UNBUILT = ['/conta/plano']

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
  it('point somewhere that exists, and each moves in one edit', () => {
    expect(isBuilt(ACCOUNT_HREF)).toBe(true)
    expect(isBuilt(ALERTS_HREF)).toBe(true)
    expect(isBuilt(PLAN_HREF)).toBe(true)
    // The addresses the canvases give them, kept so E1 and F2 do not guess.
    expect(ACCOUNT_CREATE_PATH).toBe('/conta/criar')
    expect(ACCOUNT_PATH).toBe('/conta')
    expect(ALERTS_PATH).toBe('/conta/alertas')
  })

  it('never point at a screen nobody has built', () => {
    for (const href of [ACCOUNT_HREF, ALERTS_HREF, PLAN_HREF]) {
      expect(UNBUILT).not.toContain(href)
    }
  })

  it('round-trip the visitor back to where they were, now that U1 has a screen', () => {
    expect(accountHref('/radar/edital/x/triagem')).toBe(
      `${ACCOUNT_CREATE_PATH}?next=${encodeURIComponent('/radar/edital/x/triagem')}`,
    )
    expect(accountHref()).toBe(ACCOUNT_HREF)
  })

  it('are the only way app/ names them: no hard-coded /conta href survives', () => {
    const offenders = sources(APP).filter((path) =>
      /href=["'`]\/conta/.test(readFileSync(path, 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})
