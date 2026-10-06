import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `savePreferences` — the POST that saves the alert, and **the one link in
 * E18's chain that nothing tested.**
 *
 * The chain is: the form draws N inputs → the action reads them → the clamp
 * trims them to the plan → `saveAlert` writes the array → the worker matches
 * any of them. Every other link had a test. This one had none: `savePreferences`
 * is referenced only by its own definition and `page.tsx`, there was no
 * `actions.test.ts`, and no e2e spec submits the filters form
 * (`e2e/accounts/ricardo-telegram.spec.ts` drives connect/waiting/recheck and
 * stops there).
 *
 * So `formData.getAll('palavra')` could go back to `formData.get('palavra')`
 * and **the entire repository stayed green** — the form still drew ten inputs,
 * `clampPreferences` still kept ten when handed ten, `plan_limits` still said
 * ten, and exactly one keyword reached the database. That is E18's whole
 * user-visible symptom, restored, with the guard written to prevent it
 * reporting success. The code says so in two places and neither was asserted:
 * *"`get` returning only the first is the other half of how ten became one."*
 *
 * ## Why this is a unit test and not a `.db.test.ts`
 *
 * The question here is the **seam** — does the action read every field the form
 * posted — and the answer must not depend on a database being reachable.
 * Where the *number* comes from is a different question, pinned against the
 * real `plan_limits` rows in `lib/telegram/keyword-limits.db.test.ts`. §4c:
 * the mechanism here, and the number there.
 *
 * `clampPreferences` and `readAlertLimits` are deliberately **not** mocked —
 * they are half of what is under test. The database, the session, the cookie
 * jar and `redirect` are.
 */

const saveAlert = vi.fn()
const ensureAlert = vi.fn()

/** `redirect()` throws in Next; the test has to be able to see it did. */
class Redirected extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`)
  }
}

vi.mock('@/lib/auth', () => ({ auth: async () => ({ user: { id: '7' } }) }))
vi.mock('next/headers', () => ({ cookies: async () => ({ delete: () => {}, set: () => {} }) }))
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirected(to)
  },
}))
vi.mock('@/lib/telegram/link', () => ({
  saveAlert: (...args: unknown[]) => saveAlert(...args),
  ensureAlert: (...args: unknown[]) => ensureAlert(...args),
  issueStartLink: vi.fn(),
  setAlertActive: vi.fn(),
  unlinkChat: vi.fn(),
}))

/**
 * Two statements reach `db()` on this path: `planOf`'s `select plan from users`
 * and `readAlertLimits`' `select … from plan_limits`. They are told apart by
 * the table name in the compiled query, so the stub cannot answer the wrong
 * one by accident.
 */
const GRANTED = 10

vi.mock('@/lib/db', () => ({
  db: () => ({
    execute: async (query: unknown) => {
      const text = JSON.stringify(query)
      if (text.includes('plan_limits')) {
        return {
          rows: [
            { feature: 'alert', quantity: 1 },
            { feature: 'keywords', quantity: GRANTED },
            { feature: 'states', quantity: 1 },
          ],
        }
      }
      if (text.includes('users')) return { rows: [{ plan: 'essencial' }] }
      throw new Error(`unexpected query: ${text.slice(0, 200)}`)
    },
  }),
}))

const { savePreferences } = await import('./actions')

/** What `saveAlert` was handed, after the action and the clamp. */
async function save(form: FormData): Promise<{ states: string[]; keywords: string[] }> {
  await expect(savePreferences(form)).rejects.toBeInstanceOf(Redirected)
  expect(saveAlert, 'saveAlert was never called').toHaveBeenCalledTimes(1)
  return saveAlert.mock.calls[0][1] as { states: string[]; keywords: string[] }
}

function formWith(keywords: string[], states: string[] = ['SP']): FormData {
  const form = new FormData()
  for (const state of states) form.append('uf', state)
  // `append`, not `set`: the form posts one `palavra` entry per field, which is
  // exactly the shape `get` silently truncates.
  for (const keyword of keywords) form.append('palavra', keyword)
  return form
}

beforeEach(() => {
  saveAlert.mockClear()
  ensureAlert.mockClear()
})

describe('savePreferences — every field the form posted', () => {
  it('saves all ten keywords a granted form submits, not just the first', async () => {
    const typed = Array.from({ length: GRANTED }, (_unused, index) => `palavra-${index}`)
    const saved = await save(formWith(typed))

    // The assertion the repository did not have. With `get` instead of
    // `getAll` this is `['palavra-0']`.
    expect(saved.keywords).toEqual(typed)
  })

  it('clamps a hand-made POST of eleven to the plan, server-side', async () => {
    // §8, "quota checks: always server-side" — and this time through the
    // actual POST handler rather than by calling the clamp directly.
    const typed = Array.from({ length: GRANTED + 1 }, (_unused, index) => `palavra-${index}`)
    const saved = await save(formWith(typed))

    expect(saved.keywords).toHaveLength(GRANTED)
    expect(saved.keywords).not.toContain(`palavra-${GRANTED}`)
  })

  it('drops blanks from the empty fields a long form leaves behind', async () => {
    // Ten fields and two words typed is two keywords. An empty string reaching
    // `websearch_to_tsquery` matches every open tender in Brazil, and
    // `alerts_keywords_check` refuses it anyway.
    const saved = await save(formWith(['papel', '', '   ', 'toner', '']))
    expect(saved.keywords).toEqual(['papel', 'toner'])
  })

  it('makes sure the row exists before writing to it', async () => {
    await save(formWith(['papel']))
    expect(ensureAlert, 'a save into no row writes nothing').toHaveBeenCalledTimes(1)
  })
})
