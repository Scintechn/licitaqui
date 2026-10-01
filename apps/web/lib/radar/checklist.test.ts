import { describe, expect, it } from 'vitest'
import { tenderChecklist } from './checklist'
import { CHECKLIST_KEYS, type TenderDetail } from './contract'
import type { Blocker, Finding, ScreeningModel } from './screening-result'

/**
 * D26 — the checklist, before and after a triagem.
 *
 * These assert the three rules the card names, because each one is a way the
 * block could be wrong while looking right: a denominator that moves, a row
 * that cannot say *"nobody read this"*, and one fraction drawn across two
 * different kinds of evidence.
 */

const TENDER: TenderDetail = {
  id: '96291141000180-1-006394/2026',
  object: 'Aquisição de material de escritório',
  shortTitle: null,
  agencyName: 'Secretaria da Administração Penitenciária',
  city: 'Cerqueira César',
  state: 'SP',
  modalityName: 'Dispensa',
  proposalsCloseAt: '2026-10-05T11:00:00.000Z',
  estimatedValue: '48196.00',
  confidentialBudget: false,
  priceRegistration: false,
  meEppSummary: 'exclusive',
  favoredTreatment: true,
  itemCount: 51,
  segments: ['Gráfico / Escritório'],
  matchedSegments: [
    { segment: 'Gráfico / Escritório', fit: 'compatible', fromMainCnae: true, fromSecondaryCnae: false },
  ],
  group: 'compatible',
  status: 'Divulgada no PNCP',
  pncpUpdatedAt: '2026-09-30T10:00:00.000Z',
  items: [],
  files: null,
} as unknown as TenderDetail

function finding(id: string, over: Partial<Finding> = {}): Finding {
  return {
    id,
    label: id,
    value: 'sim',
    tone: 'neutral',
    page: 14,
    pageUnverified: false,
    note: null,
    known: true,
    ...over,
  }
}

/** A reader who has paid for the reading on screen — most cases here. */
const PAID = { spent: true, hasCompany: true } as const

function blocker(text: string): Blocker {
  return { id: `blocker-${text}`, text, page: 14, pageUnverified: false }
}

/** A reading that answered every AI row. */
function model(over: Partial<ScreeningModel> = {}): ScreeningModel {
  return {
    score: 7,
    verdict: 'Dá para disputar, com atenção',
    reason: null,
    object: null,
    qualification: [
      finding('technicalCertificate'),
      finding('minimumCapital'),
      finding('guarantee'),
      finding('sample'),
      finding('siteVisit'),
      finding('consortium'),
    ],
    requirements: [finding('deliveryPlace')],
    blockers: [],
    citations: null,
    worthDeepDive: false,
    ...over,
  }
}

describe('the compatibility checklist', () => {
  it('always has every key, in one order, whatever happened', () => {
    for (const screening of [null, model()]) {
      const list = tenderChecklist(TENDER, screening, PAID)
      expect(list.rows.map((r) => r.key)).toEqual([...CHECKLIST_KEYS])
      expect(list.total).toBe(CHECKLIST_KEYS.length)
    }
  })

  /**
   * **The denominator does not move.** Sci ruled this on 2026-10-01 against
   * canvas 11's "3 de 4" → "5 de 7": a reader deciding whether to spend a
   * triagem has to be able to see what they would be buying, and a list that
   * grows hides exactly that. The fraction fills; it does not lengthen.
   */
  it('is the same length before and after, and only the numerator moves', () => {
    const before = tenderChecklist(TENDER, null, PAID)
    const after = tenderChecklist(TENDER, model(), PAID)

    expect(before.total).toBe(after.total)
    expect(before.checked).toBe(3)
    expect(after.checked).toBe(CHECKLIST_KEYS.length)
    // And the seven that moved are exactly the ones a triagem reads.
    const moved = after.rows
      .filter((row, i) => row.state !== before.rows[i].state)
      .map((row) => row.key)
    expect(moved).toEqual([
      'technicalCertificate',
      'minimumCapital',
      'guarantee',
      'sample',
      'siteVisit',
      'consortium',
      'deliveryPlace',
    ])
  })

  it('says “nobody read this” rather than nothing, before a triagem', () => {
    const list = tenderChecklist(TENDER, null, PAID)
    const unread = list.rows.filter((r) => r.source === 'ai')
    expect(unread).toHaveLength(7)
    for (const row of unread) {
      expect(row.state, row.key).toBe('unknown')
      // An unread row cites no page, because nothing was read.
      expect(row.page, row.key).toBeNull()
    }
  })

  it('keeps a row unknown when the reading could not answer it', () => {
    // `known: false` is the row the model was asked and did not answer — it
    // renders as "não informado" on the triagem screen, and it must not count
    // here. Reading it as answered is how a two-colour meter turns "we did not
    // read this" into "this is fine".
    const list = tenderChecklist(
      TENDER,
      model({ qualification: [finding('technicalCertificate', { known: false })] }), PAID
    )
    const row = list.rows.find((r) => r.key === 'technicalCertificate')
    expect(row?.state).toBe('unknown')
    // Three from PNCP plus `deliveryPlace`, which this reading did answer —
    // the unanswered row is the only one that did not count.
    expect(list.checked).toBe(4)
  })

  it('carries the page, and whether the worker could confirm it', () => {
    const list = tenderChecklist(
      TENDER,
      model({ qualification: [finding('minimumCapital', { page: 14, pageUnverified: true })] }), PAID
    )
    const row = list.rows.find((r) => r.key === 'minimumCapital')
    expect(row).toMatchObject({ page: 14, pageUnverified: true, source: 'ai' })
  })

  describe('provenance', () => {
    it('separates what PNCP answered from what the edital had to be read for', () => {
      const list = tenderChecklist(TENDER, model(), PAID)
      const pncp = list.rows.filter((r) => r.source === 'pncp').map((r) => r.key)
      expect(pncp).toEqual(['cnae', 'meEpp', 'deadline'])
      for (const row of list.rows.filter((r) => r.source === 'pncp')) {
        expect(row.page, 'a structured field has no page to cite').toBeNull()
      }
    })

    /**
     * `meEpp` is answered by both sources, and the structured one wins — even
     * after a triagem. Taking the AI's would make the reading appear to buy a
     * row the reader already had, which is the opposite of what this block is
     * for.
     */
    it('does not let a triagem re-sell a row PNCP already answered', () => {
      const before = tenderChecklist(TENDER, null, PAID)
      const after = tenderChecklist(TENDER, model({ qualification: [finding('meEpp')] }), PAID)
      const key = (list: ReturnType<typeof tenderChecklist>) =>
        list.rows.find((r) => r.key === 'meEpp')
      expect(key(before)).toEqual(key(after))
      expect(key(after)?.source).toBe('pncp')
    })

    it('is unknown where PNCP itself says nothing and nobody was searched', () => {
      const bare = { ...TENDER, meEppSummary: null, proposalsCloseAt: null, matchedSegments: [] }
      // No company: nothing was compared, so `cnae` is genuinely unanswered.
      const list = tenderChecklist(bare as TenderDetail, null, { spent: true })
      expect(list.checked).toBe(0)
      for (const row of list.rows.filter((r) => r.source === 'pncp')) {
        expect(row.state, row.key).toBe('unknown')
      }
    })
  })

  /**
   * **A reading somebody else paid for is not this reader's.**
   *
   * §3.2 shares the analysis and §10 allocates it per user, so `ready` and
   * `spent` come apart in both directions — and the page numbers in a reading
   * were bought with a triagem. The first version gated on neither: any viewer
   * of a tender anyone had read received the filled checklist, pages and all.
   */
  it('shows nothing bought when this viewer has not bought it', () => {
    const unpaid = tenderChecklist(TENDER, model(), { spent: false, hasCompany: true })
    expect(unpaid.checked).toBe(3)
    for (const row of unpaid.rows.filter((r) => r.source === 'ai')) {
      expect(row.state, row.key).toBe('unknown')
      expect(row.page, 'a page is part of what a triagem buys').toBeNull()
    }
  })

  it('defaults to the cautious answer when the caller says nothing', () => {
    // A caller that forgets the viewer gets no AI row at all, never a
    // confident one built from somebody else's purchase. The three PNCP rows
    // still answer, because this tender does carry matched segments — the
    // `hasCompany` flag only decides the *empty* case.
    const list = tenderChecklist(TENDER, model())
    expect(list.checked).toBe(3)
    expect(list.rows.filter((r) => r.source === 'ai').every((r) => r.state === 'unknown')).toBe(true)
  })

  /**
   * **An unmatched CNAE is an answer.** `matchedSegments` is empty both when
   * no company was searched and when one was and does not cover this tender —
   * the Radar's whole `keyword` group is the second case. Reading the empty
   * list as "unknown" in both told every keyword-group reader that we had not
   * checked a CNAE we had checked and rejected.
   */
  it('says the CNAE was checked even when it did not match', () => {
    const keywordOnly = { ...TENDER, matchedSegments: [], group: 'keyword' as const }
    const searched = tenderChecklist(keywordOnly as TenderDetail, null, { hasCompany: true })
    expect(searched.rows.find((r) => r.key === 'cnae')?.state).toBe('ok')

    const nobody = tenderChecklist(keywordOnly as TenderDetail, null, { hasCompany: false })
    expect(nobody.rows.find((r) => r.key === 'cnae')?.state).toBe('unknown')
  })

  /**
   * PNCP is silent on ME/EPP for **15 189 of 47 991 tenders — 31.6%**,
   * measured 2026-10-01. Where it says nothing the triagem does answer, with a
   * page, and the first version reported that row as unread for ever: the
   * block that exists to say what a triagem bought said it bought nothing.
   */
  it('falls through to the reading where PNCP has no answer', () => {
    const silent = { ...TENDER, meEppSummary: null }
    const list = tenderChecklist(
      silent as TenderDetail,
      model({ qualification: [finding('meEpp', { page: 35 })] }),
      PAID,
    )
    const row = list.rows.find((r) => r.key === 'meEpp')
    expect(row).toMatchObject({ state: 'ok', source: 'ai', page: 35 })
  })

  /**
   * **`blocker` is declared and nothing emits it**, which is a state worth
   * pinning rather than leaving to be noticed.
   *
   * Sci ruled that a row is barred only when the reading says so, and
   * `bloqueadores_pequena_empresa` is free text joinable to no row. Teaching
   * the prompt a key was tried and measured over nine live evaluation runs:
   * untouched it scored 96.6 / 96.6 / 98.3 and never missed the 95% gate,
   * while two shapes of the change scored 94.8 / 96.6 / 93.1 and
   * 81.0 / 96.6 / 96.6 and failed it three times in six. So the change does
   * not ship and **D35** carries it.
   *
   * This test is the difference between *"no edital has barriers"* and *"we
   * are not reading them yet"*. When D35 lands it should fail, and that is the
   * point: it is a tripwire on a known gap, not a guard on a behaviour.
   */
  it('never marks a row barred, because nothing can say which row a barrier is about', () => {
    const list = tenderChecklist(
      TENDER,
      model({
        qualification: [finding('minimumCapital', { tone: 'attention' })],
        blockers: [blocker('capital mínimo de R$ 18.217,55'), blocker('garantia de 5%')],
      }), PAID
    )
    expect(list.rows.every((r) => r.state !== 'blocker')).toBe(true)
    // And the demanding row is still *answered* — the fraction counts
    // conferidos, not passed, which is the rule that survives D35.
    expect(list.rows.find((r) => r.key === 'minimumCapital')?.state).toBe('ok')
  })
})
