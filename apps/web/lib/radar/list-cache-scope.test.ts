import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TenderCard } from './contract'
import {
  clearSnapshots,
  listKey,
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

/** One reader, one company: `scope` is the only thing that differs below. */
const SEARCH = { cnpj: null, state: null, q: null, group: 'compatible' } as const

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

  it('leaves no path on which a changed caller reaches the page-1 merge', () => {
    /*
     * D55's first attempt at D60 forced the restore to revalidate, and
     * `refreshTenders` merges page 1 **by id**: the fresh answer swapped the
     * header to the new company and left the old company's rows beneath it —
     * D19 recreated by D19's own fix, caught by reading the diff and not by the
     * suite.
     *
     * The guard is structural rather than a check, and this is the assertion
     * that says so: the only input `revalidate` could have is a restored
     * snapshot, and for a changed scope there is none to restore. Asserted at
     * the two ages separately, because they fail differently — `fresh` draws the
     * stale list with no request, `revalidate` merges into it.
     */
    saveList(listKey(MINE), snapshot())
    expect(restoreList(THEIRS, NOW + REVALIDATE_AFTER_MS - 1)).toBeNull()
    expect(restoreList(THEIRS, NOW + REVALIDATE_AFTER_MS + 1)).toBeNull()
  })
})
