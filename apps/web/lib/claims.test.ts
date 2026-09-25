import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * **`docs/CLAIMS.md` has to stay true, or it is worse than not existing.**
 *
 * The register lists promises the product has already made and not yet kept —
 * the sentence, where it renders, what would make it true, the date it comes
 * due. Sci, 2026-09-25: *"the system need to know this document, must be
 * linked to something and be readble."*
 *
 * Linking it from `CLAUDE.md` makes an agent read it. That is not the same as
 * the repository knowing about it. A document nobody can break is a document
 * that drifts: a card gets renumbered, a claim is fixed and its row is left
 * behind, and six weeks later the register says the opposite of the truth
 * while looking authoritative. Then it is worse than absent, because it is
 * believed.
 *
 * So these assert the two joins it depends on. They deliberately do **not**
 * check the prose: the reasoning in that file is for a person, and pinning it
 * would only make it expensive to keep honest.
 */

const root = join(import.meta.dirname, '..', '..', '..')
const claims = readFileSync(join(root, 'docs', 'CLAIMS.md'), 'utf8')
const plan = readFileSync(join(root, 'docs', 'DEVELOPMENT_PLAN.md'), 'utf8')
const agentGuide = readFileSync(join(root, 'CLAUDE.md'), 'utf8')

/** Card ids named in the register's tables, e.g. `**E5**`. */
function citedCards(markdown: string): string[] {
  return [...markdown.matchAll(/\*\*([A-Z]\d+[a-z]?)\*\*/g)].map((m) => m[1])
}

describe('the claims register', () => {
  it('is reachable from the guide every task reads first', () => {
    // The whole mechanism is that an agent meets this before writing copy.
    expect(agentGuide).toContain('docs/CLAIMS.md')
    expect(plan).toContain('CLAIMS.md')
  })

  it('cites only cards that exist in the plan', () => {
    const cited = new Set(citedCards(claims))
    expect(cited.size, 'the register cites at least one card').toBeGreaterThan(0)

    const missing = [...cited].filter((id) => !plan.includes(`| ${id} |`))
    // A renumbered or deleted card leaves a row pointing at nothing, and a row
    // pointing at nothing is how a register starts lying.
    expect(missing, `cards cited in CLAIMS.md but absent from the plan: ${missing}`).toEqual([])
  })

  it('keeps every open claim dated, so "due" is answerable', () => {
    const open = claims.slice(claims.indexOf('## Open'), claims.indexOf('## Closed'))
    const rows = open.split('\n').filter((l) => l.startsWith('| *') || l.startsWith('| The'))
    expect(rows.length, 'the Open table has rows').toBeGreaterThan(0)

    for (const row of rows) {
      const due = row.split('|').at(-2)?.trim() ?? ''
      // A date, or a stated condition. What is not allowed is blank: a claim
      // with no due date is one nobody will check before a launch.
      expect(due.length, `a row has no Due value: ${row.slice(0, 60)}…`).toBeGreaterThan(0)
    }
  })

  it('closes rows with evidence rather than with a deploy', () => {
    // The standard E4 set: a delivery event per recipient, not `jobs.status`
    // and not "it is configured". If this phrasing is ever softened, the file
    // stops meaning anything.
    const closed = claims.slice(claims.indexOf('## Closed'))
    expect(closed).toContain('whatsapp.sent')
    expect(closed).toContain('message_id')
  })
})
