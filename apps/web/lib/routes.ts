/**
 * Where the account controls point.
 *
 * ## U1 flipped the first half of this
 *
 * `/conta/criar` and `/conta` are built, so `ACCOUNT_HREF` is now the real
 * sign-in screen and every control that reads it — the Landing's "Entrar", the
 * Radar's person icon, D4's `quota_exceeded` card — leads to an account
 * instead of to the Offer. `accountHref(next)` therefore starts round-tripping
 * on its own, exactly as the note below said it would.
 *
 * ## E1 flipped the second half
 *
 * `/conta/alertas` is built, so `ALERTS_HREF` is `ALERTS_PATH` and the bell in
 * the app bar goes to the Telegram screen instead of to the Offer. One
 * constant, one edit, exactly as this note promised.
 *
 * ## R2's rule, which has not changed
 *
 * Next prefetches a `<Link>` as it enters the viewport, so a control pointing
 * at an unbuilt route is not merely a dead end when clicked — it is a burst of
 * 404s on every page view (eight of them on `/` in the trace that found it).
 * So no screen hard-codes one of these addresses: every account, alert and plan
 * control reads a constant from this file, `routes.test.ts` sweeps `app/` to
 * prove it, and moving a destination stays one edit here.
 *
 * ## For F2
 *
 * Change this file and nothing else: `PLAN_HREF` becomes `PLAN_PATH` when F2
 * ships the checkout, and move the path from `UNBUILT` to `BUILT` in
 * `routes.test.ts`.
 */

/** Sign in or create an account. Built by U1. */
export const ACCOUNT_CREATE_PATH = '/conta/criar'

/** The alerts and Telegram screen. Built by E1. */
export const ALERTS_PATH = '/conta/alertas'

/** The account screen itself, for someone who is already signed in. */
export const ACCOUNT_PATH = '/conta'

/**
 * Where "Entrar" and "Criar conta" go. U1 built the screen, so this is it.
 */
export const ACCOUNT_HREF: string = ACCOUNT_CREATE_PATH

/**
 * The bell in the app bar. Separate name from `ACCOUNT_HREF`, and it earned
 * that: alerts are E1's and the account is U1's, and they stopped pointing at
 * the same page on different days, which is what the two names were for.
 */
export const ALERTS_HREF: string = ALERTS_PATH

/**
 * The company screen — the CNPJ and changing it (card D22).
 *
 * `/conta` used to be all three account screens at once, with three menu
 * entries pointing at it. Sci's decision, 2026-09-29: split them, so a menu
 * entry leads somewhere that differs from the others.
 */
export const COMPANY_PATH = '/conta/empresa'

/**
 * The favourites section — the tenders a person marked (card D23).
 *
 * *Favoritos*, not *acompanhando*: the design already spends *acompanhar* on
 * following a competitor company (`Concorrentes.dc.html`), and
 * `Alertas.dc.html` promises "quando quem você acompanha ganha", which reads
 * correctly only while that stays true. Sci chose the two words apart on
 * 2026-09-29.
 */
export const FAVOURITES_PATH = '/conta/favoritos'

/**
 * The plan screen. **F2's address for checkout, and now the plan summary.**
 *
 * It has named this path since U1 and was unbuilt until D22 split `/conta`.
 * That is why the split lands here rather than somewhere new: the menu entry
 * that already says "Plano e pagamento" already leads to it.
 *
 * **F2 shipped here**, so this is now the address the terms of use name for
 * cancelling and the screen a founder subscribes from. The date this comment
 * used to carry — 10-29 — was never the one that mattered: `docs/product.json`
 * says the charge starts **17/10** (`founders.opensOn`), and a comment naming
 * a different day in a file about where billing lives is two numbers chosen in
 * different cards that never met (D29's shape, in prose).
 */
export const PLAN_PATH = '/conta/plano'

/**
 * Where "assinar" and the locked blocks send someone today.
 *
 * **Still `/fundadores` after F2, and that is a decision rather than an
 * oversight.** Most readers of a locked block are visitors with no account,
 * and `/conta/plano` would bounce them to `/conta/criar` — losing the sentence
 * that explains what the plan is. The offer page is where somebody *comparing*
 * plans belongs; `PLAN_PATH` is where somebody who has *chosen* one acts, and
 * the plan screen links to this for the comparison.
 *
 * The date this comment used to carry (M5, 10-29) was wrong twice over: F2 has
 * shipped, and the charge starts **17/10** per `docs/product.json`.
 *
 * Repointing this at `PLAN_PATH` once the founders window closes is a product
 * decision, not a tidy-up — carded as **F12** so it is a choice rather than a
 * discovery. The separate name is what makes it one line.
 */
export const PLAN_HREF: string = '/fundadores'

/**
 * The account link, carrying where to come back to.
 *
 * The screening screens want `?next=` so a visitor who signs up lands back on
 * the tender they were reading. The guard below is kept rather than deleted:
 * it is what made the parameter safe to add at every call site before the
 * screen existed, and it is what will make it safe again if `ACCOUNT_HREF` ever
 * has to point somewhere with nowhere to return to.
 */
export function accountHref(next?: string): string {
  if (!next || ACCOUNT_HREF !== ACCOUNT_CREATE_PATH) return ACCOUNT_HREF
  return `${ACCOUNT_CREATE_PATH}?next=${encodeURIComponent(next)}`
}
