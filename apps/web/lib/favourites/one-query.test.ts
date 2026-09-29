import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import * as store from './store'

/**
 * That the badge and the section are **one read** — Sci's D23 card, asserted.
 *
 * The rule was written into three docblocks and guarded by nothing. Proved by
 * deleting the shell's `listFavourites` call: every test still passed, 22 of
 * them, while the badge silently became permanently absent. A rule that lives
 * only in prose is the exact shape this repo keeps finding.
 *
 * It cannot be asserted end to end here — `readShell` reads `headers()` and so
 * needs a request context — so this asserts the two things that make the rule
 * true and would each have to be undone to break it: the count is derived from
 * the list function, and no separate counting function exists to reach for.
 *
 * Why it matters rather than being tidiness: a second query is a second
 * answer, free to disagree. A badge saying 4 above a list showing 3 is how two
 * readers of one fact end up contradicting each other — which is what
 * `plan_limits` did when the web read a missing row as zero and the worker
 * read it as uncapped.
 */

const SHELL = fileURLToPath(new URL('../account/server-summary.ts', import.meta.url))

/**
 * A file's code with comments and line breaks removed.
 *
 * Both were load-bearing in earlier versions of this guard and should not
 * have been. It first pinned the call on a single line and broke when the
 * argument list wrapped; then it excluded `:` to bound the match, and broke
 * again on a comment containing one. A guard that fails because code was
 * *formatted* or *explained* teaches the next person to delete it.
 *
 * The same trick `lib/db/database-suites.test.ts` uses, for the same reason:
 * prose cannot call a function, so prose does not get a vote.
 */
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/\s+/g, ' ')
}

describe('the favourites count comes from the favourites list', () => {
  it('offers no way to count them separately', () => {
    // If somebody adds `countFavourites`, this fails and they have to read the
    // card before reaching for it.
    expect(Object.keys(store)).not.toContain('countFavourites')
    expect(Object.keys(store)).toContain('listFavourites')
  })

  it('derives the badge from the list, in the shell', () => {
    const source = code(SHELL)
    expect(source).toContain('listFavourites')
    // `.length` of the list, not a number from anywhere else.
    expect(source).toMatch(/favouriteCount:\s*favourites === null \? null : favourites\.length/)
  })

  it('reads nothing for a viewer with no account', () => {
    // A visitor has no favourites and no account to key them on, so the badge
    // is `null` — unknown — rather than 0, which would be a claim.
    //
    // **Whitespace-collapsed before matching.** The first version pinned the
    // call on one line and broke the moment the argument list wrapped across
    // three — a guard failing because code was *formatted* teaches the next
    // person to delete it. The rule is "only read for a user"; the line
    // breaks are not the rule.
    const source = code(SHELL)
    expect(source).toMatch(/viewer\?\.kind === 'user' \? listFavourites\(/)
  })
})
