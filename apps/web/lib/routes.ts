/**
 * Where the account controls point while the account screens do not exist.
 *
 * The approved canvases put "Criar conta" at `/conta/criar` (task U1) and the
 * bell at `/conta/alertas` (task E1). Neither route is built, and the Landing
 * and the Radar both link to them from the live site — so every `<Link>` to
 * one is prefetched into the viewport as a `404`, eight of them in a single
 * page view of `/`, and a visitor who clicks lands on the branded 404 having
 * been invited to sign up. Founders week starts 09-24; that is the wrong first
 * answer to give traffic.
 *
 * So both destinations are this constant, and this constant is `/fundadores` —
 * the one thing a visitor can actually do today. Turning the prefetch off
 * would have fixed the network trace and left the dead end, which is the half
 * of the problem that matters.
 *
 * ## For U1 and E1
 *
 * Change this file and nothing else: replace `ACCOUNT_HREF` with
 * `ACCOUNT_CREATE_PATH` and `ALERTS_HREF` with `ALERTS_PATH`, both of which are
 * already spelled out below so the intended addresses are not lost. Every
 * control follows, and `routes.test.ts` fails until the screens exist.
 */

/** Task U1's address for "create an account". Not built yet. */
export const ACCOUNT_CREATE_PATH = '/conta/criar'

/** Task E1's address for the alerts screen. Not built yet. */
export const ALERTS_PATH = '/conta/alertas'

/**
 * The one destination every account and alert control uses until U1 and E1
 * ship. One constant, one edit.
 */
export const ACCOUNT_HREF: string = '/fundadores'

/**
 * The bell in the app bar. Separate name, same value: alerts are E1's and the
 * account is U1's, and they will stop pointing at the same page on different
 * days.
 */
export const ALERTS_HREF: string = ACCOUNT_HREF

/** Task F2's address for the plan and checkout screen. Not built yet. */
export const PLAN_PATH = '/conta/plano'

/**
 * Where "assinar" and the locked blocks send someone today.
 *
 * Same value and same reasoning as `ACCOUNT_HREF`: `/conta/plano` belongs to
 * F2, billing does not open until M5 (10-29), and during founders week the
 * honest upgrade path is the offer itself. Separate name because it will stop
 * pointing at the same place the day F2 ships.
 */
export const PLAN_HREF: string = ACCOUNT_HREF

/**
 * The account link, carrying where to come back to.
 *
 * The screening screens want `?next=` so a visitor who signs up lands back on
 * the tender they were reading. While `ACCOUNT_HREF` is the offer page that
 * parameter has nowhere to return to, so it is dropped rather than rendered as
 * a promise the page cannot keep. The day U1 flips `ACCOUNT_HREF` to
 * `ACCOUNT_CREATE_PATH`, every call site starts round-tripping with no further
 * change.
 */
export function accountHref(next?: string): string {
  if (!next || ACCOUNT_HREF !== ACCOUNT_CREATE_PATH) return ACCOUNT_HREF
  return `${ACCOUNT_CREATE_PATH}?next=${encodeURIComponent(next)}`
}
