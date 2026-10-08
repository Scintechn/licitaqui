/**
 * The `?estado=` values `/conta/plano` understands.
 *
 * **Its own module, and not `actions.ts`, for a reason the type-checker and
 * the test suite both miss**: a `'use server'` file may export *only* async
 * functions. Next rejects anything else at build time — not at `tsc --noEmit`,
 * not under Vitest — so a `const` beside the two Server Functions is a green
 * suite and a failed deploy. The same rule is why `plan-view.tsx` imports the
 * type from here rather than from the module that redirects with it.
 *
 * Three readers, and they have to agree: `actions.ts` redirects with one of
 * these, `page.tsx` refuses anything that is not in the list rather than
 * rendering an empty banner, and `plan-view.tsx` turns each into an
 * already-approved `billing.*` sentence.
 */
export const PLAN_STATES = [
  /** Already paying. `billing.confirmed.*`. */
  'ativo',
  /** The subscription exists and Asaas has not produced the invoice yet. */
  'aguardando',
  /** `billing.cancel.done*`. */
  'cancelado',
  /** The cancel found nothing to cancel. */
  'sem-assinatura',
  /** Anything we could not do. `billing.subscribe.error`. */
  'erro',
  /** The rate limiter refused. Rendered as `erro`: it is true of both. */
  'muitas-tentativas',
] as const

export type PlanState = (typeof PLAN_STATES)[number]

/** `?estado=` → a state this screen knows, or `null`. */
export function planState(value: string | string[] | undefined): PlanState | null {
  const one = Array.isArray(value) ? value[0] : value
  return PLAN_STATES.includes(one as PlanState) ? (one as PlanState) : null
}
