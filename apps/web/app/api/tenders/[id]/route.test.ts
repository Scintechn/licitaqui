import { describe, expect, it, vi } from 'vitest'
import type { TenderOk } from '@/lib/radar/contract'

/**
 * What this route is allowed to put on the wire.
 *
 * ## Why it exists at all
 *
 * D26 gave `screeningAvailability` the **reading itself** so the checklist
 * could be built without a second round trip, and from that moment one line in
 * the route was the only thing keeping an analysis out of the browser:
 *
 * ```ts
 * screening: { ready, spent, metered }   // rebuilt field by field
 * ```
 *
 * Writing `screening,` instead ships the whole `ai_analyses.result` — the
 * findings, the blockers, the pages — to anyone who opens the tender. It is
 * **legal TypeScript**, because excess-property checking does not apply to a
 * variable reference, and it passed `tsc` and all 1 333 non-database tests
 * when a review tried it. There was no test file for this route; its siblings
 * `band/` and `favorito/` both have one.
 *
 * So the most privacy-sensitive line in that change was guarded by nothing but
 * the author's hand, which is CLAUDE.md §4b's shape exactly. These assertions
 * are the guard.
 */

const readViewer = vi.hoisted(() => vi.fn(async () => null))
const planOf = vi.hoisted(() => vi.fn(() => 'visitor'))
const cnpjOf = vi.hoisted(() => vi.fn(() => null))
const hasAccount = vi.hoisted(() => vi.fn(() => false))
const spenderOf = vi.hoisted(() => vi.fn(() => null))
vi.mock('@/lib/auth/viewer', () => ({ readViewer, planOf, cnpjOf, hasAccount, spenderOf }))

const readLimit = vi.hoisted(() => vi.fn(async () => ({ feature: 'screening', quantity: 2 })))
vi.mock('@/lib/radar/quota', () => ({ readLimit, FEATURES: { screening: 'screening' } }))

const screeningAvailability = vi.hoisted(() => vi.fn())
vi.mock('@/lib/radar/screening', () => ({ screeningAvailability }))

const tenderOrRefresh = vi.hoisted(() => vi.fn())
vi.mock('@/lib/radar/tender', () => ({ tenderOrRefresh }))
vi.mock('@/lib/radar/company', () => ({ readCompany: vi.fn(async () => null) }))
vi.mock('@/lib/db', () => ({ db: () => ({}) }))

const { GET } = await import('./route')

const ID = '96291141000180-1-006394/2026'

/** The shape of a real `ai_analyses.result`, cut to what matters here. */
const READING = {
  nota_triagem_0_a_10: 7,
  atestado_capacidade_tecnica: { exige: true, resumo: 'dois atestados', pagina: 14 },
  bloqueadores_pequena_empresa: [{ ponto: 'capital mínimo de R$ 18.217,55', pagina: 14 }],
  motivo: 'Processo simples, mas exige comprovação contábil detalhada.',
}

function givenTender() {
  tenderOrRefresh.mockResolvedValue({
    data: {
      id: ID,
      object: 'Aquisição de material de escritório',
      matchedSegments: [],
      meEppSummary: 'exclusive',
      proposalsCloseAt: '2026-10-05T11:00:00.000Z',
      items: [],
      files: null,
    },
    freshness: { state: 'fresh', updatedAt: null, ageSeconds: 0 },
  })
}

async function body(): Promise<TenderOk> {
  const response = await GET(new Request(`https://x/api/tenders/${ID}`), {
    params: Promise.resolve({ id: ID }),
  })
  return (await response.json()) as TenderOk
}

describe('GET /api/tenders/:id', () => {
  it('never puts the reading on the wire, however it was read', async () => {
    givenTender()
    screeningAvailability.mockResolvedValue({
      ready: true,
      spent: true,
      metered: true,
      analysis: { result: READING, citationCheck: null, rules: null },
    })

    const payload = await body()
    // The three booleans the CTA needs, and nothing else under that key.
    expect(payload.screening).toEqual({ ready: true, spent: true, metered: true })
    // And nothing anywhere in the response carries the analysis. A whole-body
    // check rather than a per-field one, deliberately: the next field somebody
    // adds is the one a per-field assertion would not be looking at.
    const wire = JSON.stringify(payload)
    expect(wire).not.toContain('bloqueadores')
    expect(wire).not.toContain('nota_triagem')
    expect(wire).not.toContain('capital mínimo de R$ 18.217,55')
  })

  /**
   * §3.2 shares a reading and §10 allocates it per user, so a tender somebody
   * else paid to read is unread for this caller — and the page numbers in it
   * were bought with their triagem.
   */
  it('does not hand a reading this caller has not paid for', async () => {
    givenTender()
    screeningAvailability.mockResolvedValue({
      ready: true,
      spent: false,
      metered: true,
      analysis: { result: READING, citationCheck: null, rules: null },
    })

    const payload = await body()
    expect(payload.screening.ready, 'a reading exists').toBe(true)
    for (const row of payload.checklist.rows.filter((r) => r.source === 'ai')) {
      expect(row.state, row.key).toBe('unknown')
      expect(row.page, row.key).toBeNull()
    }
  })

  it('answers the rows PNCP can, with no reading at all', async () => {
    givenTender()
    screeningAvailability.mockResolvedValue({
      ready: false,
      spent: false,
      metered: true,
      analysis: null,
    })

    const payload = await body()
    expect(payload.checklist.total).toBe(10)
    // `meEpp` and `deadline` from the structured fields; `cnae` is unknown
    // because this caller searched no company.
    expect(payload.checklist.checked).toBe(2)
  })
})
