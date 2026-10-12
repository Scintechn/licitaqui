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

/**
 * §4.2's MoSCoW rows restate a card's status, and two places holding one fact
 * is how this repo's defects start. A row naming only §5 card ids must agree
 * with §5 — and where a row names several, with the **least complete** of
 * them, because a MUST row is not satisfied by its easiest half.
 *
 * Rows that name something outside §5 (G12 is a §1.2 gap; "the sandbox cycle"
 * is an action with no card) are skipped by construction: the id has to resolve
 * in §5 for the row to be checked at all.
 */
describe('§4.2 agrees with §5', () => {
  type Status = (typeof STATUSES)[number]
  const RANK: Record<Status, number> = { done: 0, partial: 1, open: 2, blocked: 3 }
  const s5 = new Map<string, Status>()
  for (const row of rows) {
    const c = cells(row)
    s5.set(c[1]!.trim(), c[3]!.trim() as Status)
  }

  const moscow = PLAN.split('\n').filter((line) => /^\| \*\*[A-Z][0-9]/.test(line))

  it('finds the MoSCoW rows at all', () => {
    expect(moscow.length).toBeGreaterThanOrEqual(8)
  })

  it('gives each row the least complete status of the cards it names', () => {
    const wrong: string[] = []
    for (const row of moscow) {
      const c = cells(row)
      const ids = (c[1]!.match(/[A-Z][0-9]+[a-z]?/g) ?? []).filter((id) => s5.has(id))
      if (ids.length === 0) continue
      // Every id must resolve, or the row is naming something §5 does not have.
      if (ids.length !== (c[1]!.match(/[A-Z][0-9]+[a-z]?/g) ?? []).length) continue
      const want = ids.reduce<Status>((a, id) => (RANK[s5.get(id)!] > RANK[a] ? s5.get(id)! : a), 'done')
      const got = c[2]!.trim()
      if (got !== want) wrong.push(`${ids.join('+')}: §4.2 says ${got}, §5 says ${want}`)
    }
    expect(wrong).toEqual([])
  })
})

/**
 * §4 Milestones and §4.1 Next actions carry a status in their **second**
 * column. Added after a mutation check found that deleting one changed
 * nothing: §5 and §4.2 were guarded and these two were not, so a row could
 * quietly lose its status and still read as a table.
 */
describe('the upper tables keep their status', () => {
  const STATUS = /^(done|partial|open|blocked)$/

  const tableAfter = (header: string) => {
    const lines = PLAN.split('\n')
    const start = lines.indexOf(header)
    expect(start, `header not found: ${header}`).toBeGreaterThan(-1)
    const out: string[] = []
    for (let i = start + 1; i < lines.length && lines[i]!.startsWith('|'); i++) {
      if (!/^\|[-: |]+\|$/.test(lines[i]!)) out.push(lines[i]!)
    }
    return out
  }

  it.each([
    ['| Milestone | Status | Date | Ships | Exit criteria |', 9],
    ['| # | Status | Next | Owner | Why it is next | Unblocks |', 8],
  ])('%s', (header, expected) => {
    const body = tableAfter(header)
    expect(body).toHaveLength(expected)
    const wrong = body
      .map((row) => ({ row: cells(row)[1]?.trim(), status: cells(row)[2]?.trim() ?? '' }))
      .filter((r) => !STATUS.test(r.status))
    expect(wrong).toEqual([])
  })
})
