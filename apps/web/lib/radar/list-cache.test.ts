import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { TenderCard } from './contract'
import {
  clearSnapshots,
  forgetList,
  listKey,
  MAX_SNAPSHOTS,
  readCompany,
  readList,
  refreshTenders,
  rememberScroll,
  RESTORE_TTL_MS,
  restoreList,
  REVALIDATE_AFTER_MS,
  saveCompany,
  saveList,
  type ListSnapshot,
} from './list-cache'

/**
 * The cache refuses to work outside a browser on purpose — module state on a
 * serverless function is shared between requests, and everything it holds is
 * one visitor's data. The suite runs in Node, so it declares a `window` for
 * the duration and takes it away again; that the guard exists at all is
 * asserted in the last test in this file.
 */
class MemoryStorage {
  private readonly entries = new Map<string, string>()
  /** Set to make `setItem` throw, the way a full quota does. */
  full = false
  get length() {
    return this.entries.size
  }
  key(index: number) {
    return [...this.entries.keys()][index] ?? null
  }
  getItem(name: string) {
    return this.entries.get(name) ?? null
  }
  setItem(name: string, value: string) {
    if (this.full) throw new DOMException('quota', 'QuotaExceededError')
    this.entries.set(name, value)
  }
  removeItem(name: string) {
    this.entries.delete(name)
  }
  clear() {
    this.entries.clear()
  }
}

const session = new MemoryStorage()

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', {
    value: { sessionStorage: session },
    configurable: true,
  })
})
afterAll(() => {
  Reflect.deleteProperty(globalThis, 'window')
})
beforeEach(() => {
  session.full = false
  clearSnapshots()
  session.clear()
})

const NOW = 1_800_000_000_000

function tender(id: string, close = '2026-09-30T11:30:00.000Z'): TenderCard {
  return {
    id,
    object: `Objeto ${id}`,
    shortTitle: null,
    agencyName: 'Prefeitura de Campinas',
    city: 'Campinas',
    state: 'SP',
    modalityName: 'Pregão eletrônico',
    status: 'Divulgada no PNCP',
    pncpUpdatedAt: null,
    proposalsCloseAt: close,
    estimatedValue: null,
    confidentialBudget: false,
    priceRegistration: false,
    meEppSummary: 'none',
    favoredTreatment: true,
    itemCount: 1,
    segments: [],
    matchedSegments: [],
    group: 'compatible',
  }
}

function snapshot(over: Partial<ListSnapshot> = {}): ListSnapshot {
  return {
    group: 'compatible',
    company: null,
    visitor: null,
    counts: { compatible: 140, check: 352, keyword: 0 },
    tenders: [tender('a'), tender('b')],
    nextCursor: 'cursor-3',
    freshness: { state: 'fresh', updatedAt: null, ageSeconds: 120 },
    status: 'ready',
    savedAt: NOW,
    scrollY: 3000,
    ...over,
  }
}

const QUERY = { cnpj: '36955612000185', state: null, q: null, group: null }

describe('listKey', () => {
  it('separates every query that returns a different list', () => {
    const base = listKey(QUERY)
    expect(listKey({ ...QUERY, state: 'SP' })).not.toBe(base)
    expect(listKey({ ...QUERY, q: 'papel' })).not.toBe(base)
    expect(listKey({ ...QUERY, group: 'check' })).not.toBe(base)
    expect(listKey(QUERY)).toBe(base)
  })

  it('keys an unchosen group apart from a chosen Compatíveis', () => {
    expect(listKey({ ...QUERY, group: null })).not.toBe(listKey({ ...QUERY, group: 'compatible' }))
  })

  it('cannot be confused by a keyword that looks like the separator', () => {
    // A join on a printable character would let `q` forge a different query.
    expect(listKey({ ...QUERY, q: 'a', state: 'b' })).not.toBe(
      listKey({ ...QUERY, q: 'a\u0000b', state: null }),
    )
  })
})

describe('how long a list may be reused — the staleness rule', () => {
  const key = listKey(QUERY)

  it('under a minute: restored, and nothing is asked of the server', () => {
    saveList(key, snapshot())
    expect(readList(key, NOW + 30_000)?.use).toBe('fresh')
    expect(readList(key, NOW + REVALIDATE_AFTER_MS - 1)?.use).toBe('fresh')
  })

  it('a minute to half an hour: restored, then refreshed behind it (§3.1)', () => {
    saveList(key, snapshot())
    expect(readList(key, NOW + REVALIDATE_AFTER_MS)?.use).toBe('revalidate')
    expect(readList(key, NOW + RESTORE_TTL_MS)?.use).toBe('revalidate')
  })

  it('past half an hour: gone, because §3.2 gives open tenders 30 minutes', () => {
    saveList(key, snapshot())
    // A list from yesterday would show tenders whose window has closed, and
    // `proposals_close_at > now()` is evaluated in Postgres, not in this tab.
    expect(readList(key, NOW + RESTORE_TTL_MS + 1)).toBeNull()
  })

  it('forgets an expired snapshot rather than leaving it to be found again', () => {
    saveList(key, snapshot())
    expect(readList(key, NOW + RESTORE_TTL_MS + 1)).toBeNull()
    expect(readList(key, NOW)).toBeNull()
  })

  it('treats a backwards clock as unusable, not as infinitely fresh', () => {
    saveList(key, snapshot())
    expect(readList(key, NOW - 1)).toBeNull()
  })

  it('restores every page that was loaded, and where the next one starts', () => {
    const four = Array.from({ length: 80 }, (_, i) => tender(`t${i}`))
    saveList(key, snapshot({ tenders: four, nextCursor: 'cursor-5' }))
    const restored = readList(key, NOW + 1_000)
    expect(restored?.snapshot.tenders).toHaveLength(80)
    expect(restored?.snapshot.nextCursor).toBe('cursor-5')
    expect(restored?.snapshot.scrollY).toBe(3000)
  })

  it('keeps the tab that was on screen, not the one the URL implies', () => {
    saveList(key, snapshot({ group: 'keyword' }))
    expect(readList(key, NOW)?.snapshot.group).toBe('keyword')
  })
})

describe('the cache as a cache', () => {
  it('holds a bounded number of lists, dropping the least recently written', () => {
    for (let i = 0; i < MAX_SNAPSHOTS + 3; i += 1) {
      saveList(listKey({ ...QUERY, q: `q${i}` }), snapshot())
    }
    expect(readList(listKey({ ...QUERY, q: 'q0' }), NOW)).toBeNull()
    expect(readList(listKey({ ...QUERY, q: `q${MAX_SNAPSHOTS + 2}` }), NOW)).not.toBeNull()
  })

  it('re-saving a key keeps it, and pushes out something older instead', () => {
    const first = listKey({ ...QUERY, q: 'first' })
    saveList(first, snapshot())
    for (let i = 0; i < MAX_SNAPSHOTS - 1; i += 1) {
      saveList(listKey({ ...QUERY, q: `q${i}` }), snapshot())
    }
    saveList(first, snapshot())
    saveList(listKey({ ...QUERY, q: 'last' }), snapshot())
    expect(readList(first, NOW)).not.toBeNull()
  })

  it('forgets on demand, which is what "Tentar de novo" means', () => {
    const key = listKey(QUERY)
    saveList(key, snapshot())
    forgetList(key)
    expect(readList(key, NOW)).toBeNull()
  })

  it('records the scroll position without rewriting the snapshot', () => {
    const key = listKey(QUERY)
    saveList(key, snapshot({ scrollY: 0 }))
    rememberScroll(key, 1420.6)
    expect(readList(key, NOW)?.snapshot.scrollY).toBe(1421)
    // Ignores a negative from an over-scroll bounce.
    rememberScroll(key, -40)
    expect(readList(key, NOW)?.snapshot.scrollY).toBe(0)
  })
})

describe('the company half', () => {
  it('spares the CNPJ a re-post for a minute, and no longer', () => {
    // `visitor` rides along with it — the number of triagens left changes on
    // another screen — so this one is deliberately short-lived.
    saveCompany('36955612000185', {
      company: null,
      visitor: null,
      manualCnae: false,
      savedAt: NOW,
    })
    expect(readCompany('36955612000185', NOW + REVALIDATE_AFTER_MS - 1)).not.toBeNull()
    expect(readCompany('36955612000185', NOW + REVALIDATE_AFTER_MS)).toBeNull()
  })
})

describe('refreshTenders', () => {
  const a = tender('a')
  const b = tender('b')

  it('replaces a row in place and keeps the order and the length', () => {
    const newer = { ...tender('b'), itemCount: 42 }
    const merged = refreshTenders([a, b], [newer, tender('c')])
    expect(merged.map((t) => t.id)).toEqual(['a', 'b'])
    expect(merged[1].itemCount).toBe(42)
  })

  it('never inserts a tender that appeared since: it would move their place', () => {
    expect(refreshTenders([a], [tender('z'), a]).map((t) => t.id)).toEqual(['a'])
  })

  it('never removes one that closed: the card says "encerrado" on its own', () => {
    expect(refreshTenders([a, b], [a]).map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('returns the same array when nothing changed, so React re-renders nothing', () => {
    const current = [a, b]
    expect(refreshTenders(current, [a, b])).toBe(current)
    expect(refreshTenders(current, [])).toBe(current)
  })
})

/**
 * The Opportunity screen's "Voltar" is a document navigation, so by the time
 * the Radar mounts the module-level Map is gone. Without the mirror the list
 * would rebuild itself exactly as it did before the fix — which is the whole
 * failure — so these tests simulate that: wipe the Map, keep the storage.
 */
describe('surviving a document navigation', () => {
  const key = listKey(QUERY)

  function reload() {
    // A new page load: the Map is empty, `sessionStorage` is not.
    lists_only_clear()
  }

  /** `clearSnapshots()` erases storage too, so the Map is cleared by hand. */
  function lists_only_clear() {
    const saved = new Map<string, string>()
    for (let i = 0; i < session.length; i += 1) {
      const name = session.key(i)
      if (name) saved.set(name, session.getItem(name) as string)
    }
    clearSnapshots()
    for (const [name, value] of saved) session.setItem(name, value)
  }

  it('restores the list, every page of it, from storage', () => {
    const many = Array.from({ length: 60 }, (_, i) => tender(`t${i}`))
    saveList(key, snapshot({ tenders: many, nextCursor: 'cursor-4', scrollY: 3000 }))
    reload()

    const restored = readList(key, NOW + 5_000)
    expect(restored?.snapshot.tenders).toHaveLength(60)
    expect(restored?.snapshot.nextCursor).toBe('cursor-4')
    expect(restored?.snapshot.scrollY).toBe(3000)
    expect(restored?.use).toBe('fresh')
  })

  it('applies the same staleness rule to what it finds there', () => {
    saveList(key, snapshot())
    reload()
    expect(readList(key, NOW + RESTORE_TTL_MS + 1)).toBeNull()
    // …and having judged it stale, it does not leave it behind to be found
    // again by the next page load.
    expect(session.getItem(`licitaqui.radar.list:${key}`)).toBeNull()
  })

  it('ignores anything in storage that is not a snapshot', () => {
    session.setItem(`licitaqui.radar.list:${key}`, 'not json')
    expect(readList(key, NOW)).toBeNull()
    session.setItem(`licitaqui.radar.list:${key}`, JSON.stringify({ tenders: 'nope' }))
    expect(readList(key, NOW)).toBeNull()
    session.setItem(
      `licitaqui.radar.list:${key}`,
      JSON.stringify({ ...snapshot(), status: 'analyzing' }),
    )
    expect(readList(key, NOW)).toBeNull()
  })

  it('keeps working when storage refuses to be written to', () => {
    session.full = true
    saveList(key, snapshot())
    // The Map still has it for this context, which is the common case.
    expect(readList(key, NOW)?.snapshot.tenders).toHaveLength(2)
  })

  it('remembers the scroll position across the navigation too', () => {
    saveList(key, snapshot({ scrollY: 0 }))
    rememberScroll(key, 1800)
    reload()
    expect(readList(key, NOW)?.snapshot.scrollY).toBe(1800)
  })
})

describe('the server guard', () => {
  it('stores nothing when there is no window', () => {
    const key = listKey(QUERY)
    Reflect.deleteProperty(globalThis, 'window')
    saveList(key, snapshot())
    expect(readList(key, NOW)).toBeNull()
    Object.defineProperty(globalThis, 'window', {
      value: { sessionStorage: session },
      configurable: true,
    })
    // …and the same read from a browser still finds nothing: it was never
    // written. One visitor's Radar must never be able to reach another's.
    expect(readList(key, NOW)).toBeNull()
  })
})

/**
 * The journey this whole file exists for, keyed end to end: the Radar is
 * searched with no tab in the URL, a tender is opened, and the Opportunity
 * screen's "Voltar" comes back with the group spelled out — a different key
 * for the same list.
 */
describe('restoreList, and the key the way back actually uses', () => {
  const unchosen = { cnpj: '36955612000185', state: null, q: null, group: null } as const

  it('restores a list saved unchosen when the way back names its group', () => {
    saveList(listKey(unchosen), snapshot({ group: 'compatible' }))
    const back = { ...unchosen, group: 'compatible' } as const
    expect(readList(listKey(back), NOW)).toBeNull()
    expect(restoreList(back, NOW)?.snapshot.tenders).toHaveLength(2)
  })

  it('refuses to hand over a list of a different group', () => {
    // The search landed on Palavras; the URL says Compatíveis. These are not
    // the same list and one must never be shown as the other.
    saveList(listKey(unchosen), snapshot({ group: 'keyword' }))
    expect(restoreList({ ...unchosen, group: 'compatible' }, NOW)).toBeNull()
    expect(restoreList({ ...unchosen, group: 'keyword' }, NOW)?.snapshot.group).toBe('keyword')
  })

  it('refuses a direct hit whose snapshot is of another group', () => {
    // What a stale write produced on 2026-09-23: the Compatíveis list filed
    // under the Verificar key by a navigation that had not loaded yet. The key
    // matches exactly, which is precisely why this was served — and a key
    // match is not a list match.
    const chosen = { ...unchosen, group: 'check' } as const
    saveList(listKey(chosen), snapshot({ group: 'compatible' }))

    // The entry is there and readable; it is `restoreList` that refuses it.
    expect(readList(listKey(chosen), NOW)?.snapshot.group).toBe('compatible')
    expect(restoreList(chosen, NOW)).toBeNull()
  })

  it('still hands over a direct hit that agrees with itself', () => {
    // The guard above must not cost the ordinary case anything.
    const chosen = { ...unchosen, group: 'check' } as const
    saveList(listKey(chosen), snapshot({ group: 'check', nextCursor: 'from-check' }))
    expect(restoreList(chosen, NOW)?.snapshot.nextCursor).toBe('from-check')
  })

  it('does not look sideways when the URL chose nothing', () => {
    saveList(listKey({ ...unchosen, group: 'check' }), snapshot({ group: 'check' }))
    expect(restoreList(unchosen, NOW)).toBeNull()
  })

  it('prefers the exact key when both exist', () => {
    saveList(listKey(unchosen), snapshot({ group: 'compatible', nextCursor: 'from-auto' }))
    saveList(
      listKey({ ...unchosen, group: 'compatible' }),
      snapshot({ group: 'compatible', nextCursor: 'from-chosen' }),
    )
    expect(restoreList({ ...unchosen, group: 'compatible' }, NOW)?.snapshot.nextCursor).toBe(
      'from-chosen',
    )
  })

  it('still applies the staleness rule to the sideways match', () => {
    saveList(listKey(unchosen), snapshot({ group: 'compatible' }))
    expect(restoreList({ ...unchosen, group: 'compatible' }, NOW + RESTORE_TTL_MS + 1)).toBeNull()
  })
})
