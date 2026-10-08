import { PLAN_PRICES, PROMO } from '@/lib/product'

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

/** Brazilian real, ISO 4217. Stated so an amount is never a bare number. */
export const CURRENCY = 'BRL'

export const PLAN_PROMOCIONAL = 'promocional'
export const PLAN_ESSENCIAL = 'essencial'

export type Price = {
  /** `promocional` or `essencial`. One of the four `users.plan` allows. */
  plan: typeof PLAN_PROMOCIONAL | typeof PLAN_ESSENCIAL
  /** What is charged now, in centavos. Exact: `product.json` is whole BRL. */
  cents: number
  /** The same amount as reais, which is what the Asaas `value` field takes. */
  reais: number
  currency: typeof CURRENCY
  /** Whether this is the founder price, i.e. whether it changes later. */
  promotional: boolean
  /** How many months the promotional price lasts, or `null` when it does not. */
  promoMonths: number | null
  /** What it becomes after {@link promoMonths}, or `null`. */
  thenCents: number | null
}

/**
 * The price for an account, from its seat. `null` seat means no seat.
 *
 * Never takes anything the browser sent. `POST /api/subscribe` reads no
 * request body at all — a checkout endpoint that takes a plan or an amount from
 * its caller is a discount waiting to be found.
 */
export function priceFor(founderSeat: number | null): Price {
  if (founderSeat === null) {
    return {
      plan: PLAN_ESSENCIAL,
      cents: PLAN_PRICES.essencial * 100,
      reais: PLAN_PRICES.essencial,
      currency: CURRENCY,
      promotional: false,
      promoMonths: null,
      thenCents: null,
    }
  }
  return {
    plan: PLAN_PROMOCIONAL,
    cents: PLAN_PRICES.promocional * 100,
    reais: PLAN_PRICES.promocional,
    currency: CURRENCY,
    promotional: true,
    promoMonths: PROMO.months,
    // `PROMO.thenBrl` and `PLAN_PRICES.essencial` are the same fact and
    // `product.test.ts` already refuses to let them drift. The promo one is
    // read here because it is the one that describes *this* subscription.
    thenCents: PROMO.thenBrl * 100,
  }
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
