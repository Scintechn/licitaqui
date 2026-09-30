import { format, messages } from '@/lib/messages'
import type { QuotaView } from '@/lib/radar/contract'

/**
 * *"Restam 3 triagens neste mês"* — the caption under the action bar's button
 * (D25 (4)), or `null` when there is nothing true to say.
 *
 * ## The strings were already approved and rendered nowhere
 *
 * `plans.quota.visitorLeft` and `plans.quota.basicLeft` have been in
 * `pt-BR.json` since the plans page was written, and a grep of `app/` and
 * `components/` finds **no reader**. That is this repository's named defect —
 * `radar.list.changeCompany` and `radar.opportunity.screeningCost` are the
 * other two — and it is why this card needs no new copy: it needs the two
 * sentences wired to the screen they were written for.
 *
 * ## Why it stops at `left > 0`
 *
 * Both strings have an `=0` branch, and both **name the plan's limit** in it:
 * *"Você já usou suas 5 triagens deste mês"*. That number lives in
 * `plan_limits`, not in the copy, and B27 is what it costs to print a limit
 * from memory instead of from the row — a Launch database measured against
 * Free's 0.5 GB and reported at 338%. So the exhausted state is not this
 * caption's to tell. It already has a screen of its own,
 * `radar.screening.quotaTitle`, which reads the real total, and the button
 * above this caption leads there.
 *
 * ## Why an unlimited plan gets nothing
 *
 * `left` is `null` when `plan_limits.quantity` is null, which is
 * `promocional`, `essencial` and `pro`. There is no count to show, and
 * inventing a *"sem limite"* caption under the button would put a second
 * sentence about the plan on a screen that already carries one. The morning
 * founders week opened, "Usa 1 das suas triagens" ran for six hours under a
 * button on plans whose own feature list says *"Triagens de edital sem
 * limite"*; the lesson there was to say nothing rather than to say something
 * adjacent.
 */
export function screeningsLeftCaption(screenings: QuotaView | null): string | null {
  if (screenings === null) return null
  const { left, plan } = screenings
  // `null` is unlimited, and 0 belongs to the quota screen, not here.
  if (left === null || left <= 0) return null

  // Only the two plans the approved copy actually speaks for. A plan with a
  // limit and no sentence of its own gets silence rather than a sentence
  // written for somebody else's quota.
  const line =
    plan === 'visitor'
      ? messages.plans.quota.visitorLeft
      : plan === 'basico'
        ? messages.plans.quota.basicLeft
        : null
  return line === null ? null : format(line, { count: left })
}
