import type { Page, Route } from '@playwright/test'
import type {
  CnpjResponse,
  CompanyView,
  Freshness,
  JobResponse,
  QuotaView,
  ScreeningAvailability,
  ScreeningReadResponse,
  ScreeningResponse,
  TenderDetail,
  TenderGroup,
  TenderListResponse,
  TenderResponse,
  VisitorView,
} from '@/lib/radar/contract'
import { TENDER_GROUPS } from '@/lib/radar/contract'
import { visitor as defaultVisitor, visitorQuota } from './world'

/**
 * PNCP, the worker and Postgres, replaced by one dispatcher in front of the
 * browser.
 *
 * ## Why the seam is here and not lower
 *
 * `lib/radar/contract.ts` is the wire contract of the five Radar routes, and
 * everything these journeys are about lives **above** it: which screen draws
 * which state, whether a link carries the search, whether the list a person
 * comes back to is the list they left, whether the poll gives up. None of that
 * depends on where the rows came from — and all of it broke, in production, in
 * the last two days.
 *
 * Below the contract there is a second set of failures (a query returning the
 * wrong rows, a route that 500s) and it is **not covered here**. It is covered
 * by the `*.db.test.ts` suites, which talk to a real Postgres. Saying so is
 * part of the deal: a suite that implies more coverage than it has is worse
 * than a small one.
 *
 * ## Everything is a fact the test set
 *
 * No timers, no "wait for the worker", no sleeping. A screening is `pending`
 * until the test says `api.screening.state = 'ready'`; a slow CNPJ lookup is
 * an open `Gate` the test closes when it has finished asserting the waiting
 * state. That is what makes a journey that *contains* a 60-second product
 * deadline runnable in a suite, and what keeps every assertion about a
 * condition rather than about a clock.
 */

export type CompanyWorld = {
  company: CompanyView
  tenders: TenderDetail[]
}

export type WorldOptions = {
  /** Every company a journey may search, with the editais it reaches. */
  companies: CompanyWorld[]
  /** The visitor banner. `null` for a signed-in caller. */
  visitor?: VisitorView | null
  /** How many cards a page of the list holds. The Radar asks for no limit. */
  pageSize?: number
  /** Freshness reported for every list and every tender. */
  freshness?: Freshness
}

/**
 * A response the test holds open.
 *
 * The honest way to assert a waiting state: the screen is waiting because the
 * answer has not arrived, not because a `waitForTimeout` said so. `open()`
 * resolves after the test has seen what it came to see.
 */
export class Gate {
  private release: () => void = () => {}
  private readonly promise: Promise<void>
  /** Resolves as soon as a request has actually reached the gate. */
  readonly reached: Promise<void>
  private arrive: () => void = () => {}

  constructor() {
    this.promise = new Promise((resolve) => {
      this.release = resolve
    })
    this.reached = new Promise((resolve) => {
      this.arrive = resolve
    })
  }

  async wait(): Promise<void> {
    this.arrive()
    await this.promise
  }

  open(): void {
    this.release()
  }
}

export type Calls = {
  cnpj: string[]
  tenders: string[]
  tender: string[]
  screeningPost: string[]
  screeningGet: string[]
  jobs: string[]
  /** Anything under `/api/` this dispatcher did not expect. Must stay empty. */
  unexpected: string[]
}

export type ScreeningState = {
  /**
   * What `GET`/`POST /api/tenders/:id/screening` answer next. Mutate it from
   * the test the way the worker would: `pending` → `ready`.
   */
  state: 'pending' | 'ready' | 'noText' | 'quotaExceeded'
  /**
   * How many triagens this caller has spent. It is a **counter the test owns**
   * precisely so a journey can prove the number did not move when a screening
   * was re-opened (#70: `quota.spend` de-duplicates on the tender id).
   */
  used: number
  /** The job the `POST` hands back when it answers `202`. */
  job: { id: number | null; kind: string }
  result: unknown
  citationCheck: unknown
  rules: unknown
}

export type RadarApi = {
  calls: Calls
  screening: ScreeningState
  /** Per-tender `{ ready, spent }`, which is what names the CTA (#70). */
  availability: Map<string, ScreeningAvailability>
  /** Holds the next response of a route open until the test opens the gate. */
  hold(route: keyof Omit<Calls, 'unexpected'>): Gate
  /** Swap the whole world mid-journey (Carla changing client, say). */
  world: WorldOptions
}

const FRESH: Freshness = { state: 'fresh', updatedAt: new Date().toISOString(), ageSeconds: 45 }

async function json(route: Route, body: unknown, status = 200): Promise<void> {
  try {
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
  } catch {
    // The document that asked has unloaded — a journey that moves to another
    // screen while a request is in flight, which is most of them. Nobody is
    // waiting for this answer any more. Letting it throw would leave an
    // unhandled rejection inside Playwright's route dispatcher, which is not
    // an error anybody can act on and is not this world's business.
  }
}

/** The single-segment `%2F` spelling the API routes use, decoded back. */
function tenderIdFrom(pathname: string, suffix = ''): string {
  const raw = pathname.replace(/^\/api\/tenders\//, '').replace(new RegExp(`${suffix}$`), '')
  return decodeURIComponent(raw)
}

export async function installRadarApi(page: Page, world: WorldOptions): Promise<RadarApi> {
  const pageSize = world.pageSize ?? 20
  const freshness = world.freshness ?? FRESH
  const gates: Partial<Record<keyof Omit<Calls, 'unexpected'>, Gate>> = {}
  /**
   * The editais this caller has already paid a triagem for.
   *
   * `quota.spend` de-duplicates on the tender id, so asking twice for the same
   * edital charges once — which is the whole of #70. Modelling it here rather
   * than letting a test set `used` by hand is what makes the journey assert
   * the screen instead of asserting the fixture.
   */
  const spentOn = new Set<string>()

  const api: RadarApi = {
    calls: {
      cnpj: [],
      tenders: [],
      tender: [],
      screeningPost: [],
      screeningGet: [],
      jobs: [],
      unexpected: [],
    },
    screening: {
      state: 'ready',
      used: 0,
      job: { id: 7001, kind: 'ai_screening' },
      result: SAMPLE_RESULT,
      citationCheck: SAMPLE_CITATION_CHECK,
      rules: null,
    },
    availability: new Map(),
    hold: (name) => {
      const gate = new Gate()
      gates[name] = gate
      return gate
    },
    world,
  }

  async function through(name: keyof Omit<Calls, 'unexpected'>, url: string): Promise<void> {
    api.calls[name].push(url)
    const gate = gates[name]
    if (gate) {
      delete gates[name]
      await gate.wait()
    }
  }

  function worldFor(cnpj: string | null): CompanyWorld | null {
    if (!cnpj) return null
    return api.world.companies.find((entry) => entry.company.cnpj === cnpj) ?? null
  }

  function quota(): QuotaView {
    return visitorQuota(api.screening.used)
  }

  function visitorView(): VisitorView | null {
    if (api.world.visitor === null) return null
    const base = api.world.visitor ?? defaultVisitor()
    return { ...base, screeningsUsed: api.screening.used, screeningsLeft: Math.max(0, 2 - api.screening.used) }
  }

  await page.route('**/api/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname

    // ── POST /api/radar/cnpj ──────────────────────────────────────────────
    if (path === '/api/radar/cnpj') {
      await through('cnpj', request.url())
      const body = request.postDataJSON() as { cnpj?: string } | null
      const cnpj = (body?.cnpj ?? '').replace(/\D+/g, '')
      const found = worldFor(cnpj)
      if (!found) {
        return json(route, { state: 'error', error: 'not_found' } satisfies CnpjResponse, 404)
      }
      // No `202` branch here on purpose: the journey that needs the "analyzing"
      // card asserts it by **holding this answer open** (`api.hold('cnpj')`),
      // which costs no polling interval and no wall-clock wait. The `202` path
      // itself is exercised where it actually matters — the screening, where
      // the job really does outlive the deadline (#68).
      return json(route, {
        state: 'ready',
        company: found.company,
        freshness,
        visitor: visitorView(),
        manualCnae: false,
      } satisfies CnpjResponse)
    }

    // ── GET /api/radar/tenders ────────────────────────────────────────────
    if (path === '/api/radar/tenders') {
      await through('tenders', request.url())
      const cnpj = url.searchParams.get('cnpj')
      const group = (url.searchParams.get('group') ?? 'compatible') as TenderGroup
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()
      const found = worldFor(cnpj)
      const all = found ? found.tenders : keywordOnly(api.world, q)

      const matching = all.filter((row) => (q ? row.object.toLowerCase().includes(q) : true))
      const counts = Object.fromEntries(
        TENDER_GROUPS.map((name) => [name, matching.filter((row) => row.group === name).length]),
      ) as Record<TenderGroup, number>

      const rows = matching.filter((row) => row.group === group)
      const start = Number(url.searchParams.get('cursor') ?? 0)
      const slice = rows.slice(start, start + pageSize)
      const next = start + pageSize < rows.length ? String(start + pageSize) : null

      return json(route, {
        state: 'ready',
        group,
        tenders: slice,
        counts,
        nextCursor: next,
        freshness,
      } satisfies TenderListResponse)
    }

    // ── /api/tenders/:id and /api/tenders/:id/screening ───────────────────
    if (path.startsWith('/api/tenders/')) {
      const screening = path.endsWith('/screening')
      const id = tenderIdFrom(path, screening ? '/screening' : '')
      const row = api.world.companies.flatMap((entry) => entry.tenders).find((t) => t.id === id)

      if (!screening) {
        await through('tender', request.url())
        if (!row) {
          return json(route, { state: 'error', error: 'not_found' } satisfies TenderResponse, 404)
        }
        return json(route, {
          state: 'ready',
          tender: row,
          freshness,
          screening: api.availability.get(id) ?? { ready: false, spent: false, metered: true },
        } satisfies TenderResponse)
      }

      await through(request.method() === 'POST' ? 'screeningPost' : 'screeningGet', request.url())
      if (!row) {
        return json(
          route,
          { state: 'error', error: 'not_found' } satisfies ScreeningResponse,
          404,
        )
      }

      if (api.screening.state === 'quotaExceeded') {
        return json(
          route,
          { state: 'error', error: 'quota_exceeded', quota: quota() } satisfies ScreeningResponse,
          403,
        )
      }

      // The `POST` is the ask, and the ask is what charges — once per edital.
      if (request.method() === 'POST' && !spentOn.has(id)) {
        spentOn.add(id)
        api.screening.used += 1
        api.availability.set(id, { ready: api.screening.state === 'ready', spent: true, metered: true })
      }

      if (api.screening.state === 'pending') {
        // The `POST` answers "queued, here is a job"; the `GET` answers
        // "nothing written yet" — two different words for the same minute, and
        // the screens read them differently (`screening-screen.tsx`).
        if (request.method() === 'POST') {
          return json(
            route,
            {
              state: 'analyzing',
              job: api.screening.job,
              quota: quota(),
              visitor: visitorView(),
            } satisfies ScreeningResponse,
            202,
          )
        }
        return json(route, {
          state: 'pending',
          tenderId: id,
          quota: quota(),
          visitor: visitorView(),
        } satisfies ScreeningReadResponse)
      }

      return json(route, {
        state: 'ready',
        tenderId: id,
        status: api.screening.state === 'noText' ? 'no_text' : 'ok',
        result: api.screening.result,
        citationCheck: api.screening.citationCheck,
        rules: api.screening.rules,
        createdAt: new Date().toISOString(),
        quota: quota(),
        visitor: visitorView(),
      } satisfies ScreeningResponse)
    }

    // ── GET /api/jobs/:id ─────────────────────────────────────────────────
    if (path.startsWith('/api/jobs/')) {
      await through('jobs', request.url())
      const id = Number(path.replace('/api/jobs/', ''))
      const running = api.screening.state === 'pending'
      return json(route, {
        state: 'ready',
        job: {
          id,
          kind: 'ai_screening',
          status: running ? 'running' : 'done',
          attempts: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      } satisfies JobResponse)
    }

    // Anything else under /api/ is a call this world does not know about.
    // Recorded rather than passed through, so a journey can assert that no
    // request ever escaped to a real route handler.
    api.calls.unexpected.push(request.url())
    return json(route, { state: 'error', error: 'not_found' }, 501)
  })

  return api
}

/** A keyword search with no CNPJ still returns tenders — from every company. */
function keywordOnly(world: WorldOptions, q: string): TenderDetail[] {
  if (!q) return []
  return world.companies.flatMap((entry) => entry.tenders)
}

/**
 * One lite screening answer, in the shape `worker/licitaqui/prompts.py` asks
 * the model for and `lib/radar/screening-result.ts` reads back. Kept minimal
 * on purpose: what the journeys assert about it is that it reached the screen
 * and that every claim printed a page, not the wording of the findings.
 */
const SAMPLE_RESULT = {
  orgao: 'PREFEITURA MUNICIPAL DE CAMPINAS',
  objeto: 'Aquisição de material de expediente e papelaria para as unidades da Secretaria de Educação.',
  motivo: 'Itens exclusivos para ME/EPP, sem atestado técnico e sem capital mínimo.',
  nota_triagem_0_a_10: 9,
  beneficio_me_epp: { situacao: 'exclusivo', pagina: 12, observacao: null },
  atestado_capacidade_tecnica: { exige: false, pagina: 43, resumo: null },
  capital_ou_patrimonio_minimo: { exige: false, pagina: 43, resumo: null },
  amostra_ou_prova_de_conceito: { tipo: 'nenhuma', pagina: 44, resumo: null },
  garantia_contratual: { situacao: 'nao_exigida', pagina: 45, percentual: null },
  visita_tecnica: 'nao_ha',
  consorcio: 'permitido',
  entrega: { local: 'Almoxarifado central · Campinas/SP', pagina: 50, parcelada: true },
  prazo_execucao_ou_entrega_dias: 15,
  prazo_pagamento_dias: 30,
  criterio_julgamento: 'menor preço por item',
  bloqueadores_pequena_empresa: [],
  vale_deep_dive: false,
}

const SAMPLE_CITATION_CHECK = {
  mode: 'lite',
  rate: 1.0,
  citations: 6,
  verified: 6,
  findings: {
    entrega: 'confere',
    beneficio_me_epp: 'confere',
    garantia_contratual: 'confere',
    atestado_capacidade_tecnica: 'confere',
    capital_ou_patrimonio_minimo: 'confere',
    amostra_ou_prova_de_conceito: 'confere',
  },
}
