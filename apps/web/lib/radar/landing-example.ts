import type { TenderCard, TenderGroup } from './contract'

/**
 * The three tenders in the Landing's "Exemplo" panel — the only thing on the
 * page that shows what the Radar gives you before you type a CNPJ.
 *
 * ## The facts are frozen. The clock is not.
 *
 * These are the three tenders the approved landing
 * (`paginas/landing_radar.html`) and the Radar wireframe
 * (`design/wireframes/Editais.dc.html`) both draw. Every field below is
 * transcribed from the PNCP responses and the hand-checked answer keys the POCs
 * captured on **16/09/2026** (`gabaritos/01_EditalPE221_26.json`,
 * `01_PE_90177_2026_-_GOV_69.json`, `01_Edital_Pregao_BBMNet.json`): the PNCP
 * control numbers, the estimated values to the centavo, the item counts, the
 * session times and the ME/EPP regimes.
 *
 * Those fields are facts about three real editais, and they are right for as
 * long as the file says nothing else. **A countdown is not one of them.** It is
 * a statement about *now*, and `EXAMPLE_NOW` used to supply a `now` of
 * 17/09/2026 — which made every card read "13 dias" and "Proposta até 30/09"
 * for ever. That was true on the day it was written and false from 01/10/2026:
 * three tenders whose stated deadline had passed, each under a live-looking
 * countdown, on the page that introduces the product (card D11). Moving the
 * dates forward would only have re-dated the same defect.
 *
 * So the panel is rendered against the **real** clock — build time and every
 * ISR revalidation, `America/Sao_Paulo` like every other date the product shows
 * — and the card's own gate decides what may be said about time:
 * `mayShowUrgency` (§2.2 rule 6) drops the countdown and relabels the date
 * *"Data anterior"* once the window has closed. Up to the session hour of each
 * card — 07:30, 08:30 and 09:00 Brasília on 30/09/2026, not one date for all
 * three — the panel counts real days down; after it, they are three dated
 * examples that no longer claim to be open.
 *
 * Two honest limits on that, because "true whenever it renders" is the claim
 * this file would otherwise be making and it is not quite the claim it can keep:
 *
 *  - the *transition* is a render behind, not instant. The Landing is static
 *    with `revalidate = 600` and stale-while-revalidate, so a copy generated
 *    minutes before a session hour keeps being served after it — ten minutes on
 *    a busy page, longer on a quiet one, and a promote or rollback serves that
 *    deployment's build clock. Bounded by the cache, where the frozen clock was
 *    unbounded and permanent;
 *  - the *status* is a transcription. `mayShowUrgency` asks two questions and
 *    only one of them has a live answer here: the hour is real, but "Divulgada
 *    no PNCP" is what PNCP said on 17/09/2026. If an órgão suspended one of
 *    these three after that date, nothing in this file can know, and the panel
 *    would keep counting its days down. That is a limit of any frozen example,
 *    and it is the reason `example-radar.tsx` is not a substitute for a live
 *    Radar — the caption says as much.
 *
 * What still says "as of 17/09/2026" is `EXAMPLE_AS_OF`, in the caption: the
 * date these *facts* were checked. That is a citation, not a countdown.
 *
 * `example-radar.test.tsx` renders the Landing at five instants — including
 * 01/10/2026 and 2030 — and fails if any of them puts urgency copy over a
 * deadline that has passed.
 *
 * ## Why they are not links
 *
 * The Landing is public and static. Linking a visitor to
 * `/radar/edital/51885242000140-1-000744/2026` would send them to whatever the
 * database holds for that id today — a 404 once PNCP drops it, or a tender that
 * closed long ago dressed up as a result. `example-radar.tsx` renders the same
 * `TenderCardView` the Radar uses, with `href={null}`.
 */

/**
 * `17/09/2026` — the date the fields below were checked, quoted by the panel's
 * caption and by the Opportunity section's source line.
 *
 * **Not a clock.** There used to be an `EXAMPLE_NOW` beside this string, and the
 * countdowns were measured from it; see the block above for why there is not
 * one now. Nothing may render a duration, a countdown or an "open/closed"
 * judgement from this constant: it dates the transcription, and a reader is told
 * so ("como estavam em {data}").
 */
export const EXAMPLE_AS_OF = '17/09/2026'

/** The segment the example company sells into, for the panel's header line. */
export const EXAMPLE_STATE = 'SP'

/**
 * Campinas/SP, pregão 221/2026 — the tender the "Oportunidade" section opens up
 * further down the page. R$ 48.196,00 over 7 items, every one of them exclusive
 * to ME/EPP.
 */
const BATTERIES: TenderCard = {
  id: '51885242000140-1-000744/2026',
  object: 'Registro de preços de baterias e pilhas',
  shortTitle: null,
  agencyName: 'Prefeitura de Campinas',
  city: null,
  state: 'SP',
  modalityName: 'Pregão eletrônico',
  proposalsCloseAt: '2026-09-30T08:30:00-03:00',
  estimatedValue: '48196.00',
  confidentialBudget: false,
  priceRegistration: true,
  meEppSummary: 'exclusive',
  // The answer key records the ME/EPP regime, not the favoured-treatment flag;
  // `null` says "not recorded" rather than asserting a fact nobody checked.
  favoredTreatment: null,
  itemCount: 7,
  segments: [],
  matchedSegments: [],
  group: 'compatible',
  // Divulgada because that is what PNCP said on 17/09/2026 — the órgão never
  // suspended, revoked or annulled this one. It is the status that lets the
  // gate in `tender-status.ts` speak about the deadline at all, and after
  // 30/09/2026 what it says is "Data anterior": the tender closed on time,
  // which is a different fact from having been stopped.
  status: 'Divulgada no PNCP',
  pncpUpdatedAt: null,
}

/**
 * Rede Mário Gatti, Campinas/SP, pregão 69/2026 — R$ 1.249.376,49 over 20 items,
 * "ampla + cota + exclusivos" in the answer key, which is `mixed` on the wire.
 * It is in `check` because it asks for a sanitary licence the CNAE alone does
 * not prove.
 */
const HOSPITAL: TenderCard = {
  id: '47018676000176-1-000383/2026',
  object: 'Registro de preços de materiais hospitalares',
  shortTitle: null,
  agencyName: 'Rede Mário Gatti',
  city: 'Campinas',
  state: 'SP',
  modalityName: 'Pregão eletrônico',
  proposalsCloseAt: '2026-09-30T09:00:00-03:00',
  estimatedValue: '1249376.49',
  confidentialBudget: false,
  priceRegistration: true,
  meEppSummary: 'mixed',
  favoredTreatment: null,
  itemCount: 20,
  segments: [],
  matchedSegments: [],
  group: 'check',
  status: 'Divulgada no PNCP',
  pncpUpdatedAt: null,
}

/**
 * Americana/SP, pregão eletrônico 091/2025 — R$ 4.330.766,67, no ME/EPP quota at
 * all, only the favoured treatment the law gives small companies. It is in
 * `keyword` because nothing in the example company's CNAEs covers software.
 */
const SAAS: TenderCard = {
  id: '45781176000166-1-000804/2026',
  object: 'Locação de sistema web (SaaS)',
  shortTitle: null,
  agencyName: 'Prefeitura de Americana',
  city: null,
  state: 'SP',
  modalityName: 'Pregão eletrônico',
  proposalsCloseAt: '2026-09-30T07:30:00-03:00',
  estimatedValue: '4330766.67',
  confidentialBudget: false,
  priceRegistration: false,
  meEppSummary: 'none',
  favoredTreatment: true,
  itemCount: 3,
  segments: [],
  matchedSegments: [],
  group: 'keyword',
  status: 'Divulgada no PNCP',
  pncpUpdatedAt: null,
}

/** In the board's order: compatible, then check, then keyword. */
export const EXAMPLE_TENDERS: readonly TenderCard[] = [BATTERIES, HOSPITAL, SAAS]

/**
 * The counts on the panel's three tabs.
 *
 * Derived from the list, never written down: the tabs on the real Radar say how
 * many tenders are in each group, and an example panel that claimed "12" over a
 * list of one would be inventing a number the visitor cannot check.
 */
export function exampleCounts(
  tenders: readonly TenderCard[] = EXAMPLE_TENDERS,
): Record<TenderGroup, number> {
  const counts: Record<TenderGroup, number> = { compatible: 0, check: 0, keyword: 0 }
  for (const tender of tenders) counts[tender.group] += 1
  return counts
}
