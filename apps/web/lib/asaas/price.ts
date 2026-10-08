import { PLAN_PRICES } from '@/lib/product'

/**
 * What this account pays, resolved from its founder seat — task **F2**.
 *
 * ## Nothing here is a number
 *
 * Every amount and every month count is read from `docs/product.json` through
 * `lib/product.ts`. That is the whole point of this file and the reason it is
 * four lines of arithmetic rather than a table of constants.
 *
 * The version of this module that sat parked in a worktree from 2026-09-25
 * declared `PROMO_PRICE_CENTS = 2_600`, `ESSENCIAL_PRICE_CENTS = 5_700` and
 * `PROMO_MONTHS = 6`, and its own docstring said why that was dangerous: *"the
 * screen quietly promising R$ 26 and Asaas quietly charging R$ 57 is a
 * chargeback and a CDC art. 30 problem, not a display bug"*. It was right, and
 * by 2026-10-08 it was **itself** the wrong half: the live ladder is R$ 57 for
 * **3** months then R$ 75 (`docs/product.json`), so those three constants would
 * have charged a founder R$ 26 against a page promising R$ 57 — the same defect
 * the comment warned about, in the opposite direction, which is what a
 * duplicated number does while nobody is looking. #257 fixed the same shape in
 * the opening e-mail on 2026-10-05.
 *
 * So there is no second copy to keep in step and no guard needed to prove the
 * two agree. `product.test.ts` additionally fails if a money literal ever
 * reappears anywhere under `lib/asaas/`.
 *
 * ## Money
 *
 * `docs/product.json` holds whole BRL, so `cents` is exact by construction and
 * never a float. Asaas's `value` field wants reais as a decimal, which is
 * {@link Price.reais} — the one place the conversion happens.
 *
 * ## The rule itself, which is Sci's and locked
 *
 * `docs/CLAIMS.md:70`, Sci on 2026-09-25: the opening and the payment both
 * start on the opening day; a founder subscribes to Essencial at the
 * promotional price. The promotional price applies only while seats remain —
 * and because a seat is assigned at signup and `users.founder_seat` is unique,
 * *"no seats remain"* and *"this account has no seat"* are the same fact. There
 * is no live count to race against.
 */

export const PLAN_PROMOCIONAL = 'promocional'
export const PLAN_ESSENCIAL = 'essencial'

/**
 * **Two fields, because two is what anything reads.**
 *
 * The first draft also returned `cents`, `currency`, `promotional`,
 * `promoMonths` and `thenCents`. `checkout.ts` reads `.plan` and `.reais`; the
 * other five were read **only by this module's own test** — which is
 * `radar.opportunity.screeningCost`'s shape exactly, one of the five CLAUDE.md
 * names: written, tested, never passed. Review found it. They are gone rather
 * than carded, because the right size for a thing nothing reads is nothing.
 *
 * The promotional window is not lost: `entitlement.ts` reads `PROMO.months`
 * from `lib/product.ts` when it dates `promo_ends_on`, which is the only place
 * that number decides anything.
 */
export type Price = {
  /** `promocional` or `essencial`. One of the four `users.plan` allows. */
  plan: typeof PLAN_PROMOCIONAL | typeof PLAN_ESSENCIAL
  /** Reais as a decimal — what the Asaas `value` field takes. */
  reais: number
}

/**
 * The price for an account, from its seat. `null` seat means no seat.
 *
 * Never takes anything the browser sent. `POST /api/subscribe` reads no
 * request body at all — a checkout endpoint that takes a plan or an amount from
 * its caller is a discount waiting to be found.
 */
export function priceFor(founderSeat: number | null): Price {
  return founderSeat === null
    ? { plan: PLAN_ESSENCIAL, reais: PLAN_PRICES.essencial }
    : { plan: PLAN_PROMOCIONAL, reais: PLAN_PRICES.promocional }
}

/**
 * **There is no money formatter here, deliberately.**
 *
 * The 2026-09-25 draft of this module carried a hand-rolled `formatBrl(cents)`
 * with a correct argument for existing — `Intl`'s BRL output puts a
 * non-breaking space between the symbol and the digits, which the approved
 * catalogue does not. The repository had already solved that: `moneyExact()`
 * in `lib/radar/format.ts` is `Intl` with the space replaced, it is what the
 * items table and the price screen already print, and it refuses a figure that
 * formats as `R$ 0,00` rather than fabricating one.
 *
 * A second formatter in a file whose whole subject is *"one number, one
 * place"* would be the same mistake one level up. The plan screen calls
 * `moneyExact`.
 */
