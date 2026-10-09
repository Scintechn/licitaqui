import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TenderCard } from './contract'
import type { CompanyView, GroupedBy } from './contract'
import {
  clearSnapshots,
  listKey,
  refreshTenders,
  regrouped,
  restoreList,
  REVALIDATE_AFTER_MS,
  saveList,
  type ListQuery,
  type ListSnapshot,
} from './list-cache'

/**
 * D58 and D60 — what the caller's scope does once it is inside `listKey`.
 *
 * `scope.test.ts` holds the digest's construction. This file holds the one
 * sentence the cards turn on: **a snapshot written for one caller is not found
 * by another**, and is therefore never merged into, never revalidated against
 * and never drawn.
 *
 * ## Why "not found" and not "rejected"
 *
 * `valid()` rejects an entry written before a field existed — a **deploy**
 * boundary. D58's card asks for the same shape for the **identity** boundary,
 * which is sharper because `sessionStorage` survives a sign-in and a sign-out
 * and does not survive a deploy. Putting the discriminator in the key instead of
 * checking it after the hit is what closes the dead end D55 recorded: there is no
 * path on which `revalidate` can merge page 1 by id (`refreshTenders`) over
 * another company's rows, because there is no hit to revalidate. The last test
 * here is that statement, made against the function that would have done the
 * merging.
 *
 * `environment: 'node'` has no `sessionStorage`, so one is declared for the
 * duration — the same thing `list-cache.test.ts` does, and for the same reason.
 */

const NOW = Date.parse('2026-10-07T12:00:00.000Z')

class Memory implements Storage {
  private data = new Map<string, string>()
  get length(): number {
    return this.data.size
  }
  clear(): void {
    this.data.clear()
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.data.delete(key)
  }
  setItem(key: string, value: string): void {
    this.data.set(key, String(value))
  }
}

/** Both callers' entries live in one jar, which is the point of the suite. */
let storage: Memory

beforeEach(() => {
  storage = new Memory()
  Object.defineProperty(globalThis, 'window', {
    value: { sessionStorage: storage },
    configurable: true,
    writable: true,
  })
  clearSnapshots()
})

afterEach(() => {
  clearSnapshots()
  Reflect.deleteProperty(globalThis as object, 'window')
})

function tender(id: string): TenderCard {
  return {
    id,
    object: `Objeto ${id}`,
    shortTitle: null,
    agencyName: 'Prefeitura de Campinas',
    city: 'Campinas',
    state: 'SP',
    modalityName: 'Pregão eletrônico',
    proposalsCloseAt: '2026-10-20T11:30:00.000Z',
    estimatedValue: '1000.00',
    confidentialBudget: false,
    priceRegistration: false,
    meEppSummary: 'none',
    favoredTreatment: false,
    itemCount: 1,
    segments: [],
    matchedSegments: [],
    group: 'compatible',
    status: 'Divulgada no PNCP',
    pncpUpdatedAt: null,
  }
}

/** The fields `regrouped` ignores, filled once so the ones it reads stand out. */
const COMPANY: Omit<CompanyView, 'cnpj'> = {
  legalName: null,
  tradeName: null,
  mainCnae: '8121400',
  size: 'ME',
  isMei: false,
  state: 'SP',
  city: 'Americana',
  segments: [],
}

/** One reader, one company: `scope` is the only thing that differs below. */
const SEARCH = { cnpj: null, states: [], q: null, group: 'compatible' } as const

const MINE: ListQuery = { ...SEARCH, scope: 'scope-mine' }
const THEIRS: ListQuery = { ...SEARCH, scope: 'scope-theirs' }

function snapshot(over: Partial<ListSnapshot> = {}): ListSnapshot {
  return {
    group: 'compatible',
    grouping: null,
    visitor: null,
    counts: { compatible: 2, check: 0, keyword: 0 },
    tenders: [tender('a'), tender('b')],
    favourites: ['a'],
    nextCursor: null,
    freshness: { state: 'fresh', updatedAt: null, ageSeconds: 10 },
    status: 'ready',
    savedAt: NOW,
    scrollY: 3000,
    ...over,
  }
}

describe('the caller is part of the key', () => {
  it('separates two callers asking the identical question', () => {
    expect(listKey(MINE)).not.toBe(listKey(THEIRS))
    // And it is the *first* field, so no combination of the search's own values
    // can spell another caller's key: the digest is fixed-width base64url and
    // the separator is NUL, which none of them may contain.
    expect(listKey(MINE).startsWith('scope-mine\u0000')).toBe(true)
  })

  it('does not hand one reader the other reader’s stars (D58)', () => {
    // Signed in, marked a tender, snapshot written.
    saveList(listKey(MINE), snapshot())

    /*
     * Signs out in the same tab and comes back to the same search **inside**
     * `REVALIDATE_AFTER_MS`, which is where the defect lived: `readList`
     * answers `fresh` there and the screen makes **no request at all**, so
     * nothing could have corrected the stars for that whole viewing.
     */
    const soon = NOW + REVALIDATE_AFTER_MS - 1
    expect(restoreList(THEIRS, soon)).toBeNull()

    // The entry is not destroyed by the miss: the reader who owns it still gets
    // it, which is what makes signing out and back in cost one request rather
    // than the list.
    const mine = restoreList(MINE, soon)
    expect(mine?.use).toBe('fresh')
    expect(mine?.snapshot.favourites).toEqual(['a'])
  })

  it('does not hand a bare /radar the previous company’s list (D60)', () => {
    /*
     * The shape D55 had to switch the cache off for: no `?cnpj=` and no `?q=`,
     * so every field of the old key was empty and two companies shared one name.
     * Here the only difference between the two queries *is* the company, and it
     * is in the key.
     */
    saveList(listKey(MINE), snapshot({ counts: { compatible: 4, check: 0, keyword: 0 } }))

    expect(restoreList(THEIRS, NOW + 1)).toBeNull()
    // …and the journey the cache exists for still works: same device, same
    // address, the loaded pages and the scroll position come back.
    const back = restoreList(MINE, NOW + 1)
    expect(back?.snapshot.tenders.map((row) => row.id)).toEqual(['a', 'b'])
    expect(back?.snapshot.scrollY).toBe(3000)
  })

  it('keeps both callers’ lists, rather than one overwriting the other', () => {
    saveList(listKey(MINE), snapshot({ tenders: [tender('a')] }))
    saveList(listKey(THEIRS), snapshot({ tenders: [tender('z')] }))

    expect(restoreList(MINE, NOW + 1)?.snapshot.tenders.map((row) => row.id)).toEqual(['a'])
    expect(restoreList(THEIRS, NOW + 1)?.snapshot.tenders.map((row) => row.id)).toEqual(['z'])
    // Two entries in storage, under two names. A discriminator checked *after*
    // the hit would have left one, with the loser re-read on every alternation.
    expect(storage.length).toBe(2)
  })

  it('does not destroy the entry it refuses: the owner still gets it', () => {
    /*
     * The ordinary case must cost nothing. A fix that made every restore miss
     * would pass the two tests above and quietly delete the cache — §4b's shape,
     * and the reason the positive case is asserted beside every negative one.
     */
    saveList(listKey(MINE), snapshot({ nextCursor: 'page-2' }))
    expect(restoreList(THEIRS, NOW + 1)).toBeNull()
    expect(restoreList(MINE, NOW + 1)?.snapshot.nextCursor).toBe('page-2')
  })
})

describe('regrouped — the guard for when the scope was behind (D70)', () => {
  const brilho: GroupedBy = {
    company: { ...COMPANY, legalName: 'BRILHO SERVICOS DE LIMPEZA LTDA' },
    cnaeCount: 4,
  }
  const vida: GroupedBy = {
    company: { ...COMPANY, legalName: 'VIDA COMERCIO DE PRODUTOS HOSPITALARES LTDA' },
    cnaeCount: 2,
  }

  it('says no when the answer is about the same company', () => {
    expect(regrouped(brilho, brilho)).toBe(false)
    expect(regrouped(brilho, { ...brilho, company: { ...brilho.company! } })).toBe(false)
    expect(regrouped(null, null)).toBe(false)
  })

  it('says yes to every shape of change the header would draw', () => {
    expect(regrouped(brilho, vida)).toBe(true)
    // A CNPJ stopped driving the list, or started: a keyword search and a
    // grouped one are not the same list.
    expect(regrouped(brilho, null)).toBe(true)
    expect(regrouped(null, vida)).toBe(true)
    // The CNAE count is what the header prints beside the name, and D19 is the
    // card about those two disagreeing.
    expect(regrouped(brilho, { ...brilho, cnaeCount: 7 })).toBe(true)
    // A company read where none had been: "Sua empresa · sem CNAE lido" is a
    // different header from a named one.
    expect(regrouped({ company: null, cnaeCount: 0 }, { ...brilho, cnaeCount: 0 })).toBe(true)
  })

  it('is what keeps the page-1 merge from drawing one company over another', () => {
    /*
     * **Asserted against the thing it protects**, because the guard alone proves
     * nothing: the defect is what `refreshTenders` does when it is allowed to
     * run on an answer about another company. B's ids match none of A's rows, so
     * the merge changes **nothing** and returns A's list — which the screen then
     * draws under B's header and B's counts. D19, recreated.
     */
    const brilhoRows = [tender('a'), tender('b')]
    const vidaRows = [tender('x'), tender('y')]

    expect(refreshTenders(brilhoRows, vidaRows)).toBe(brilhoRows)
    expect(refreshTenders(brilhoRows, vidaRows).map((row) => row.id)).toEqual(['a', 'b'])

    // So the caller must not reach it, and `regrouped` is the sentence that
    // says so. The result — the screen, after a browser Back — is
    // `e2e/journeys/radar-snapshot-identity.spec.ts`.
    expect(regrouped(brilho, vida)).toBe(true)
  })
})
