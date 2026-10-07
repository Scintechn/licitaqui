import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TenderCard } from './contract'
import {
  clearSnapshots,
  listKey,
  readList,
  refreshFavourites,
  restoreList,
  saveList,
  withFavourite,
  type ListSnapshot,
} from './list-cache'

/**
 * D23's stars, in the snapshot — the half of the card that is not on screen.
 *
 * The defect this file guards is the one the card's own tests cannot see:
 * marking a tender from the list, opening it, and pressing **Voltar** to a
 * restored list with every star empty. The restore is deliberately *silent* —
 * inside `REVALIDATE_AFTER_MS` nothing is requested at all — so if the marked
 * ids are not in the snapshot there is no second chance to learn them.
 *
 * The merge rules are here too, because both are about a fact the route did not
 * mention: a background refresh asks for page 1 and says nothing about pages 2
 * and 3, and reading its silence as "not marked" would empty most of a scrolled
 * list.
 */

const NOW = Date.parse('2026-10-06T12:00:00.000Z')

/** The shape `sessionStorage` is given, since every test here writes one. */
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
    this.data.set(key, value)
  }
  /** What a previous deploy left behind, for the guard test below. */
  raw(key: string, value: string): void {
    this.data.set(key, value)
  }
}

let storage: Memory

beforeEach(() => {
  storage = new Memory()
  // `list-cache.ts` is a no-op outside a browser, so there has to be one.
  Object.defineProperty(globalThis, 'window', {
    value: { sessionStorage: storage },
    configurable: true,
    writable: true,
  })
  clearSnapshots()
})

afterEach(() => {
  clearSnapshots()
  Reflect.deleteProperty(globalThis as Record<string, unknown>, 'window')
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

const QUERY = { scope: 'scope-one', cnpj: '11222333000181', state: null, q: null, group: 'compatible' } as const

function snapshot(over: Partial<ListSnapshot> = {}): ListSnapshot {
  return {
    group: 'compatible',
    grouping: null,
    visitor: null,
    counts: { compatible: 3, check: 0, keyword: 0 },
    tenders: [tender('a'), tender('b'), tender('c')],
    favourites: ['b'],
    nextCursor: null,
    freshness: { state: 'fresh', updatedAt: null, ageSeconds: 10 },
    status: 'ready',
    savedAt: NOW,
    scrollY: 0,
    ...over,
  }
}

describe('the snapshot carries the marked ids', () => {
  it('restores them with the rows, without a request', () => {
    const key = listKey(QUERY)
    saveList(key, snapshot())

    // A second context, so the answer can only have come from storage — which
    // is what the Opportunity screen's "Voltar" (a document navigation) leaves
    // us with.
    clearSnapshots()
    storage.raw(
      `licitaqui.radar.list:${key}`,
      JSON.stringify(snapshot()),
    )

    const restored = restoreList(QUERY, NOW + 1_000)
    expect(restored, 'the list came back').not.toBeNull()
    expect(restored?.use, 'under a minute old: nothing is re-read').toBe('fresh')
    expect(restored?.snapshot.favourites).toEqual(['b'])
  })

  it('refuses an entry from before this field existed, rather than emptying the stars', () => {
    const key = listKey(QUERY)
    const old: Record<string, unknown> = { ...snapshot() }
    delete old.favourites
    storage.raw(`licitaqui.radar.list:${key}`, JSON.stringify(old))

    // A deploy boundary: the entry is otherwise perfectly valid. Restoring it
    // would draw hollow stars over tenders this reader had marked, which is
    // worse than one request.
    expect(readList(key, NOW + 1_000)).toBeNull()
  })
})

describe('withFavourite', () => {
  const onScreen = [tender('a'), tender('b'), tender('z')]

  it('adds and removes', () => {
    expect(withFavourite(['a'], 'b', true, onScreen)).toEqual(['a', 'b'])
    expect(withFavourite(['a', 'b'], 'a', false, onScreen)).toEqual(['b'])
  })

  it('returns the same array when nothing changes', () => {
    // The star reports twice per press — optimistically, then with the route's
    // answer — and the second report must cost no render and no re-write.
    const marked = ['a', 'b']
    expect(withFavourite(marked, 'a', true, onScreen)).toBe(marked)
    expect(withFavourite(marked, 'z', false, onScreen)).toBe(marked)
  })

  it('ignores a tender that is not on screen', () => {
    // A POST that resolves after the reader moved to another search. Writing the
    // id would file it under a list no card of which can match it, and the save
    // effect would put it in `sessionStorage` for the life of the tab.
    const marked = ['a']
    expect(withFavourite(marked, 'gone', true, onScreen)).toBe(marked)
    // Including the case where it *is* in the set: an id that cannot be seen
    // cannot be unmarked by an answer about a list it is not in.
    expect(withFavourite(['gone'], 'gone', false, onScreen)).toEqual(['gone'])
  })

  it('still accepts a tender the new list happens to contain', () => {
    // The filter is "can a card show this", not "did this list request it": if
    // the reader has navigated to a search that also holds the tender, the mark
    // is real and belongs on it.
    expect(withFavourite([], 'b', true, onScreen)).toEqual(['b'])
  })
})

describe('refreshFavourites', () => {
  const pageOne = [tender('a'), tender('b')]

  it('takes the route’s answer for the rows the route returned', () => {
    // 'a' was marked elsewhere, 'b' was unmarked elsewhere. Both are page 1.
    expect(refreshFavourites(['b'], pageOne, ['a']).sort()).toEqual(['a'])
  })

  it('keeps marks on pages the refresh never asked about', () => {
    // The whole point: a refresh reads page 1 and says nothing about page 3, so
    // reading its silence as "not marked" would empty most of a scrolled list.
    const after = refreshFavourites(['b', 'z'], pageOne, ['b'])
    expect(after.sort()).toEqual(['b', 'z'])
  })

  it('keeps everything when the refresh returned nothing', () => {
    const current = ['a', 'z']
    expect(refreshFavourites(current, [], [])).toBe(current)
  })

  it('returns the same array when the answer agrees with what we had', () => {
    const current = ['a', 'z']
    expect(refreshFavourites(current, pageOne, ['a'])).toBe(current)
  })

  it('leaves a star the reader pressed while the refresh was in flight', () => {
    // The refresh read the server before the press, so its "not marked" is older
    // than the reader's own `POST`. Taking its word for it would empty a star
    // they had just filled — and `revalidate()` runs at mount, which is exactly
    // when somebody is looking at the list and pressing things.
    expect(refreshFavourites(['a'], pageOne, [], new Set(['a']))).toEqual(['a'])
    // The other direction too: unmarked here, still marked on the server.
    expect(refreshFavourites([], pageOne, ['a'], new Set(['a']))).toEqual([])
  })

  it('still takes the answer for rows the reader has not touched', () => {
    // The guard is per id, not a blanket "ignore the refresh".
    expect(refreshFavourites(['a'], pageOne, ['b'], new Set(['a'])).sort()).toEqual(['a', 'b'])
  })

  it('ignores ids the answer names that are not on the page it returned', () => {
    // Defence in depth: the envelope is scoped to the page by `listTenders`, and
    // a star is only ever drawn for a row that is here.
    expect(refreshFavourites([], pageOne, ['a', 'nowhere'])).toEqual(['a'])
  })
})
