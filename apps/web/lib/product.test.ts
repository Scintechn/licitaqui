import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { messages } from './messages'
import {
  brl,
  brlExact,
  FOUNDERS,
  NOTICE,
  PLAN_LIMITS,
  PLAN_PRICES,
  PROMO,
  REFUND,
} from './product'

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
const rawFile = (rel: string) => readFileSync(join(root, rel), 'utf8')

const COPY = 'apps/web/messages/pt-BR.json'

/**
 * The catalogue is read **resolved**, every other file **raw**.
 *
 * Since Layer 2 the catalogue no longer contains prices — it contains
 * `{$precoEssencial}`, substituted at load by `messages.ts`. Reading the file
 * off disk would therefore find no price at all and pass vacuously, which is
 * the worst possible failure for a guard whose entire job is noticing absence.
 * So the assertions run against what actually renders.
 */
const read = (rel: string) => (rel === COPY ? JSON.stringify(messages) : rawFile(rel))
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
 * The three `plan_limits` rows the copy sells, from `docs/product.json`.
 *
 * Read through {@link PLAN_LIMITS} rather than typed here, which is the whole
 * point: the table is still the runtime authority and this is the **stated**
 * value both the table and the prose must match. `product.db.test.ts` holds
 * the half this file cannot reach.
 */
const QUOTA = {
  visitorScreenings: PLAN_LIMITS.visitor.screening.quantity,
  visitorDays: PLAN_LIMITS.visitor.days.quantity,
  basicoScreenings: PLAN_LIMITS.basico.screening.quantity,
} as const

/**
 * Every string in the catalogue, as `[path, value]`.
 *
 * Arrays are walked with `Object.entries` like everything else, so an index is
 * a dotted key — `columns.0.0.a`, not `columns[0][0].a`. Spelled the walker's
 * way, which is the convention `keyword-limits.db.test.ts` already uses and
 * the only spelling the assertions below can look up.
 */
function catalogueStrings(node: unknown, path = ''): Array<readonly [string, string]> {
  if (typeof node === 'string') return [[path, node] as const]
  if (node === null || typeof node !== 'object') return []
  return Object.entries(node).flatMap(([key, value]) =>
    catalogueStrings(value, path ? `${path}.${key}` : key),
  )
}

/** `path → value`, for the raw catalogue and for the resolved one. */
const stringsAt = (text: string): Map<string, string> =>
  new Map(catalogueStrings(JSON.parse(text)))

/**
 * **Every catalogue string that names one of those three, pinned by path.**
 *
 * `[path, phrase, which row it is]`, one entry per **key** — not per sentence.
 * Two sentences appear twice in the catalogue (`Seus 3 dias de visitante
 * acabaram` and `ler 5 editais por mês`), and an earlier version of this list
 * covered each pair with a single entry whose check was `resolved.includes`.
 * That is satisfied by **either** of the two, so deleting or rewording one of
 * the pair kept the guard green while that site silently lost cover — the
 * exact failure the "still there" half was added to catch. Pinning by path is
 * what `keyword-limits.db.test.ts` means by *"sweeping them because the regex
 * happens to match is not the same as pinning them"*.
 *
 * Three assertions use it, and they are not interchangeable:
 *
 *  - **raw, at that path**: the phrase must be absent, i.e. the number is a
 *    token. This is the D64 hole.
 *  - **resolved, at that path**: the phrase must be present. Proves the token
 *    resolves back to the sentence that was approved, and that the key still
 *    exists. A sweep that matches nothing passes for free
 *    (`memory: empty-result-is-not-absence`).
 *  - **raw, everywhere**: a *generic* `N triagens` ratchet, which is the only
 *    one of the three that catches a **new** string. See below.
 *
 * **Why `dias` is a list and `triagens` is a regex.** The catalogue says
 * `3 dias` nine times and only four are the visitor window:
 *
 *  - *"3 dias antes de cada cobrança"* — `notice.chargeReminderDays`, five
 *    times (`foundersPage.founderValue.comparisonRows.3.us`,
 *    `foundersPage.faq.columns.1.2.a`, `notifications.billingHelp`,
 *    `radar.landing.plans.body`, `radar.landing.guarantees.2.body`). Approved
 *    copy about a different promise that happens to be three.
 *  - *"até 3 editais por semana"* — the digest size, a third three.
 *
 * So no regex on `3 dias` can exist, and `visitor/days` is covered by this
 * list **only**: a brand-new sentence saying `3 dias` of the visitor window
 * passes, and so does `três dias` anywhere. That is a real limit of this
 * guard, not a wording choice, and D69's row says so. `triagens` has no such
 * collision — after tokenisation the catalogue holds **zero** literal
 * `N triagens` — so that half gets the ratchet the plan prices have.
 */
const QUOTA_CLAIMS: ReadonlyArray<readonly [string, string, string]> = [
  // planLimits.visitor.screening — the two screenings before an account.
  [
    'plans.quota.visitorLeft',
    `suas ${QUOTA.visitorScreenings} triagens gratuitas`,
    'visitor/screening — inside an ICU `=0` branch',
  ],
  [
    'radar.landing.plans.basicVisitorScreenings',
    `${QUOTA.visitorScreenings} triagens de edital por inteligência artificial`,
    'visitor/screening',
  ],
  [
    'radar.landing.faq.columns.0.0.a',
    `faz ${QUOTA.visitorScreenings} triagens por inteligência artificial`,
    'visitor/screening',
  ],
  // planLimits.visitor.days — the three-day window. NOT the charge reminder.
  [
    'radar.landing.plans.basicVisitorGroup',
    `Sem cadastro · ${QUOTA.visitorDays} dias`,
    'visitor/days',
  ],
  [
    'radar.landing.faq.columns.0.0.a',
    `Não nos primeiros ${QUOTA.visitorDays} dias`,
    'visitor/days — this one answer carries both visitor rows',
  ],
  [
    'radar.visitor.expiredTitle',
    `Seus ${QUOTA.visitorDays} dias de visitante acabaram`,
    'visitor/days',
  ],
  [
    'radar.errors.visitorExpired',
    `Seus ${QUOTA.visitorDays} dias de visitante acabaram`,
    'visitor/days — the same sentence, a second key',
  ],
  // planLimits.basico.screening — five a month, and the period is the fact.
  [
    'founders.waitlist.basicNote',
    `${QUOTA.basicoScreenings} triagens de edital por mês`,
    'basico/screening',
  ],
  [
    'plans.basic.feature2',
    `${QUOTA.basicoScreenings} triagens de edital por inteligência artificial por mês`,
    'basico/screening',
  ],
  [
    'plans.quota.visitorSpent',
    `continue com ${QUOTA.basicoScreenings} triagens por mês`,
    'basico/screening — see the note on dead copy below',
  ],
  [
    'plans.quota.basicLeft',
    `suas ${QUOTA.basicoScreenings} triagens deste mês`,
    'basico/screening — inside an ICU `=0` branch',
  ],
  ['billing.cancel.body', `tem ${QUOTA.basicoScreenings} triagens por mês`, 'basico/screening'],
  [
    'radar.visitor.expiredBody',
    `ler ${QUOTA.basicoScreenings} editais por mês`,
    'basico/screening',
  ],
  [
    'radar.screening.quotaVisitorBody',
    `ler ${QUOTA.basicoScreenings} editais por mês`,
    'basico/screening — the same clause, a second key',
  ],
]

/**
 * **Three of those keys are copy nothing renders**, and this guard does not
 * pretend otherwise.
 *
 * `plans.quota.visitorLeft` and `plans.quota.basicLeft` have exactly one
 * reader, `screeningsLeftCaption`, which returns `null` before `left === 0` can
 * choose a string — so their `=0` branches, the two this file sweeps, are
 * unreachable by construction and that file says so deliberately.
 * `plans.quota.visitorSpent` has no reader at all: approved copy rendered
 * nowhere, which is CLAUDE.md's named family.
 *
 * None of that is D69's to fix (it is carded as D74), but it is why the
 * assertion below says *"is no longer in the catalogue"* and not *"no longer
 * renders"*. A test that claims a render it has not seen is the defect this
 * repository keeps finding.
 */
const UNRENDERED = new Set([
  'plans.quota.visitorLeft',
  'plans.quota.basicLeft',
  'plans.quota.visitorSpent',
])

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
  // Refund figures. Not plan prices, and not free-floating either: the fee is
  // in `docs/product.json` and the net is derived from it — both are asserted
  // against the prose by "keeps the refund arithmetic in the prose honest".
  ['1,92', "the acquirer's processing fee, deducted days 8-30 (terms §8)"],
  ['55,08', 'the net refund — derived as promocional minus the fee, never stored'],
  ['1,44', "the fee's annual cost at 25 founders and a 3% refund rate — an "
    + 'estimate in the brief, not a price'],
  ['82,05', 'the 2026 DAS-MEI (comércio) — what the reader already pays monthly, '
    + 'quoted for comparison. Not ours, and not derived from anything here'],
  // The smallest figure `moneyExact` will print, quoted as a threshold rather
  // than as an amount: `radar.price.ceilingBelowCent` says a purchase ceiling
  // is below it. A median of R$ 0,40 at a 99% margin is R$ 0,004, and 376 OK
  // awards sit under R$ 1,00, so the case is reachable and needs its own
  // sentence — telling that reader "Informe a margem" would be telling them
  // to redo what they just did (E17).
  ['0,01', 'the one-centavo floor below which a purchase ceiling cannot be '
    + 'printed — a threshold in the copy, not a price'],
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
    // Legal files only, deliberately. Since Layers 2 and 3 the catalogue and
    // the templates carry tokens, so they cannot go stale — a value that no
    // longer appears there means the binding broke, which the resolution test
    // below catches far more precisely than a substring search would.
    [brlExact(PLAN_PRICES.promocional), [TERMS], 'the founder price, exact form'],
    [brlExact(PROMO.thenBrl), [TERMS], 'the price it becomes, exact form'],
    [String(FOUNDERS.seatsTotal), [COPY, TERMS, FAQ, BRIEF], 'the number of founder seats'],
    // **The phrase, not the bare number.** This asserted `"3"` until
    // 2026-09-27, and passed on `"3 DIAS GRÁTIS"` while every one of these
    // files still promised six months and a price change in month 7. A digit
    // is in almost any document; the clause is the fact.
    [
      `${PROMO.months} primeiros meses`,
      [COPY, TERMS, FAQ],
      'how many months the founder price lasts',
    ],
    [`${PROMO.months} months`, [BRIEF], 'the promo length, in the English brief'],
    [`${PROMO.months + 1}º mês`, [COPY, TERMS, FAQ], 'the month the new price starts'],
    [`month ${PROMO.months + 1}`, [BRIEF], 'the month the new price starts, in the brief'],
    [String(NOTICE.priceChangeDays), [COPY, TERMS, BRIEF], 'the price-change notice period'],
    /**
     * **The three quota rows, in the terms' entitlement table (§5).**
     *
     * The catalogue is not listed here for the same reason the exact prices are
     * not: since D69 it carries `{$triagensVisitante}`, `{$diasVisitante}` and
     * `{$triagensBasico}`, so it cannot go stale — the catalogue half is the
     * sweep at the bottom of this file. The terms are prose, because an
     * entitlement table is a contract clause (legal brief §5), so they are
     * exactly the file that *can* go stale, and `plan_limits` moving under
     * them is what D69 was opened for.
     *
     * Each is the **phrase**, never the digit. `3` alone is in almost any
     * document — the charge reminder, the digest size, the promo length — and
     * `2` and `5` more so.
     *
     * **And each phrase is anchored inside its own clause, which the first
     * version was not.** `até 3 dias` and `2 triagens por IA` both read fine
     * today and both go **false-green the moment the number moves**, which is
     * the only event they exist for:
     *
     *  - raise the window to 7 and `até 7 dias` matches §8's *"pode desistir
     *    em até 7 dias corridos"* — the CDC right of withdrawal, a different
     *    clause. 30 matches the refund guarantee the same way.
     *  - raise the visitor's allowance to 5 and `5 triagens por IA` matches
     *    **Básico's** row, because the visitor's phrase is a strict prefix of
     *    it, and the visitor's own clause could then say anything.
     *
     * So the surrounding words come along: `Uso por até N dias` and
     * `palavra-chave; N triagens por IA` occur once each, in the §5 row they
     * are about. This is the same correction the comment above records for
     * 2026-09-27, one step further — a digit is in almost any document, and a
     * short phrase is in more of one than you would think.
     */
    [
      `Uso por até ${QUOTA.visitorDays} dias`,
      [TERMS],
      "the visitor window, in the terms' entitlement table (§5)",
    ],
    [
      `palavra-chave; ${QUOTA.visitorScreenings} triagens por IA`,
      [TERMS],
      "the visitor's screenings, in the same §5 row",
    ],
    [
      `**${QUOTA.basicoScreenings} triagens por IA por mês**`,
      [TERMS],
      "Básico's screenings, per month — the bold is part of the clause",
    ],
  ]

  it.each(REQUIRED)('%s is still in every file that must carry it (%s)', (value, files) => {
    const missing = files.filter((file) => !read(file).includes(value))
    expect(
      missing,
      `${value} is in docs/product.json but no longer appears in: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('keeps the refund arithmetic in the prose honest', () => {
    /**
     * **The rule Sci flagged: a clause with no number in it is invisible to a
     * guard that keys on numbers.**
     *
     * `R$ 55,08` is not stored anywhere — it is `promocional − processingFee`,
     * written out in four places as prose. Storing it would be a second copy
     * of a derived value, which is how two numbers that must agree stop
     * agreeing. So it is computed here and the prose is checked against it.
     */
    const fee = REFUND.processingFeeBrl
    const net = (PLAN_PRICES.promocional - fee).toFixed(2).replace('.', ',')
    const feeText = fee.toFixed(2).replace('.', ',')

    for (const file of [TERMS, FAQ]) {
      expect(read(file), `${file} should quote the net refund R$ ${net}`).toContain(net)
      expect(read(file), `${file} should quote the processing fee R$ ${feeText}`).toContain(feeText)
    }
  })

  it('states both refund windows wherever it states either', () => {
    // The statutory 7-day window and our 30-day guarantee are different rules
    // with different amounts, and the statutory one wins when both apply.
    // A file that mentions one and not the other is the shape of the mistake.
    for (const file of [TERMS, FAQ]) {
      const text = read(file)
      expect(text, `${file} mentions the guarantee window`).toContain(
        `${REFUND.guaranteeDays} dia`,
      )
      expect(text, `${file} mentions the statutory window`).toContain(`${REFUND.statutoryDays} `)
    }
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

  it('leaves no product fact written by hand in the catalogue', () => {
    /**
     * **The Layer 2 ratchet.** Resolving tokens is only half the work; the
     * other half is making sure nobody types `R$ 57` into a new string next
     * month and quietly re-creates the problem. The catalogue *source* must
     * carry tokens, never the numbers.
     *
     * Deliberately scoped to plan prices and the seat count. Example figures —
     * the price ruler, `R$ 48 mil`, the competitor's `R$ 397/mês` — are copy
     * about the world, not facts about the product, and templating them would
     * be worse than leaving them alone.
     */
    const source = rawFile(COPY)

    const handwritten = Object.entries(PLAN_PRICES)
      .map(([plan, price]) => ({ plan, literal: brl(price) }))
      .filter(({ literal }) => new RegExp(`${literal.replace('$', '\\$')}(?![\\d.,])`).test(source))
      .map(({ plan, literal }) => `${literal} (plans.${plan})`)

    expect(
      handwritten,
      'a plan price is typed into pt-BR.json — use the {$preco…} token so one edit ' +
        'to docs/product.json reaches every string',
    ).toEqual([])

    // The seat count, in the phrases it actually appears in.
    const seats = String(FOUNDERS.seatsTotal)
    const seatPhrases = [`${seats} vagas`, `${seats} fundadores`, `${seats} assinantes`]
    expect(
      seatPhrases.filter((phrase) => source.includes(phrase)),
      'the seat count is typed into pt-BR.json — use {$vagas}',
    ).toEqual([])

    /**
     * **The opening date and hour, added 2026-10-03 because this is the class
     * that actually bit.** `aberturaData` was derived, correct, and read by
     * nothing: two strings carried `08/10` by hand, so moving the opening to
     * 17/10 in `docs/product.json` would have left the founders badge and the
     * opening `when` advertising a date that had passed.
     *
     * Scoped to the **opening date's own value**, exactly as the price guard
     * above is scoped to the actual plan prices. A first attempt refused any
     * `DD/MM` and immediately flagged `16/09` and `30/09` — the sample edital
     * from Campinas on the landing page. Those are copy about the world, which
     * this block's own reasoning says to leave alone, so the wider rule was
     * wrong rather than the copy.
     */
    const [, month, day] = FOUNDERS.opensOn.split('-')
    const openingDate = `${day}/${month}`
    expect(
      source.includes(openingDate) ? [openingDate] : [],
      `the opening date (${openingDate}) is typed into pt-BR.json — use ` +
        '{$aberturaData} so one edit to docs/product.json reaches every string',
    ).toEqual([])

    const openingHour = `${Number(FOUNDERS.opensAtBrt.split(':')[0])}h`
    expect(
      source.includes(openingHour) ? [openingHour] : [],
      `the opening hour (${openingHour}) is typed into pt-BR.json — use {$aberturaHora}`,
    ).toEqual([])

    /**
     * **The quota numbers, added by D69 because D64 removed the last guard on
     * them.** `2 triagens`, `3 dias` and `5 triagens por mês` are
     * `plan_limits` rows the copy *sells*, and they were pinned only
     * incidentally — literals inside route-contract suites, which D64 was
     * right to delete and which left nothing behind. A migration lowering
     * Básico to 3 was silent while thirteen strings kept promising five.
     *
     * Three halves, none of them optional. See {@link QUOTA_CLAIMS} for why
     * `dias` is a list and `triagens` is a regex, and which `3 dias` is which.
     */
    const rawStrings = stringsAt(source)
    const resolvedStrings = stringsAt(read(COPY))

    // 1. Nothing typed by hand at a path this guard knows.
    const typedByHand = QUOTA_CLAIMS.filter(
      ([path, phrase]) => rawStrings.get(path)?.includes(phrase) ?? false,
    ).map(([path, phrase, row]) => `${path} types "${phrase}" (${row})`)
    expect(
      typedByHand,
      'a plan_limits quantity is typed into pt-BR.json — use {$triagensVisitante}, ' +
        '{$diasVisitante} or {$triagensBasico} so one edit to docs/product.json ' +
        'reaches every string, and product.db.test.ts can hold the table to it',
    ).toEqual([])

    /**
     * 2. **And the sentence is still there, at that key.** Without this the
     * half above passes for free on a key somebody deleted or reworded.
     *
     * Deliberately *"in the catalogue"* and not *"renders"*: three of these
     * keys are read by nothing or by a branch nothing reaches
     * ({@link UNRENDERED}), and a test must not claim a screen it has not
     * seen.
     */
    const vanished = QUOTA_CLAIMS.filter(
      ([path, phrase]) => !(resolvedStrings.get(path)?.includes(phrase) ?? false),
    ).map(
      ([path, phrase, row]) =>
        `${path} no longer carries "${phrase}" (${row})` +
        (UNRENDERED.has(path) ? ' — note this key renders nowhere today, see D74' : ''),
    )
    expect(
      vanished,
      'a quota sentence this guard pins is no longer in the catalogue at its own ' +
        'key: either the token binding broke, or the copy moved or was reworded ' +
        'and QUOTA_CLAIMS must follow it (a reworded sentence is a decision, not ' +
        'a silent loss of cover)',
    ).toEqual([])

    /**
     * 3. **The ratchet — the only half that catches a string nobody listed.**
     *
     * `N triagens` is sweepable generically because, unlike `3 dias`, it
     * collides with nothing: after tokenisation the catalogue holds zero
     * literal `N triagens`, and the ICU `one` branches say `1 triagem`,
     * singular. So this is the same shape as the plan-price guard above — a
     * pattern built from the **actual value** — and a new string in any
     * phrasing fails here rather than slipping past the list.
     *
     * **One row, two nouns.** `basico/screening` is sold as both
     * *"N triagens … por mês"* and *"ler N editais por mês"*, and a ratchet
     * on the first noun alone would miss a new string using the second —
     * which is D74(4)'s *"a guard a synonym defeats is a guard against one
     * phrasing"*, one noun earlier. So each row lists the nouns the catalogue
     * actually uses for it. `editais por mês` is safe to sweep and the bare
     * `editais` is not: the catalogue says `3 editais` of the weekly digest
     * and `8 editais` of the sample copy, and only the tokenised Básico
     * sentences put a count of editais *per month*. Adding a noun here needs
     * that same check.
     *
     * `{$diasVisitante}` has no equivalent and cannot get one. That gap is
     * named in {@link QUOTA_CLAIMS} and in D69's row.
     */
    const screeningRatchet = [
      [QUOTA.visitorScreenings, 'visitor/screening', '{$triagensVisitante}', ['triagens']],
      [
        QUOTA.basicoScreenings,
        'basico/screening',
        '{$triagensBasico}',
        ['triagens', 'editais por mês'],
      ],
    ] as const
    const handwrittenScreenings = screeningRatchet.flatMap(([quantity, row, token, nouns]) =>
      nouns.flatMap((noun) =>
        [...rawStrings]
          .filter(([, value]) => new RegExp(`(?<![\\d.,])${quantity} ${noun}`).test(value))
          .map(([path]) => `${path} types "${quantity} ${noun}" (${row} — use ${token})`),
      ),
    )
    expect(
      handwrittenScreenings,
      'a screening quota is typed into pt-BR.json in a phrasing QUOTA_CLAIMS does ' +
        'not list — use the token; every legitimate one is already bound',
    ).toEqual([])
  })

  it('resolves every token it is given, leaving none on screen', () => {
    // `substituteFacts` leaves an unknown `{$typo}` in place rather than
    // dropping it, on the same reasoning `format` gives for `{typo}`: a
    // mistake should be visible, not invisible. Visible in a *test*, though —
    // not to a founder reading the offer.
    const unresolved = [...JSON.stringify(messages).matchAll(/\{\$(\w+)\}/g)].map((m) => m[1])

    expect(
      [...new Set(unresolved)],
      'a {$token} in pt-BR.json has no matching fact in PRODUCT_FACTS (messages.ts)',
    ).toEqual([])
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
