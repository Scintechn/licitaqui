import { format, messages } from '@/lib/messages'

/**
 * The lite screening answer, turned into rows a screen can print.
 *
 * `ai_analyses.result` is **a language model's JSON**, not our schema. The
 * prompt in `worker/licitaqui/prompts.py` asks for the shape below and the
 * worker stores whatever came back — so every field here is read defensively
 * and a missing, mistyped or unexpected value produces no row rather than
 * `undefined` on the page. That is the difference between a screen that
 * degrades and one that goes blank on the first edital that surprises us.
 *
 * ## Page references are the point
 *
 * Canvas 04 prints the page of the edital every finding came from, and that is
 * the card's acceptance criterion: an analysis a person cannot check against
 * the source is not evidence, it is an opinion. Each claim in the lite answer
 * carries `pagina`, and `citation_check.findings` carries the worker's verdict
 * on that page (`worker/licitaqui/ai_tender.py::check_citations`): it verified
 * that the page exists, that it was one of the pages actually sent to the
 * model, and that it talks about the subject being claimed.
 *
 * So a page is printed with the verdict attached. `confere` prints plainly;
 * anything else prints the number **and** says it did not check out. Hiding an
 * unverified citation would be worse than not citing at all — the reader would
 * trust a number the worker already knows is wrong.
 *
 * ## The arithmetic comes from `rules`, never from `result`
 *
 * The prompt forbids the model to calculate (five of twelve models in POC 4 got
 * the minimum capital wrong). `compute_rules` does the two sums that matter in
 * Python and writes them to the `rules` column, so `minimum_capital_brl` and
 * `term_months` are read from there and only fall back to the model's own text
 * for the wording of the requirement.
 */

const copy = messages.radar
const fields = copy.fields
const values = copy.values

// ───────────────────────────── reading the blob ─────────────────────────────

type Blob = Record<string, unknown>

function obj(value: unknown): Blob | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Blob)
    : null
}

function str(value: unknown): string | null {
  if (typeof value === 'string') {
    const clean = value.replace(/\s+/g, ' ').trim()
    return clean === '' ? null : clean
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function bool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  return null
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    // The model is told to answer numbers, but "10 dias" and "R$ 1.234,56" do
    // turn up. Read the first number in Brazilian notation, or give up.
    const match = value.replace(/\s/g, '').match(/-?\d[\d.]*(,\d+)?/)
    if (!match) return null
    const parsed = Number(match[0].replace(/\./g, '').replace(',', '.'))
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/** The `pagina` of a claim, as a positive integer or nothing. */
function page(value: unknown): number | null {
  const node = obj(value)
  const raw = num(node ? node.pagina : value)
  if (raw === null) return null
  const rounded = Math.round(raw)
  return rounded > 0 ? rounded : null
}

// ─────────────────────────────── the view model ──────────────────────────────

/**
 * How a value reads for a small company. Colour is never the only signal —
 * every row carries its words — but the tone is what makes "não exige" scan as
 * good news in a list of six rows.
 */
export type FindingTone = 'good' | 'attention' | 'neutral'

export type Finding = {
  /** Stable across renders and unique in its section: the React key. */
  id: string
  label: string
  value: string
  tone: FindingTone
  /** The page of the edital this came from, or `null` when none was cited. */
  page: number | null
  /**
   * `true` when the worker's citation check could not confirm the page — it
   * does not exist, was never sent to the model, or is about something else.
   */
  pageUnverified: boolean
  /** The model's own sentence about the requirement, when it wrote one. */
  note: string | null
}

export type Blocker = {
  id: string
  text: string
  page: number | null
  pageUnverified: boolean
}

export type CitationSummary = {
  citations: number
  verified: number
  rate: number | null
}

export type ScreeningModel = {
  /** `nota_triagem_0_a_10`, clamped to the scale the prompt defines. */
  score: number | null
  verdict: string
  /** `motivo`: one sentence explaining the score. */
  reason: string | null
  /** `objeto`: what is being bought, in one sentence. */
  object: string | null
  /** Habilitação: the rows canvas 04 prints under "Detalhes da análise". */
  qualification: Finding[]
  /** Delivery, payment and product rules — the "Exigências" tab. */
  requirements: Finding[]
  blockers: Blocker[]
  citations: CitationSummary | null
  /** The model thought a deep analysis would pay off (task C2). */
  worthDeepDive: boolean
}

// ───────────────────────────── the citation check ────────────────────────────

/** The one verdict `check_citations` writes that means "this page is real". */
const VERIFIED = 'confere'

type Verdicts = Record<string, string>

function verdicts(citationCheck: unknown): Verdicts {
  const found = obj(obj(citationCheck)?.findings)
  if (!found) return {}
  const out: Verdicts = {}
  for (const [key, value] of Object.entries(found)) {
    const text = str(value)
    if (text) out[key] = text
  }
  return out
}

/**
 * Whether the page cited for `field` failed the worker's check.
 *
 * A field with no verdict was never checked — either nothing was cited or the
 * field is not one of `LITE_CITATION_TOPICS`. That is not a failure, so it is
 * not flagged: only a recorded verdict other than `confere` is.
 */
function unverified(check: Verdicts, field: string | null): boolean {
  if (!field) return false
  const verdict = check[field]
  return verdict !== undefined && verdict !== VERIFIED
}

export function citationSummary(citationCheck: unknown): CitationSummary | null {
  const node = obj(citationCheck)
  if (!node) return null
  const citations = num(node.citations)
  const verified = num(node.verified)
  if (citations === null || verified === null) return null
  const rate = num(node.rate)
  return { citations, verified, rate }
}

// ───────────────────────────────── the rows ──────────────────────────────────

type RowInput = {
  id: string
  label: string
  value: string | null
  tone?: FindingTone
  page?: number | null
  /** The `citation_check.findings` key this row's page is judged under. */
  field?: string | null
  note?: string | null
}

function row(input: RowInput, check: Verdicts): Finding | null {
  if (!input.value) return null
  return {
    id: input.id,
    label: input.label,
    value: input.value,
    tone: input.tone ?? 'neutral',
    page: input.page ?? null,
    pageUnverified: input.page ? unverified(check, input.field ?? null) : false,
    note: input.note ?? null,
  }
}

/** `true` → "Exige" (attention), `false` → "Não exige" (good), `null` → nothing. */
function requirement(flag: boolean | null): { value: string; tone: FindingTone } | null {
  if (flag === true) return { value: values.required, tone: 'attention' }
  if (flag === false) return { value: values.notRequired, tone: 'good' }
  return null
}

const ME_EPP: Record<string, { value: string; tone: FindingTone }> = {
  exclusivo: { value: values.meEppExclusive, tone: 'good' },
  cota_reservada: { value: values.meEppQuota, tone: 'good' },
  misto: { value: values.meEppMixed, tone: 'good' },
  tratamento_favorecido: { value: values.meEppFavored, tone: 'good' },
  sem_beneficio: { value: values.meEppNone, tone: 'neutral' },
  conflito: { value: values.conflict, tone: 'attention' },
}

const SAMPLE: Record<string, { value: string; tone: FindingTone }> = {
  amostra: { value: values.sampleSample, tone: 'attention' },
  prova_de_conceito: { value: values.samplePoc, tone: 'attention' },
  nenhuma: { value: values.notRequired, tone: 'good' },
}

const GUARANTEE: Record<string, { value: string; tone: FindingTone }> = {
  exigida: { value: values.required, tone: 'attention' },
  nao_exigida: { value: values.notRequired, tone: 'good' },
}

const VISIT: Record<string, { value: string; tone: FindingTone }> = {
  obrigatoria: { value: values.visitRequired, tone: 'attention' },
  facultativa: { value: values.visitOptional, tone: 'neutral' },
  nao_ha: { value: values.visitNone, tone: 'good' },
}

const CONSORTIUM: Record<string, { value: string; tone: FindingTone }> = {
  permitido: { value: values.consortiumAllowed, tone: 'neutral' },
  vedado: { value: values.consortiumForbidden, tone: 'neutral' },
}

const RESELLER: Record<string, { value: string; tone: FindingTone }> = {
  sim: { value: values.resellerYes, tone: 'good' },
  nao: { value: values.resellerNo, tone: 'attention' },
  com_condicoes: { value: values.resellerConditions, tone: 'attention' },
}

/** `nao_informado` and anything unexpected both mean "the document is silent". */
function pick(
  table: Record<string, { value: string; tone: FindingTone }>,
  raw: string | null,
): { value: string; tone: FindingTone } | null {
  if (!raw) return null
  const key = raw.toLowerCase().replace(/[\s-]+/g, '_')
  return table[key] ?? null
}

/** `R$ 4.330,77` — the calculated minimum capital, centavos and all. */
const MONEY = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
})

function days(value: unknown): string | null {
  const count = num(value)
  return count === null ? null : format(values.days, { count: Math.round(count) })
}

// ─────────────────────────────────── parse ───────────────────────────────────

const SCORE_BANDS: Array<{ min: number; verdict: string }> = [
  { min: 8, verdict: copy.screening.verdict.good },
  { min: 5, verdict: copy.screening.verdict.medium },
  { min: 0, verdict: copy.screening.verdict.hard },
]

export function verdictFor(score: number | null): string {
  if (score === null) return copy.screening.verdict.unknown
  return SCORE_BANDS.find((band) => score >= band.min)?.verdict ?? copy.screening.verdict.hard
}

/**
 * `result` + `citation_check` + `rules` → what canvas 04 prints.
 *
 * Returns `null` only when `result` is not an object at all — a row that
 * failed so completely that there is nothing to render, which the screen shows
 * as its "failed" state rather than as an empty analysis.
 */
export function parseScreening(
  result: unknown,
  citationCheck: unknown,
  rules: unknown,
): ScreeningModel | null {
  const answer = obj(result)
  if (!answer) return null

  const check = verdicts(citationCheck)
  const ruleset = obj(rules) ?? {}

  const rawScore = num(answer.nota_triagem_0_a_10)
  const score = rawScore === null ? null : Math.max(0, Math.min(10, Math.round(rawScore)))

  const qualification: Array<Finding | null> = []

  const meEpp = obj(answer.beneficio_me_epp)
  const meEppPick = pick(ME_EPP, str(meEpp?.situacao))
  qualification.push(
    row(
      {
        id: 'meEpp',
        label: fields.meEpp,
        value: meEppPick?.value ?? values.unknown,
        tone: meEppPick?.tone ?? 'neutral',
        page: page(meEpp),
        field: 'beneficio_me_epp',
        note: str(meEpp?.observacao),
      },
      check,
    ),
  )

  const certificate = obj(answer.atestado_capacidade_tecnica)
  const certificatePick = requirement(bool(certificate?.exige))
  qualification.push(
    row(
      {
        id: 'technicalCertificate',
        label: fields.technicalCertificate,
        value: certificatePick?.value ?? values.unknown,
        tone: certificatePick?.tone ?? 'neutral',
        page: page(certificate),
        field: 'atestado_capacidade_tecnica',
        note: str(certificate?.resumo),
      },
      check,
    ),
  )

  // The number is `rules.minimum_capital_brl` — computed in Python, never by
  // the model — and the model only supplies the wording underneath it.
  const capital = obj(answer.capital_ou_patrimonio_minimo)
  const capitalAmount = num(ruleset.minimum_capital_brl)
  const capitalPick = requirement(bool(capital?.exige))
  qualification.push(
    row(
      {
        id: 'minimumCapital',
        label: fields.minimumCapital,
        value:
          capitalAmount !== null
            ? MONEY.format(capitalAmount)
            : (capitalPick?.value ?? values.unknown),
        tone: capitalAmount !== null ? 'attention' : (capitalPick?.tone ?? 'neutral'),
        page: page(capital),
        field: 'capital_ou_patrimonio_minimo',
        // The model's own sentence first, then the worker's arithmetic trail.
        // `compute_rules` writes that trail with Python's `:,.2f`, i.e. English
        // separators ("R$ 1,693,346.78"), so it is the fallback and not the
        // first choice on a Brazilian screen. Worth fixing in the worker.
        note: str(capital?.resumo) ?? str(ruleset.minimum_capital_calculation),
      },
      check,
    ),
  )

  const sample = obj(answer.amostra_ou_prova_de_conceito)
  const samplePick = pick(SAMPLE, str(sample?.tipo))
  qualification.push(
    row(
      {
        id: 'sample',
        label: fields.sample,
        value: samplePick?.value ?? values.unknown,
        tone: samplePick?.tone ?? 'neutral',
        page: page(sample),
        field: 'amostra_ou_prova_de_conceito',
        note: str(sample?.resumo),
      },
      check,
    ),
  )

  const guarantee = obj(answer.garantia_contratual)
  const guaranteePick = pick(GUARANTEE, str(guarantee?.situacao))
  const guaranteePercent = num(guarantee?.percentual)
  qualification.push(
    row(
      {
        id: 'guarantee',
        label: fields.guarantee,
        value: guaranteePick?.value ?? values.unknown,
        tone: guaranteePick?.tone ?? 'neutral',
        page: page(guarantee),
        field: 'garantia_contratual',
        note:
          guaranteePercent === null
            ? null
            : format(values.percent, { valor: String(guaranteePercent).replace('.', ',') }),
      },
      check,
    ),
  )

  const visit = pick(VISIT, str(answer.visita_tecnica))
  qualification.push(
    row({ id: 'siteVisit', label: fields.siteVisit, value: visit?.value ?? null, tone: visit?.tone }, check),
  )

  const consortium = pick(CONSORTIUM, str(answer.consorcio))
  qualification.push(
    row(
      { id: 'consortium', label: fields.consortium, value: consortium?.value ?? null, tone: consortium?.tone },
      check,
    ),
  )

  const requirements: Array<Finding | null> = []

  requirements.push(
    row({ id: 'judgment', label: fields.judgment, value: str(answer.criterio_julgamento) }, check),
  )

  const termMonths = num(ruleset.term_months) ?? num(answer.vigencia_meses_normalizada)
  requirements.push(
    row(
      {
        id: 'term',
        label: fields.term,
        value: termMonths === null ? null : format(values.months, { count: Math.round(termMonths) }),
      },
      check,
    ),
  )

  const delivery = obj(answer.entrega)
  requirements.push(
    row(
      {
        // Top-level in the prompt's schema, so it carries no page of its own —
        // borrowing `entrega`'s would cite a page this claim did not come from.
        id: 'deliveryDays',
        label: fields.deliveryDays,
        value: days(answer.prazo_execucao_ou_entrega_dias),
      },
      check,
    ),
  )
  requirements.push(
    row(
      {
        id: 'deliveryShelfLife',
        label: fields.deliveryShelfLife,
        value: str(delivery?.validade_minima_produto),
        tone: 'attention',
        page: page(delivery),
        field: 'entrega',
      },
      check,
    ),
  )
  requirements.push(
    row(
      {
        id: 'deliveryPlace',
        label: fields.deliveryPlace,
        value: str(delivery?.local),
        page: page(delivery),
        field: 'entrega',
      },
      check,
    ),
  )
  const split = bool(delivery?.parcelada)
  requirements.push(
    row(
      {
        id: 'deliverySplit',
        label: fields.deliverySplit,
        value: split === null ? null : split ? values.yes : values.no,
        page: page(delivery),
        field: 'entrega',
      },
      check,
    ),
  )
  requirements.push(
    row(
      {
        id: 'paymentDays',
        label: fields.paymentDays,
        value: days(answer.prazo_pagamento_dias),
        note: str(answer.observacao_pagamento),
      },
      check,
    ),
  )

  const product = obj(answer.exigencias_produto)
  const productPage = page(product)
  const PRODUCT_FLAGS: Array<[string, string, unknown]> = [
    ['anvisa', fields.anvisa, product?.registro_anvisa],
    ['afe', fields.afe, product?.afe_anvisa],
    ['sanitaryLicence', fields.sanitaryLicence, product?.licenca_ou_alvara_sanitario],
    ['inmetro', fields.inmetro, product?.inmetro],
    ['datasheet', fields.datasheet, product?.catalogo_ou_ficha_tecnica],
  ]
  for (const [id, label, raw] of PRODUCT_FLAGS) {
    const flag = requirement(bool(raw))
    requirements.push(
      row(
        {
          id,
          label,
          value: flag?.value ?? null,
          tone: flag?.tone,
          page: productPage,
          field: 'exigencias_produto',
        },
        check,
      ),
    )
  }
  const reseller = pick(RESELLER, str(product?.aceita_distribuidor_revendedor))
  requirements.push(
    row(
      {
        id: 'reseller',
        label: fields.reseller,
        value: reseller?.value ?? null,
        tone: reseller?.tone,
        page: productPage,
        field: 'exigencias_produto',
      },
      check,
    ),
  )

  const blockers: Blocker[] = []
  const rawBlockers = Array.isArray(answer.bloqueadores_pequena_empresa)
    ? answer.bloqueadores_pequena_empresa
    : []
  rawBlockers.forEach((raw, index) => {
    const node = obj(raw)
    const text = str(node?.ponto) ?? str(raw)
    if (!text) return
    const cited = page(node ?? raw)
    blockers.push({
      id: `blocker-${index}`,
      text,
      page: cited,
      pageUnverified: cited ? unverified(check, `bloqueadores_pequena_empresa[${index}]`) : false,
    })
  })

  return {
    score,
    verdict: verdictFor(score),
    reason: str(answer.motivo),
    object: str(answer.objeto),
    qualification: qualification.filter((item): item is Finding => item !== null),
    requirements: requirements.filter((item): item is Finding => item !== null),
    blockers,
    citations: citationSummary(citationCheck),
    worthDeepDive: bool(answer.vale_deep_dive) === true,
  }
}
