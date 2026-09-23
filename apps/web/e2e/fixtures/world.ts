import type {
  CompanyView,
  QuotaView,
  SegmentFit,
  TenderDetail,
  TenderGroup,
  TenderItemView,
  VisitorView,
} from '@/lib/radar/contract'

/**
 * The world the journeys happen in: four people, their companies, and the
 * editais they look at.
 *
 * ## Why these are built here and not read from Postgres
 *
 * `db/seed.py` already loads 20 real PNCP payloads, and running the journeys
 * against a seeded database was the other way to do this. It was not chosen,
 * for two reasons that both come down to **what a red run would mean**:
 *
 *  1. seeded rows go stale — every `proposals_close_at` in the fixtures is a
 *     date in 2026 that will pass, and a journey asserting "13 dias" against a
 *     frozen row starts failing on a Tuesday for reasons that have nothing to
 *     do with the product;
 *  2. a database is shared, and two journeys running at once against the same
 *     `visitors` row would be counting each other's triagens.
 *
 * So the dates below are built **relative to now** and the rows are per-test.
 * Nothing here is frozen, nothing here is shared, and a failure is always
 * about the screens.
 *
 * Every field is typed against `lib/radar/contract.ts`, which is the point of
 * building them in TypeScript: the day a route's envelope changes, these stop
 * compiling and `pnpm typecheck` says so before anybody runs a browser.
 *
 * The CNPJs are **not real companies**. They are 14 digits in the shape the
 * client-side form checks for; the check digits are not computed because the
 * only validator that would look at them lives on the server, which these
 * journeys never reach.
 */

/** 09:30 in Brasília, `n` days from now — the shape of a PNCP deadline. */
export function inDays(n: number): string {
  const date = new Date()
  date.setUTCHours(12, 30, 0, 0) // 09:30 in America/Sao_Paulo (UTC-3)
  date.setUTCDate(date.getUTCDate() + n)
  return date.toISOString()
}

export function daysAgo(n: number): string {
  return inDays(-n)
}

export function segment(name: string, fit: SegmentFit['fit'] = 'compatible'): SegmentFit {
  return {
    segment: name,
    fit,
    fromMainCnae: fit === 'compatible',
    fromSecondaryCnae: fit !== 'compatible',
  }
}

export function company(overrides: Partial<CompanyView> & { cnpj: string }): CompanyView {
  return {
    legalName: null,
    tradeName: null,
    mainCnae: '4761001',
    size: 'MEI',
    isMei: true,
    state: 'SP',
    city: 'Campinas',
    segments: [],
    ...overrides,
  }
}

/**
 * A visitor with the whole 3-day window ahead and both triagens unspent.
 *
 * The expiry is three days **minus an hour**, not three days exactly:
 * `VisitorBanner` prints `Math.ceil(msLeft / 86 400 000)`, so an expiry
 * landing a few minutes past the boundary reads as "4 dias" and the same test
 * would pass in the afternoon and fail at breakfast. An hour of slack makes
 * the banner say "3 dias" at every hour of the day.
 */
export function visitor(overrides: Partial<VisitorView> = {}): VisitorView {
  return {
    expiresAt: new Date(Date.now() + 3 * 86_400_000 - 3_600_000).toISOString(),
    expired: false,
    screeningsUsed: 0,
    screeningsLeft: 2,
    ...overrides,
  }
}

export function visitorQuota(used = 0): QuotaView {
  return {
    feature: 'ai_screening',
    plan: 'visitor',
    period: 'total',
    limit: 2,
    used,
    left: Math.max(0, 2 - used),
  }
}

export function item(number: number, overrides: Partial<TenderItemView> = {}): TenderItemView {
  return {
    number,
    description: `Item ${number} · resma de papel A4 75 g/m², pacote com 500 folhas`,
    kind: 'M',
    quantity: '400.0',
    unit: 'Resma',
    unitEstimatedValue: '36.5000',
    totalValue: '14600.00',
    ncm: '48025590',
    judgmentCriterion: 'Menor preço',
    benefitId: 1,
    benefitName: 'Participação exclusiva para ME/EPP',
    segment: 'Material de escritório e papelaria',
    relevance: 'alta',
    hasAward: false,
    ...overrides,
  }
}

/**
 * A tender, in the shape `GET /api/tenders/:id` answers.
 *
 * The id carries a slash on purpose — `51885242000140-1-000744/2026` is what a
 * `numeroControlePNCP` looks like — because the slash is itself a seam: the
 * page route spells it as two segments and the API route spells it `%2F`
 * (`lib/radar/client.ts`), and a journey that used a slashless id would walk
 * past the encoding every link on the Radar depends on.
 */
export function tender(overrides: Partial<TenderDetail> & { id: string }): TenderDetail {
  return {
    object:
      'AQUISIÇÃO DE MATERIAL DE EXPEDIENTE E PAPELARIA, PROCESSO 2026/0042, PARA AS ' +
      'UNIDADES ADMINISTRATIVAS DA SECRETARIA MUNICIPAL DE EDUCAÇÃO, CONFORME CONDIÇÕES, ' +
      `QUANTIDADES E EXIGÊNCIAS ${OBJECT_TAIL}`,
    agencyName: 'PREFEITURA MUNICIPAL DE CAMPINAS',
    agencyCnpj: '51885242000140',
    unitName: 'SECRETARIA MUNICIPAL DE EDUCAÇÃO',
    city: 'Campinas',
    state: 'SP',
    modalityName: 'Pregão Eletrônico',
    proposalsOpenAt: daysAgo(2),
    proposalsCloseAt: inDays(13),
    estimatedValue: '146000.00',
    confidentialBudget: false,
    priceRegistration: false,
    meEppSummary: 'exclusive',
    favoredTreatment: true,
    itemCount: 7,
    segments: ['Material de escritório e papelaria'],
    matchedSegments: [segment('Material de escritório e papelaria')],
    group: 'compatible',
    status: 'Divulgada no PNCP',
    pncpUpdatedAt: daysAgo(1),
    biddingSystemUrl: 'https://www.gov.br/compras/pt-br',
    items: [item(1), item(2), item(3)],
    // `null`, not `[]`: §8 says the URLs never reach a caller without an
    // account, and the Documentos tab draws its padlock from exactly this.
    files: null,
    closed: false,
    ...overrides,
  }
}

/**
 * The process number a journey uses to find one card among sixty.
 *
 * It survives `cleanTitle()` verbatim — the de-shouting rule leaves any token
 * containing a digit alone — which is why the fixtures carry a marker of this
 * shape rather than a made-up word: a title asserted on "EDITAL 7" would be
 * asserting on the raw string and not on what the reader is shown.
 */
export function processo(n: number): string {
  return `2026/${String(n).padStart(4, '0')}`
}

/**
 * The tail of every fixture object, in the agency's own block capitals.
 *
 * It exists so a journey can tell the three readings of the same text apart:
 * the card trims at 120 characters, the `h1` at 180, and only the Objeto block
 * prints the whole thing, verbatim and unshouted. An object shorter than 180
 * characters would render identically in all three and the assertion would
 * prove nothing.
 */
export const OBJECT_TAIL = 'ESTABELECIDAS NO TERMO DE REFERÊNCIA ANEXO A ESTE EDITAL'

/** `n` tenders that differ in everything a person would use to tell them apart. */
export function tenderRun(
  count: number,
  make: (index: number) => Partial<TenderDetail> = () => ({}),
): TenderDetail[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1
    return tender({
      id: `51885242000140-1-${String(n).padStart(6, '0')}/2026`,
      object:
        `AQUISIÇÃO DE MATERIAL DE EXPEDIENTE, PROCESSO ${processo(n)}, ` +
        `PARA A UNIDADE ADMINISTRATIVA ${n} DA SECRETARIA MUNICIPAL DE EDUCAÇÃO, ` +
        `CONFORME CONDIÇÕES, QUANTIDADES E EXIGÊNCIAS ${OBJECT_TAIL}`,
      proposalsCloseAt: inDays(3 + index),
      estimatedValue: String(10_000 * n),
      itemCount: 1 + (index % 5),
      ...make(index),
    })
  })
}

// ───────────────────────────────── the people ─────────────────────────────────

/**
 * **Dona Marta** — MEI, a papelaria in Campinas. No account, and she must not
 * be asked for one to read an edital.
 */
export const MARTA = {
  cnpj: '11222333000181',
  company: company({
    cnpj: '11222333000181',
    legalName: 'MARTA APARECIDA SOUZA 11222333000181',
    tradeName: 'Papelaria Dona Marta',
    segments: [segment('Material de escritório e papelaria')],
  }),
}

/**
 * **Carla** — bookkeeper. Two clients, two CNPJs, one afternoon and one tab.
 *
 * The trap she exists to catch: `rememberUserCnpj` only ever fills a `null`,
 * so the first company anybody happens to search is the one that sticks. On
 * the screens that has to be invisible — every screen must speak about the
 * CNPJ in the address bar, not about the first one it ever saw.
 */
export const CARLA = {
  limpeza: {
    cnpj: '22333444000172',
    company: company({
      cnpj: '22333444000172',
      legalName: 'BRILHO SERVICOS DE LIMPEZA LTDA',
      tradeName: 'Brilho Limpeza',
      city: 'Americana',
      segments: [segment('Material de limpeza e higiene')],
    }),
  },
  hospitalar: {
    cnpj: '33444555000163',
    company: company({
      cnpj: '33444555000163',
      legalName: 'VIDA COMERCIO DE PRODUTOS HOSPITALARES LTDA',
      tradeName: 'Vida Hospitalar',
      city: 'Piracicaba',
      segments: [segment('Material hospitalar e odontológico')],
    }),
  },
}

/** **Ricardo** — ME, wants the weekly alert on Telegram. */
export const RICARDO = {
  cnpj: '44555666000154',
  company: company({
    cnpj: '44555666000154',
    legalName: 'RICARDO NOGUEIRA SERVICOS DE TI LTDA',
    tradeName: 'Nogueira TI',
    size: 'ME',
    isMei: false,
    segments: [segment('Tecnologia da informação')],
  }),
}

/** The tab an unchosen `?group=` lands on, for the tests that assert it. */
export const GROUPS: readonly TenderGroup[] = ['compatible', 'check', 'keyword']
