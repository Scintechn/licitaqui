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

  it('gives every card in the plan a unique id', () => {
    /**
     * **The hole the test above left open.**
     *
     * On 2026-09-25 a lane added a card numbered `E7` for "the opening e-mail
     * has no enqueuer" while `E7` already meant "the Monday Telegram digest".
     * Merging produced **two `| E7 |` rows**, and the citation check passed
     * throughout — it asks whether a cited card *exists*, which two of them
     * emphatically do.
     *
     * Two lanes inserting a card after the same anchor row is not a rare
     * event here; it is what `.gitattributes` already documents for
     * `docs/STATUS.md`, and the reason that file has a merge driver and this
     * one deliberately does not. So the collision has to be caught by an
     * assertion rather than by whoever reads the diff.
     */
    const ids = [...plan.matchAll(/^\| ([A-Z]\d+[a-z]?) \|/gm)].map((m) => m[1])
    expect(ids.length, 'the plan has cards').toBeGreaterThan(0)

    // Counted rather than filtered through a Set: `Set.prototype.add` returns
    // the *set*, not a boolean, so the obvious `!seen.add(id)` is always false
    // and the check silently passes on every input. It was written that way
    // here first, and the mutation check is the only reason it did not ship.
    const counts = new Map<string, number>()
    for (const id of ids) counts.set(id, (counts.get(id) ?? 0) + 1)

    const duplicates = [...counts].filter(([, times]) => times > 1).map(([id]) => id)
    expect(duplicates, `card ids used more than once in the plan: ${duplicates}`).toEqual([])
  })

  it('keeps every open claim dated, so "due" is answerable', () => {
    // Everything above `## Closed` is open, however the sections above it are
    // titled. Pinning a heading name is what broke this on 2026-09-25, when the
    // single `## Open` table was split into "due before the publicity" and "due
    // when Essencial goes on sale" — a reorganisation the requirement does not
    // care about. What it cares about is that every open row carries a Due.
    const open = claims.slice(0, claims.indexOf('## Closed'))
    const rows = open
      .split('\n')
      .filter((l) => l.startsWith('|') && l.split('|').length >= 6 && !l.includes('---'))
      .filter((l) => !l.includes('Claim, verbatim'))
    expect(rows.length, 'the open tables have rows').toBeGreaterThan(0)

    for (const row of rows) {
      // Drop the empty strings either side of the leading and trailing pipes
      // before taking the last cell. Reading `split('|').at(-2)` blindly reads
      // the *penultimate* column when a row does not end in a pipe, so a row
      // with an empty Due was passing — caught by mutation, not by review.
      const cells = row.split('|').slice(1, -1)
      const due = cells.at(-1)?.trim() ?? ''
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
