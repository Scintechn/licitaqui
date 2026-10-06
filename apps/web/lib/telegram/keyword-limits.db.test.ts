import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { sql } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { AlertsView, type AlertsViewProps } from '@/app/conta/alertas/alerts-view'
import { closeDb, db } from '@/lib/db'
import { testDatabaseUrl } from '@/lib/db/test-url'
import messages from '@/messages/pt-BR.json'
import {
  type AlertLimits,
  clampPreferences,
  keywordFields,
  readAlertLimits,
  UNCAPPED_KEYWORD_FIELDS,
} from './quota'

/**
 * **E18's last acceptance criterion: the two cannot drift again.**
 *
 * The rest of E18 shipped in #161 (the `alerts.keywords` column) and #165 (the
 * read paths in the web and the worker). What did not ship is the guard the
 * card asks for in its own words — *"a test asserts the number of fields the
 * form offers against `plan_limits`, so the two cannot drift again"*. What
 * exists in `quota.test.ts` asserts `keywordFields(10)` has ten entries: a
 * literal against a literal, which is true no matter what the table says and
 * would have passed happily throughout the whole of the defect. `alerts-view.tsx`
 * says in a comment that `keywordFields` "is exported and tested against
 * `plan_limits`". Until this file, it was not.
 *
 * ## What each assertion catches
 *
 * The number reaches the screen through `readAlertLimits` → `keywordFields`,
 * and the submission through `readAlertLimits` → `clampPreferences`. So the
 * drift to catch is **either of those two forgetting the table**, which is
 * exactly how the original defect was written: `clampPreferences` read
 * `limits.keywords` as a boolean (`!== 0`) and kept one of the ten Essencial is
 * granted. A literal smuggled back into either function makes a plan whose row
 * is not that literal go red here.
 *
 * The quantity is therefore read **by its own query**, not through the function
 * under test — otherwise this would compare a value with itself.
 *
 * ## And the sentence, because the sentence is the promise
 *
 * `plans.essential.feature2` and `radar.landing.alerts.body` both sell *"10
 * palavras-chave"*. That sentence is why E18 was built rather than weakened
 * (`docs/CLAIMS.md`), and a sentence naming a number is a claim that can go
 * false by an edit to the **other** side: drop `essencial` to 3 in
 * `plan_limits` and both pages keep promising ten. CDC art. 30 binds an
 * advertised feature, so the copy is swept against the row.
 *
 * The sweep asserts it **found** the sentences. A sweep that matches nothing
 * passes for free, which is the whole of `memory: empty-result-is-not-absence`,
 * and this one is walking a catalogue somebody may reword.
 */

const url = testDatabaseUrl('TEST_DATABASE_URL_B2') ?? testDatabaseUrl()
const suite = url ? describe : describe.skip
if (url) process.env.DATABASE_URL = url

afterAll(async () => {
  if (url) await closeDb()
})

/**
 * Read straight from the table, so nothing below checks a value with itself.
 *
 * `(plan, feature)` is unique — `0002_plan_limits`' `on conflict (plan,
 * feature)` requires it — so the single row is deterministic without an
 * `order by`. Worth stating: if that key ever widened to include `period`,
 * this would take the first of a pair and `readAlertLimits` the last, and the
 * two would disagree nondeterministically.
 *
 * `undefined` is "no row" and `null` is the documented **uncapped**.
 */
async function granted(plan: string): Promise<number | null | undefined> {
  const found = await db().execute<{ quantity: number | null }>(sql`
    select quantity from plan_limits
     where plan = ${plan} and feature = 'keywords'
  `)
  if (found.rows.length === 0) return undefined
  const quantity = found.rows[0].quantity
  return quantity === null ? null : Number(quantity)
}

/**
 * How many fields a grant of `quantity` should produce.
 *
 * **`quantity is null` means unlimited** (`0002_plan_limits`' header, and
 * `quota.ts` repeats it on every field), and that is a legitimate runtime
 * configuration of a table the migration calls *"deliberately editable at
 * runtime"*. Passing `null` to `toHaveLength` is a Vitest matcher error —
 * *"expected value must be a non-negative integer"* — so an uncapped plan
 * would have turned this suite red, with an unreadable message, on a product
 * behaving exactly as designed. That is §4d: before pinning a threshold,
 * check it is one. `plan-limits.db.test.ts` handles the same case with
 * `?? Infinity`; the answer here is the cap the form actually draws.
 */
function expectedFields(quantity: number | null): number {
  return quantity === null ? UNCAPPED_KEYWORD_FIELDS : quantity
}

/** Every plan `0002_plan_limits` gives a keyword row. */
const PLANS = ['basico', 'promocional', 'essencial', 'pro'] as const

/**
 * The screen itself, rendered with the limits the database actually holds.
 *
 * **This is the half that matters**, and the half a guard on `keywordFields`
 * alone does not reach. The original defect was a `<Field>` written once in the
 * markup: the form can stop consulting the plan without any function changing
 * its answer, and then nothing but this render notices. `alerts-view.test.tsx`
 * counts no fields — it only checks that a plan granting **0** renders none —
 * so until this test, a single hardcoded input was green.
 *
 * `renderToStaticMarkup` because `vitest.config.mts` is `environment: 'node'`
 * with no jsdom (CLAUDE.md §4c). That is enough here *because the field count
 * is decided during the first render* — there is no effect to miss and no box
 * to measure. What this cannot see is the rendered screen: ten inputs drawn
 * inside the app shell's 720px content column is a layout question, and layout
 * belongs in `apps/web/e2e/`. Said plainly so nobody reads this as covering it.
 */
function renderAlerts(limits: AlertLimits, keywords: string[]): string {
  const props: AlertsViewProps = {
    phase: { phase: 'idle' },
    active: true,
    limits,
    cnpj: '36955612000185',
    companyName: 'Scint Tecnologia',
    botHandle: '@LicitaQuiBot',
    keywords,
    states: ['SP'],
    notice: null,
    connectAction: () => {},
    recheckAction: () => {},
    disconnectAction: () => {},
    pauseAction: () => {},
    resumeAction: () => {},
    saveAction: () => {},
    companyAction: () => {},
  }
  return renderToStaticMarkup(createElement(AlertsView, props))
}

/**
 * Occurrences, **not** lines.
 *
 * `grep -c` counting lines instead of matches is one of the four ways a
 * mutation check has lied in this repo (CLAUDE.md §4b): ten inputs emitted by
 * `renderToStaticMarkup` arrive as one line, which would read as "1".
 */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

/** `N palavra(s)-chave` anywhere in the approved catalogue. */
const CLAIM_RE = /(\d+)\s+palavras?-chave/gi

function keywordClaims(): { path: string; claimed: number; sentence: string }[] {
  const found: { path: string; claimed: number; sentence: string }[] = []
  const walk = (node: unknown, path: string): void => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(CLAIM_RE)) {
        found.push({ path, claimed: Number(match[1]), sentence: node })
      }
      return
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        walk(value, path ? `${path}.${key}` : key)
      }
    }
  }
  walk(messages, '')
  return found
}

suite('plan_limits · keywords', () => {
  it('grants Essencial more than Básico, so the paid alert is a different alert', async () => {
    // The point of the card. Both plans delivered exactly one keyword until
    // E18, which made an Essencial digest indistinguishable from a free one.
    const free = await granted('basico')
    expect(free, 'basico lost its keywords row').toBe(1)

    for (const plan of ['promocional', 'essencial', 'pro'] as const) {
      const paid = await granted(plan)
      expect(paid, `${plan} has no keywords entitlement`).not.toBeUndefined()
      expect(paid ?? Infinity, `${plan} grants no more keywords than basico`).toBeGreaterThan(
        free as number,
      )
    }
  })

  it('offers exactly as many fields as the row grants, on every plan', async () => {
    for (const plan of PLANS) {
      const quantity = await granted(plan)
      expect(quantity, `${plan} has no keywords row`).not.toBeUndefined()
      const limits = await readAlertLimits(plan, db())

      // `readAlertLimits` must report the row, and `keywordFields` must draw
      // one field per unit of it. A literal in either is a plan whose field
      // count stops matching its row.
      expect(limits.keywords, `readAlertLimits(${plan}) lost the row`).toBe(quantity)
      expect(keywordFields(limits.keywords), `${plan} offers the wrong field count`).toHaveLength(
        expectedFields(quantity as number | null),
      )
    }
  })

  it('keeps every field it offered, on every plan', async () => {
    for (const plan of PLANS) {
      const quantity = (await granted(plan)) as number | null
      const limits = await readAlertLimits(plan, db())
      const typed = keywordFields(limits.keywords).map((index) => `palavra ${index}`)

      // The clamp is the server-side half (§8). Reading the count as a
      // boolean — `keyword && limits.keywords !== 0`, the original defect —
      // keeps one here however many the form offered, and a person types into
      // boxes that are discarded on save without a word.
      const kept = clampPreferences({ states: [], keywords: typed }, limits)
      expect(kept.keywords, `${plan} discards fields the form offered`).toHaveLength(
        expectedFields(quantity),
      )
    }
  })

  it('draws one input per granted keyword on the screen itself', async () => {
    for (const plan of PLANS) {
      const quantity = (await granted(plan)) as number | null
      const limits = await readAlertLimits(plan, db())
      const fields = occurrences(renderAlerts(limits, []), 'name="palavra"')

      // The form must consult the plan, not a number somebody typed into the
      // markup. One `<Field>` written once is the whole of the original E18
      // defect, and it is invisible to every test that checks a function.
      expect(fields, `${plan} draws ${fields} keyword inputs for ${quantity} granted`).toBe(
        expectedFields(quantity),
      )
    }
  })

  it('brings back every keyword already saved, not just the first', async () => {
    const limits = await readAlertLimits('essencial', db())
    const quantity = expectedFields((await granted('essencial')) as number | null)
    const saved = Array.from({ length: quantity }, (_unused, index) => `palavra-${index}`)
    const html = renderAlerts(limits, saved)

    // E18's fourth criterion. `value="…"` and not merely present in the page:
    // a keyword rendered in a heading somewhere is not a keyword the person
    // can see, edit and re-save.
    for (const keyword of saved) {
      expect(html, `${keyword} is not in a field`).toContain(`value="${keyword}"`)
    }
  })

  it('clamps an over-long submission to the row Essencial actually holds', async () => {
    // **This is the clamp, not the POST.** The acceptance criterion's
    // "hand-made POST with 11 is clamped server-side" is asserted through the
    // real `savePreferences` + `FormData` in `app/conta/alertas/actions.test.ts`;
    // naming this one after the POST would have claimed a path it never walks,
    // which is §4b's "the test exercised the unit, not the path".
    const limits = await readAlertLimits('essencial', db())
    const quantity = expectedFields((await granted('essencial')) as number | null)
    const tooMany = Array.from({ length: quantity + 1 }, (_unused, index) => `palavra ${index}`)
    expect(clampPreferences({ states: [], keywords: tooMany }, limits).keywords).toHaveLength(
      quantity,
    )
  })

  it('never promises more keywords than Essencial is granted', async () => {
    const essencial = expectedFields((await granted('essencial')) as number | null)
    const claims = keywordClaims()

    // A sweep that found nothing proves nothing about the sweep.
    expect(claims.length, 'no "N palavras-chave" sentence found — did the copy move?').toBeGreaterThan(0)

    // **Both live copies, pinned by path.** Sweeping them "because the regex
    // happens to match" is not the same as pinning them: reword one to "até
    // dez palavras-chave" and the sweep silently covers one sentence while
    // `claims.length > 0` still holds. `docs/CLAIMS.md` has a whole section on
    // this — "a guard a synonym defeats is a guard against one phrasing" —
    // written after exactly that defeated D6's and D7's guards. If one of
    // these is deliberately reworded, this list is what makes the rewording a
    // decision rather than a silent loss of cover.
    for (const path of ['plans.essential.feature2', 'radar.landing.alerts.body']) {
      expect(
        claims.map((claim) => claim.path),
        `${path} promises a keyword count and is no longer swept`,
      ).toContain(path)
    }

    const overclaims = claims
      .filter(({ claimed }) => claimed > essencial)
      .map(({ path, claimed, sentence }) => `${path} promises ${claimed} of ${essencial}: ${sentence}`)
    expect(overclaims).toEqual([])
  })

  /**
   * **Every keyword-count sentence against the plan it is about.**
   *
   * The sweep above compares the whole catalogue against *Essencial's* grant,
   * which makes Básico over-claiming invisible: `plans.basic.feature4` says
   * *"1 palavra-chave"* and was being checked against **10**. "The free plan's
   * card says one thing and its row says another" is E18's shape one plan
   * over, and it would have passed.
   *
   * So each sentence is classified by the plan it describes and checked for
   * **equality** — a sentence naming a number is a claim about that number,
   * not an upper bound. And the classification must be **total**: a new
   * keyword-count sentence that nobody classified fails here rather than
   * being waved through by a `<=`. That is `product.test.ts`'s mechanism, the
   * one CLAUDE.md credits with catching two things review had not.
   */
  it('matches every keyword-count sentence to the plan it describes', async () => {
    const BY_PATH: Record<string, string> = {
      // `keywordClaims` walks arrays with `Object.entries`, so an index is a
      // dotted key (`steps.2`), not `steps[2]`. Spelled the walker's way.
      'foundersPage.timeline.steps.2.body': 'basico',
      'plans.basic.feature4': 'basico',
      'plans.essential.feature2': 'essencial',
      'radar.landing.alerts.body': 'essencial',
    }

    const unclassified = keywordClaims()
      .filter(({ path }) => !(path in BY_PATH))
      .map(({ path, sentence }) => `${path}: ${sentence}`)
    expect(
      unclassified,
      'a new sentence names a keyword count and no plan was named for it — add it to BY_PATH',
    ).toEqual([])

    for (const [path, plan] of Object.entries(BY_PATH)) {
      const expected = expectedFields((await granted(plan)) as number | null)
      const mine = keywordClaims().filter((claim) => claim.path === path)
      expect(mine, `${path} no longer names a keyword count`).toHaveLength(1)
      expect(mine[0].claimed, `${path} promises ${mine[0].claimed}, ${plan} grants ${expected}`).toBe(
        expected,
      )
    }
  })
})
