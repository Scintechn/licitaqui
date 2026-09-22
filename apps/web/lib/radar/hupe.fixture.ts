import type { TenderDetail } from './contract'

/**
 * The HUPE-RJ tender — the real suspended Pregão that B9 exists because of.
 *
 * Captured from production on 2026-09-22 (`tenders`, `tender_items`,
 * `tender_files` for `42498600000171-1-003750/2026`). This is the tender in
 * `TENDER_STATUS_AND_WATCH.md` §1: HOSPITAL UNIVERSITÁRIO PEDRO ERNESTO, Rio
 * de Janeiro/RJ, Pregão Eletrônico, proposals 04/09 → 22/09 09:59 Brasília,
 * **`situacaoCompraId` 4 / `Suspensa`** — and, on the day the screenshot was
 * taken, `proposals_close_at` still in the future, which is what let the screen
 * print "último dia" over "restantes" above a tenth row reading
 * "Situação: Suspensa".
 *
 * ## Why it is checked in rather than fetched
 *
 * §4 asks for the same fixture twice: B9 renders it and B10 replays it as the
 * `1 → 4` side of the status diff. A fixture that has to be fetched is a
 * fixture that stops working the day the agency edits the record — and PNCP
 * will eventually resume or close this tender, at which point the evidence for
 * the defect disappears. Frozen, it keeps proving the case.
 *
 * ## `situacaoId` is here and nothing reads it yet
 *
 * B9 gates on `status` (the name), which is what `tenders.status` stores. The
 * numeric id is carried alongside because B10's diff wants a key that does not
 * depend on agency-entered spelling, and because recording it here is what
 * makes it clear no migration was needed to get it: production already keeps it
 * in `tenders.raw->>'situacao_id'`.
 */

/** `situacaoCompraId`, from `tenders.raw`. 4 = Suspensa. For B10's diff. */
export const HUPE_SITUACAO_ID = 4

/** When the *agency* last touched the record — the date the banner cites. */
export const HUPE_PNCP_UPDATED_AT = '2026-09-21T18:08:20.474Z'

/**
 * A clock inside the proposal window, so the control case really does render a
 * countdown and the suspended case really does have one to suppress. Without
 * this the test would pass on a closed tender for the wrong reason.
 */
export const HUPE_NOW = new Date('2026-09-22T11:00:00.000Z')

export const HUPE_SUSPENDED: TenderDetail = {
  id: '42498600000171-1-003750/2026',
  agencyCnpj: '42498600000171',
  object:
    'Contratação de empresa especializada, mediante a renovação com upgrade do fornecimento da solução Kaspersky Endpoint Security for Business para Kaspersky NEXT EDR Optimum para o Hospital Universitário Pedro Ernesto.',
  agencyName: 'ESTADO DO RIO DE JANEIRO',
  unitName: 'HOSPITAL UNIVERSITARIO PEDRO ERNESTO',
  city: 'Rio de Janeiro',
  state: 'RJ',
  modalityName: 'Pregão - Eletrônico',
  status: 'Suspensa',
  pncpUpdatedAt: HUPE_PNCP_UPDATED_AT,
  priceRegistration: false,
  proposalsOpenAt: '2026-09-04T11:00:00.000Z',
  proposalsCloseAt: '2026-09-22T12:59:00.000Z',
  estimatedValue: null,
  confidentialBudget: false,
  biddingSystemUrl: null,
  meEppSummary: 'none',
  favoredTreatment: true,
  itemCount: 1,
  segments: ['Software / Sistemas'],
  matchedSegments: [
    {
      segment: 'Software / Sistemas',
      fit: 'compatible',
      fromMainCnae: true,
      fromSecondaryCnae: false,
    },
  ],
  group: 'compatible',
  items: [
    {
      number: 1,
      description:
        'DESCRIÇÃO: SUBSCRICAO DE LICENCA DE USO PARA SOLUCAO DE PROTECAO A DISPOSITIVOS FINAIS (EDR) - PARA ESTACOES DE TRABALHO, INCLUIDO O SUPORTE TECNICO, ORIGEM: PESSOA JURIDICA, FORMA FORNECIMENTO: ANUIDADE',
      kind: 'S',
      quantity: '2650.0',
      unit: 'UN',
      unitEstimatedValue: '232.4333',
      totalValue: '615948.25',
      ncm: null,
      judgmentCriterion: 'Menor preço',
      benefitId: null,
      benefitName: null,
      segment: 'Software / Sistemas',
      relevance: null,
      hasAward: false,
    },
  ],
  files: [
    {
      sequence: 1,
      title: 'Prg 269 2026 HUPE SERV DE SEGURANCA DE ENDPOINTS.docx',
      docType: 'Edital',
      url: 'https://pncp.gov.br/pncp-api/v1/orgaos/42498600000171/compras/2026/3750/arquivos/1',
      publishedAt: '2026-09-03T13:56:15.000Z',
      pages: null,
      noText: false,
    },
  ],
  closed: false,
}

/**
 * The same tender as PNCP published it before the suspension — the control.
 *
 * Every assertion that something disappears when a tender is stopped has a twin
 * asserting it is still there when it is not, because a gate that suppresses
 * urgency everywhere would pass all the suppression tests and ship a product
 * with no countdowns at all.
 */
export const HUPE_DIVULGADA: TenderDetail = {
  ...HUPE_SUSPENDED,
  status: 'Divulgada no PNCP',
}
