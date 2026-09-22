import type { TenderCard, TenderGroup } from './contract'

/**
 * The three tenders in the Landing's "Exemplo" panel — the only thing on the
 * page that shows what the Radar gives you before you type a CNPJ.
 *
 * ## They are real, and they are frozen
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
 * They are **not** a live query, and the page says so. `EXAMPLE_NOW` freezes the
 * clock the countdown is measured against, so the panel reads "13 dias" for as
 * long as it is on the page rather than counting down to a date in the past —
 * and the caption next to it names that date. A panel that silently aged would
 * be claiming, next year, that a tender closed in 2026 is still open.
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
 * The instant the example is stated as of: 17/09/2026, 09:00 Brasília.
 *
 * The wireframes' "13 dias" is counted from this date (`docs/design/README.md`),
 * and `deadlineLabel` counts Brasília calendar days, so every card below reads
 * exactly as the board draws it.
 */
export const EXAMPLE_NOW = new Date('2026-09-17T12:00:00.000Z')

/** `17/09/2026` — what the caption under the panel tells the visitor. */
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
  // The landing's frozen examples are deliberately Divulgada: they exist to
  // show the product working normally, and the gate in `tender-status.ts` is
  // what would otherwise strip their countdowns.
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
