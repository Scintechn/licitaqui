import type { Page, Route } from '@playwright/test'
import type {
  CnpjResponse,
  CompanyView,
  Freshness,
  GroupedCompany,
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
import { tenderChecklist } from '@/lib/radar/checklist'
import { CNPJ_SCOPE_COOKIE, cnpjTag } from '@/lib/radar/scope'
import { E2E_BASE_URL, E2E_SERVER_ENV } from './server-env'
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
  /**
   * CNAEs on record for it — what `radar.list.cnaeCount` counts, which is not
   * `company.segments.length` (D19). Defaults to one when there is a main CNAE.
   */
  cnaeCount?: number
  /**
   * Neither source could read its CNAEs (`main_cnae is null`). With
   * `cnpjNotFound`, because both said the CNPJ does not exist.
   */
  manualCnae?: boolean
  cnpjNotFound?: boolean
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
  /**
   * The CNPJ this device searched last, as `visitors.cnpj` holds it.
   *
   * `GET /api/radar/tenders` resolves the company as `?cnpj= ?? visitors.cnpj`,
   * so a Radar opened with **no** `?cnpj=` in its URL is still grouped by this
   * one — and the cookie carrying it is `httpOnly`, which is exactly why the
   * header could not see it and D19 happened. Modelled here because that state
   * is unreachable from the URL alone, and it is the state Sci screenshotted.
   *
   * **It is a real cookie as well as a fiction in the dispatcher (D60).**
   * `installRadarApi` stamps `lq_scope` on the browser's jar with the keyed
   * digest `POST /api/radar/cnpj` would have stamped, because the Radar's
   * snapshot cache now keys by what the server computes from that jar: without
   * the cookie, two different companies would share one key and the browser
   * would restore the first one's list for the second. Change it mid-journey
   * with `setCookieCnpj`, never by assigning to `world.cookieCnpj` — the
   * assignment alone moves the answers and not the key, which is the defect
   * rather than the fix.
   */
  cookieCnpj?: string
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
  /** `POST /api/tenders/:id/favorito` — D23's star on a card. */
  favourite: string[]
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
  /**
   * The editais this caller has marked (D23). The world owns it, so a journey
   * asserts the screen rather than its own bookkeeping: the list envelope
   * reports it, the `POST` toggles it, and a reload reads it back.
   *
   * `null` is "no account" — the `POST` then answers 401, which is what
   * `/api/tenders/:id/favorito` really does for a visitor.
   */
  favourites: Set<string> | null
  /** Holds the next response of a route open until the test opens the gate. */
  hold(route: keyof Omit<Calls, 'unexpected'>): Gate
  /**
   * The device searches another company — `visitors.cnpj` and the cookie that
   * states its generation, moved together (D60).
   *
   * `undefined` is a device that has never searched one. Both halves are needed:
   * the dispatcher answers from `world.cookieCnpj`, and the server reads the
   * cookie to build the scope the snapshot is keyed by.
   */
  setCookieCnpj(cnpj: string | undefined): Promise<void>
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

/** The company as `GET /api/radar/tenders` reports it: no CNPJ (§12, D60). */
function groupedCompany(company: CompanyView): GroupedCompany {
  const rest: GroupedCompany & { cnpj?: string } = { ...company }
  delete rest.cnpj
  return rest
}

/** The single-segment `%2F` spelling the API routes use, decoded back. */
function tenderIdFrom(pathname: string, suffix = ''): string {
  const raw = pathname.replace(/^\/api\/tenders\//, '').replace(new RegExp(`${suffix}$`), '')
  return decodeURIComponent(raw)
}

/**
 * The cookie `POST /api/radar/cnpj` would have set, put in the jar by hand.
 *
 * The journeys never let a request reach a route handler, so nothing here can
 * have stamped it — but `/radar` is server-rendered on every visit and reads the
 * jar to compute the scope the snapshot cache keys by (`lib/radar/scope.ts`). So
 * the fixture plays the part of the route that writes it.
 *
 * The real `cnpjTag`, with the server's own placeholder secret, rather than an
 * opaque string of this file's invention: if that construction ever changes, the
 * fixture follows it instead of drifting. Nothing depends on the two digests
 * being *equal* — the server only ever hashes whatever is in the cookie — which
 * is why these journeys also pass against a deployment whose secret this process
 * does not know. `httpOnly`, like the route's, so no page script can read it
 * even here.
 */
async function stampDeviceCnpj(page: Page, cnpj: string | undefined): Promise<void> {
  const context = page.context()
  await context.clearCookies({ name: CNPJ_SCOPE_COOKIE })
  if (!cnpj) return
  await context.addCookies([
    {
      name: CNPJ_SCOPE_COOKIE,
      value: cnpjTag(cnpj, E2E_SERVER_ENV),
      url: E2E_BASE_URL,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ])
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
      favourite: [],
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
    favourites: new Set<string>(),
    hold: (name) => {
      const gate = new Gate()
      gates[name] = gate
      return gate
    },
    setCookieCnpj: async (cnpj) => {
      api.world.cookieCnpj = cnpj
      await stampDeviceCnpj(page, cnpj)
    },
    world,
  }

  // Before the first `goto`, because `/radar` reads the jar on the server to
  // decide which snapshot this visit may restore.
  await stampDeviceCnpj(page, world.cookieCnpj)

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
      /*
       * **The cookie is stamped here, after the answer, exactly as the route
       * does it — and that ordering is the whole point (D70/B1).**
       *
       * `POST /api/radar/cnpj` writes `visitors.cnpj` and sends `lq_scope` in the
       * same response, which arrives **after** `app/radar/page.tsx` rendered and
       * handed the screen its scopes. An earlier version of this fixture stamped
       * the cookie once at install time, before the first navigation, so every
       * journey ran against a jar that was already correct at render time: it
       * modelled the end state and never the transition, and a regression that
       * broke the *Voltar* journey for every first search passed the whole suite.
       * Stamping it here is what lets these journeys fail.
       */
      await stampDeviceCnpj(page, cnpj)
      api.world.cookieCnpj = cnpj
      return json(route, {
        state: 'ready',
        company: found.company,
        freshness,
        visitor: visitorView(),
        manualCnae: found.manualCnae ?? false,
        cnpjNotFound: (found.manualCnae ?? false) && (found.cnpjNotFound ?? false),
      } satisfies CnpjResponse)
    }

    // ── GET /api/radar/tenders ────────────────────────────────────────────
    if (path === '/api/radar/tenders') {
      await through('tenders', request.url())
      // The real route's rule, verbatim: the query string when it is there,
      // otherwise whatever this device last searched (D19).
      const cnpj = url.searchParams.get('cnpj') ?? api.world.cookieCnpj ?? null
      const group = (url.searchParams.get('group') ?? 'compatible') as TenderGroup
      const q = (url.searchParams.get('q') ?? '').trim().toLowerCase()

      // The route's other rule, also verbatim: with no CNPJ resolved from
      // either place and no keyword there is nothing to filter the whole of
      // PNCP by, and it answers `400 cnpjRequired` rather than a random page.
      // Modelled because D55 made that answer the **only** way the screen
      // reaches `needCnpj` — without it this world would reply "ready, 0
      // tenders" and a bare `/radar` with no cookie would draw an empty group.
      if (!cnpj && !q) {
        return json(
          route,
          {
            state: 'error',
            error: 'validation',
            fields: { cnpj: 'cnpjRequired' },
          } satisfies TenderListResponse,
          400,
        )
      }
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
        // D23: the marked ids come back **with the rows**, scoped to this page,
        // which is exactly what `listTenders` projects.
        favourites: slice
          .filter((row) => api.favourites?.has(row.id))
          .map((row) => row.id),
        counts,
        nextCursor: next,
        freshness,
        groupedBy: cnpj
          ? {
              // Without the CNPJ, exactly as the route sends it. `GroupedCompany`
              // is `CompanyView` minus that one field (§12), and a `CompanyView`
              // is *structurally assignable* to it — so `satisfies` cannot catch
              // the fixture sending one field more than the real route does, and
              // D60's §12 journey reads this out of `sessionStorage`.
              company: found ? groupedCompany(found.company) : null,
              cnaeCount: found ? (found.cnaeCount ?? (found.company.mainCnae ? 1 : 0)) : 0,
            }
          : null,
      } satisfies TenderListResponse)
    }

    // ── POST /api/tenders/:id/favorito (D23) ──────────────────────────────
    if (path.endsWith('/favorito')) {
      await through('favourite', request.url())
      const id = tenderIdFrom(path, '/favorito')
      if (api.favourites === null) {
        // The one Radar route that refuses a visitor outright: a favourite is a
        // row keyed on `users.id` and there is nowhere to put one otherwise.
        return json(route, { state: 'error', error: 'unauthenticated' }, 401)
      }
      const marked = !api.favourites.has(id)
      if (marked) api.favourites.add(id)
      else api.favourites.delete(id)
      return json(route, { state: 'ready', favourite: marked })
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
          // D26. Computed from the same function the route uses rather than
          // hand-written: a fixture that invents a checklist would let the
          // real one drift from what the journeys assert about it.
          checklist: tenderChecklist(row, null),
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
