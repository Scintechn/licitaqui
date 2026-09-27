import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brl, brlExact, FOUNDERS, NOTICE, PLAN_PRICES, PROMO } from './product'

/**
 * **Does every file still agree with `docs/product.json`?**
 *
 * A price is written by hand in about thirty places: the copy catalogue, five
 * worker templates, and four legal documents where it is a contract clause and
 * therefore has to be prose rather than a placeholder. Nothing can remove that
 * duplication. What this removes is the *hunting* — change a number in
 * `product.json` and these tests name every file still carrying the old one.
 *
 * Two directions, because a price change can fail in two ways:
 *
 *  1. **Stale site** — five of six places updated. Caught by asserting each
 *     required file still contains the current value.
 *  2. **Unknown amount** — a price appears somewhere nobody classified.
 *     Caught by asserting every money literal in these trees is either a plan
 *     price or a named, deliberate exception.
 *
 * The second is the one that keeps this honest over time. It is the reason the
 * exception list below spells out *what each amount is*, rather than being a
 * bag of numbers somebody appended to when a test went red.
 */

const root = join(import.meta.dirname, '..', '..', '..')
const read = (rel: string) => readFileSync(join(root, rel), 'utf8')

const COPY = 'apps/web/messages/pt-BR.json'
const TERMS = 'docs/legal/termos-de-uso.md'
const FAQ = 'docs/legal/faq-cobranca.md'
const BRIEF = 'docs/legal/LEGAL_AND_BILLING_BRIEF.md'

const TEMPLATES = [
  'worker/templates/email/founders-welcome.md',
  'worker/templates/email/founders-waitlist.md',
  'worker/templates/email/founders-opening.md',
  'worker/templates/email/payment-confirmation.md',
  'worker/templates/email/price-change-30-days.md',
  'worker/templates/whatsapp/founders-welcome.md',
  'worker/templates/whatsapp/founders-waitlist.md',
  'worker/templates/whatsapp/founders-opening.md',
  'worker/templates/whatsapp/price-change-30-days.md',
  'worker/templates/README.md',
]

/** Everything the money scan below looks at. */
const MONEY_FILES = [COPY, TERMS, FAQ, BRIEF, 'docs/legal/README.md', ...TEMPLATES]

/**
 * Amounts in those files that are **not** a plan price, each with the reason.
 *
 * Adding to this list is meant to feel deliberate: an amount lands here only
 * once someone has decided it is example data, a competitor, or a statistic.
 * A genuinely new plan price belongs in `product.json` instead.
 */
const NOT_A_PLAN_PRICE = new Map<string, string>([
  ['14,60', 'the price-ruler illustration — the target buy price'],
  ['20', 'price ruler: what the winner offered, per resma'],
  ['20,34', 'price ruler: a band edge'],
  ['29', 'price ruler: retail'],
  ['29,29', 'price ruler: a band edge'],
  ['35,87', 'price ruler: a band edge'],
  ['36', 'price ruler: the estimated value'],
  ['10', 'price ruler: scale start'],
  ['40', 'price ruler: scale end'],
  ['397', "a competitor's price, in the comparison table"],
  ['272,6', 'market size statistic, in billions'],
  ['48', 'example tender value (R$ 48 mil / R$ 48.196) — not the seat count'],
  ['48.196', 'example tender value'],
  ['1,25', 'example tender value, in millions'],
  ['4,3', 'example tender value, in millions'],
  ['4,33', 'example tender value, in millions'],
])

/** Every `R$ …` in a file, normalised to just the digits. */
function amountsIn(text: string): string[] {
  return [...text.matchAll(/R\$\s*([\d.]+(?:,\d+)?)/g)].map((m) => m[1].replace(/[.,]$/, ''))
}

describe('the product facts, against every file that quotes them', () => {
  it('names no amount that is neither a plan price nor a listed exception', () => {
    const known = new Set<string>()
    for (const price of Object.values(PLAN_PRICES)) {
      known.add(String(price))
      known.add(`${price},00`)
    }

    const unexplained = new Map<string, string[]>()
    for (const file of MONEY_FILES) {
      for (const amount of amountsIn(read(file))) {
        if (known.has(amount) || NOT_A_PLAN_PRICE.has(amount)) continue
        unexplained.set(amount, [...(unexplained.get(amount) ?? []), file])
      }
    }

    expect(
      Object.fromEntries(unexplained),
      'an amount nobody has classified: put a real plan price in docs/product.json, ' +
        'or add it to NOT_A_PLAN_PRICE with the reason',
    ).toEqual({})
  })

  /**
   * The stale-site check. Each entry is "this fact must still be visible
   * here" — which is exactly the list a price change has to walk.
   */
  const REQUIRED: ReadonlyArray<readonly [string, string[], string]> = [
    [brl(PLAN_PRICES.essencial), [COPY, TERMS, FAQ, BRIEF], 'the Essencial price'],
    [brl(PLAN_PRICES.pro), [COPY, TERMS, BRIEF], 'the Pro price'],
    [brl(PLAN_PRICES.promocional), [COPY, TERMS, FAQ, BRIEF], 'the founder price'],
    [
      brlExact(PLAN_PRICES.promocional),
      [TERMS, 'worker/templates/email/price-change-30-days.md'],
      'the founder price, exact form',
    ],
    [
      brlExact(PROMO.thenBrl),
      [TERMS, 'worker/templates/email/price-change-30-days.md'],
      'the price it becomes, exact form',
    ],
    [String(FOUNDERS.seats), [COPY, TERMS, FAQ, BRIEF], 'the number of founder seats'],
    [String(PROMO.months), [COPY, TERMS, FAQ, BRIEF], 'how many months the founder price lasts'],
    [String(NOTICE.priceChangeDays), [COPY, TERMS, BRIEF], 'the price-change notice period'],
  ]

  it.each(REQUIRED)('%s is still in every file that must carry it (%s)', (value, files) => {
    const missing = files.filter((file) => !read(file).includes(value))
    expect(
      missing,
      `${value} is in docs/product.json but no longer appears in: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('does not let the founder price and its successor drift apart', () => {
    // Two ways of saying the same thing, in two files, and they have gone out
    // of step before: `plans.promocional.thenBrl` is what the founder starts
    // paying in month 7, which is by definition the Essencial price.
    expect(PROMO.thenBrl).toBe(PLAN_PRICES.essencial)
  })

  it('keeps the opening date in step with what the page and the terms promise', () => {
    // 2026-10-08 -> "08/10", the form Brazilian copy uses.
    const [year, month, day] = FOUNDERS.opensOn.split('-')
    expect(read(COPY)).toContain(`${day}/${month}`)
    expect(year).toBe('2026')
  })

  it('formats money the way the catalogue does, without a non-breaking space', () => {
    // `Intl.NumberFormat` emits U+00A0 here, which reads identically and
    // compares unequal — so every assertion above, and every grep a person
    // runs, would silently miss. See `brl`.
    expect(brl(26)).toBe('R$ 26')
    expect(brl(26)).not.toContain(' ')
    expect(brlExact(57)).toBe('R$ 57,00')
  })
})
