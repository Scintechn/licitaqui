import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The shape of `docs/DEVELOPMENT_PLAN.md` §5, so a new card cannot be added
 * without a status and a row cannot silently lose a cell.
 *
 * **Why a test and not a convention.** A §5 row with the wrong number of
 * cells does not fail loudly — Markdown shifts every cell after the mistake,
 * so `Depends on` renders in the `∥` column and nobody notices. That is D79,
 * found by a sweep rather than by anything failing, and three rows still carry
 * it today. This is the cheap guard that stops the fourth.
 *
 * It asserts the shape. **It cannot assert that `done` is true** — nothing can
 * — so that remains the reader's job, which the legend says in as many words.
 */

const PLAN = readFileSync(new URL('../../../docs/DEVELOPMENT_PLAN.md', import.meta.url), 'utf8')

/** A card row: `| D84 | D | open | … |`. Not the §1.2 gap table, which is its own shape. */
const CARD_ROW = /^\| [A-Z][0-9]+[a-z]? \| [A-Z/]+ \|/
const STATUSES = ['done', 'partial', 'open', 'blocked'] as const

/** Unescaped `|` only: a `\|` inside a code span is legal and must not count. */
const cells = (row: string) => row.split(/(?<!\\)\|/)

const rows = PLAN.split('\n').filter((line) => CARD_ROW.test(line))

describe('DEVELOPMENT_PLAN.md §5', () => {
  it('has card rows at all, so a rename cannot make this suite vacuous', () => {
    expect(rows.length).toBeGreaterThan(150)
  })

  it('gives every card one of the four statuses, in the third column', () => {
    const wrong = rows
      .map((row) => ({ id: cells(row)[1]?.trim(), status: cells(row)[3]?.trim() }))
      .filter((row) => !STATUSES.includes(row.status as (typeof STATUSES)[number]))
    expect(wrong).toEqual([])
  })

  it('gives every card exactly eight cells', () => {
    // The three known offenders are carded as D79: two of them are the B26/B27
    // shape (another card's row swallowed into theirs) and need their text
    // recovered from history, not invented. Listed so this test can hold the
    // line for everything else instead of being switched off.
    const KNOWN_BROKEN = ['E9', 'D23', 'B21']
    const broken = rows
      .filter((row) => cells(row).length !== 10) // 8 cells + the empty ends
      .map((row) => cells(row)[1]?.trim())
    expect(broken.sort()).toEqual([...KNOWN_BROKEN].sort())
  })

  it('leaves no card id defined twice', () => {
    const ids = rows.map((row) => cells(row)[1]?.trim())
    const seen = new Set<string>()
    const dupes = ids.filter((id) => (seen.has(id!) ? true : (seen.add(id!), false)))
    expect(dupes).toEqual([])
  })
})
