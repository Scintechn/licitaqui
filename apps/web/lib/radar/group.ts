import { TENDER_GROUPS, type TenderGroup } from './contract'

/**
 * Which tab the Radar opens on, and what the tabs say about the other two.
 *
 * ## The bug this file exists to end
 *
 * `readGroup()` used to answer `'compatible'` for an absent or unrecognised
 * `?group=`, unconditionally. A search whose hits are all in **Verificar** or
 * **Palavras** therefore opened on an empty **Compatíveis** and read as a
 * defect: on production, `q=pavimentação asfáltica` for CNPJ 36955612000185
 * counts `{ compatible: 0, check: 0, keyword: 36 }` and the screen showed
 * "Nenhum edital compatível agora" with 36 results one chip away.
 *
 * ## Absent is not the same as chosen
 *
 * So `readGroup()` now returns `null` for "the user has not picked a tab", and
 * that is the whole fix: a tab the user clicked is honoured even when it is
 * empty — bouncing someone off a chip they just pressed is worse than an empty
 * list, because it hides the fact that the chip has nothing in it — while an
 * *unchosen* group is decided by `bestGroup()` once the counts are known.
 *
 * `radarHref()` names the group explicitly for every link that carries one, so
 * "explicitly Compatíveis" (`?group=compatible`) and "nothing chosen" (no
 * parameter at all) are different URLs and stay different on a reload.
 */

/** The tab the user asked for, or `null` when they have not asked for one. */
export function readGroup(value: string | null | undefined): TenderGroup | null {
  return (TENDER_GROUPS as readonly string[]).includes(value ?? '')
    ? (value as TenderGroup)
    : null
}

/**
 * The tab to open when nothing was chosen: the first one in `TENDER_GROUPS`
 * order that has results.
 *
 * The order is the product's own claim and not a preference — `compatible`
 * first whenever it has anything, because "editais que a sua empresa consegue
 * atender" is what the Radar is for; `check` before `keyword` because a
 * segment the CNAEs nearly reach is a closer answer than a word match.
 *
 * Every group empty is not a tie to be broken: it falls back to `compatible`,
 * and the screen says so with `allEmpty` copy rather than pretending one of the
 * three is worth opening.
 */
export function bestGroup(counts: Record<TenderGroup, number> | null): TenderGroup {
  if (!counts) return 'compatible'
  return TENDER_GROUPS.find((group) => counts[group] > 0) ?? 'compatible'
}

/** True when there is nothing anywhere — a different fact from "this tab is empty". */
export function everyGroupEmpty(counts: Record<TenderGroup, number> | null): boolean {
  if (!counts) return false
  return TENDER_GROUPS.every((group) => counts[group] === 0)
}

/**
 * The populated tab to point at from an empty one, or `null` when there is
 * none. This is what turns "Nenhum edital compatível agora" from a dead end
 * into "Ver 36 editais em Palavras".
 */
export function otherPopulatedGroup(
  counts: Record<TenderGroup, number> | null,
  active: TenderGroup,
): TenderGroup | null {
  if (!counts) return null
  return TENDER_GROUPS.find((group) => group !== active && counts[group] > 0) ?? null
}
