import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getJobStatus,
  priceHref,
  radarHref,
  readSearch,
  screeningHref,
  tenderApiPath,
  tenderHref,
  tenderPath,
  tendersUrl,
} from './client'
import { listKey } from './list-cache'

const TENDER_ID = '51885242000140-1-000744/2026'

/** What a user who searched a CNPJ, a state and a word, on a chosen tab, has. */
const SEARCH = { cnpj: '51885242000140', state: 'SP', q: 'papel', group: 'check' } as const

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('tender addresses', () => {
  it('keeps the slash inside a PNCP id as a path separator, never %2F', () => {
    expect(tenderPath(TENDER_ID)).toBe('51885242000140-1-000744/2026')
    expect(tenderHref(TENDER_ID, {})).toBe('/radar/edital/51885242000140-1-000744/2026')
    expect(tenderHref(TENDER_ID, {})).not.toContain('%2F')
  })

  it('still escapes anything else an id could carry', () => {
    expect(tenderPath('a b/c?d')).toBe('a%20b/c%3Fd')
  })

  it('does the opposite for the API, whose [id] is a single segment', () => {
    // Verified against the running route: the real slash answers 404 there,
    // because `/api/tenders/[id]` cannot match two path segments.
    expect(tenderApiPath(TENDER_ID)).toBe('51885242000140-1-000744%2F2026')
    expect(tenderApiPath(TENDER_ID)).not.toBe(tenderPath(TENDER_ID))
  })
})

describe('radarHref', () => {
  it('leaves out what is empty', () => {
    expect(radarHref({})).toBe('/radar')
    expect(radarHref({ cnpj: '12345678000195' })).toBe('/radar?cnpj=12345678000195')
  })

  /**
   * `group=compatible` used to be dropped as "the default", which made an
   * address unable to say whether the user had chosen a tab: a search whose
   * hits are all in Palavras opened on an empty Compatíveis, and the screen
   * could not tell that apart from someone pressing Compatíveis on purpose.
   */
  it('names the group whenever it is given one, compatible included', () => {
    expect(radarHref({ cnpj: '12345678000195', group: 'compatible' })).toBe(
      '/radar?cnpj=12345678000195&group=compatible',
    )
    expect(radarHref({ cnpj: '1', state: 'SP', q: 'material hospitalar', group: 'check' })).toBe(
      '/radar?cnpj=1&uf=SP&q=material+hospitalar&group=check',
    )
  })

  it('leaves the group out when there is none: that is "not chosen"', () => {
    expect(radarHref({ cnpj: '1', group: null })).toBe('/radar?cnpj=1')
  })
})

/**
 * The regression this whole shape exists for. Sci lost the search twice: once
 * on the card → tender link, and again — after that one was fixed in isolation
 * — on tender → triagem, because the bare builder was still the default thing
 * to reach for. Every address out of a Radar screen is asserted here, together,
 * so "this one too" is a failing test rather than a bug report.
 */
describe('every address out of a Radar screen carries the search', () => {
  it('spells it the way the Radar itself reads it (uf, not state)', () => {
    expect(tenderHref(TENDER_ID, SEARCH)).toBe(
      '/radar/edital/51885242000140-1-000744/2026?cnpj=51885242000140&uf=SP&q=papel&group=check',
    )
    expect(screeningHref(TENDER_ID, SEARCH)).toBe(
      '/radar/edital/51885242000140-1-000744/2026/triagem?cnpj=51885242000140&uf=SP&q=papel&group=check',
    )
    expect(priceHref(TENDER_ID, SEARCH)).toBe(
      '/radar/edital/51885242000140-1-000744/2026/preco?cnpj=51885242000140&uf=SP&q=papel&group=check',
    )
  })

  it('keeps the item alongside the search rather than instead of it', () => {
    expect(priceHref(TENDER_ID, SEARCH, 3)).toContain('cnpj=51885242000140')
    expect(priceHref(TENDER_ID, SEARCH, 3)).toContain('item=3')
    // `?item=` used to be the only parameter these URLs could carry.
    expect(priceHref(TENDER_ID, {}, 3)).toBe('/radar/edital/51885242000140-1-000744/2026/preco?item=3')
  })

  it('is the plain URL when there is genuinely nothing to carry', () => {
    expect(tenderHref('a/b', {})).toBe('/radar/edital/a/b')
    expect(screeningHref('a/b', {})).toBe('/radar/edital/a/b/triagem')
  })

  /**
   * The round trip the user actually walks: list → tender → triagem → back →
   * back. The last address must be the first one, or the Radar rebuilds a
   * different list and `list-cache.ts` misses the snapshot it saved.
   */
  it('round-trips: the triagem URL still answers the Radar it came from', () => {
    const triagem = screeningHref(TENDER_ID, SEARCH)
    const back = readSearch(new URLSearchParams(triagem.split('?')[1]))
    expect(radarHref(back)).toBe(radarHref(SEARCH))
    expect(radarHref(back)).toBe('/radar?cnpj=51885242000140&uf=SP&q=papel&group=check')
  })
})

describe('readSearch', () => {
  it('takes the parameters that travel and nothing else', () => {
    const params = new URLSearchParams({
      cnpj: '51.885.242/0001-40',
      uf: 'sp',
      q: '  papel  ',
      group: 'check',
      item: '3',
      cursor: 'abc',
    })
    expect(readSearch(params)).toEqual({
      cnpj: '51885242000140',
      state: 'SP',
      q: 'papel',
      // D52's two filters travel too, and read as `null` when absent: `item`
      // and `cursor` still do not travel at all.
      modality: null,
      meEpp: null,
      group: 'check',
      // Not in the query string above, and never `null`: an absent order is the
      // deadline order (D51).
      sort: 'deadline',
    })
  })

  it('reads an unchosen tab as unchosen, which is a different address', () => {
    expect(readSearch(new URLSearchParams({ cnpj: '1' })).group).toBeNull()
    expect(readSearch(new URLSearchParams({ cnpj: '1', group: 'nonsense' })).group).toBeNull()
  })
})

/**
 * The guard the type checker cannot give us.
 *
 * `search` being a required argument stops a *call* that forgets it. It does
 * not stop the mistake that actually shipped, which was not a call at all:
 * `` `${tenderHref(id)}/triagem` `` — a Radar URL assembled by hand, in a
 * screen, out of a path and a literal. Three of those existed. So the screens
 * are read as text, and building one of these addresses anywhere but here is a
 * failing test.
 */
describe('no screen builds a Radar URL by hand', () => {
  const ROOT = new URL('../../app/radar', import.meta.url).pathname

  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) return sources(path)
      if (!/\.tsx?$/.test(entry.name) || entry.name.includes('.test.')) return []
      return [path]
    })
  }

  /**
   * Comments out: these files *describe* `/radar/edital/[...id]/triagem` at
   * length, and prose about an address is not an address.
   */
  function code(file: string): string {
    return readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
  }

  const files = sources(ROOT).map((path) => [path.slice(ROOT.length + 1), code(path)] as const)

  it('reads the Radar screens', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it.each([
    ['a tender path with /triagem or /preco stuck on the end', /\}\/(triagem|preco)/],
    ['a literal /radar/edital/ address', /['"`]\/radar\/edital\//],
  ])('finds no %s', (_what, pattern) => {
    expect(files.filter(([, source]) => pattern.test(source)).map(([name]) => name)).toEqual([])
  })
})

describe('tendersUrl', () => {
  it('always names the group, and only the filters that are set', () => {
    expect(tendersUrl({ group: 'compatible' })).toBe('/api/radar/tenders?group=compatible')
    expect(tendersUrl({ group: 'keyword', cnpj: '1', state: 'SP', q: 'papel', limit: 20 })).toBe(
      '/api/radar/tenders?group=keyword&cnpj=1&state=SP&q=papel&limit=20',
    )
  })
})

describe('getJobStatus', () => {
  function stubFetch(status: number, body: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status, json: async () => body }) as unknown as Response),
    )
  }

  it('reads the status out of the envelope', async () => {
    stubFetch(200, { state: 'ready', job: { id: 1, kind: 'company_lookup', status: 'running' } })
    expect(await getJobStatus(1)).toBe('running')
  })

  it('treats a collected job as gone, not as a failure', async () => {
    stubFetch(404, { state: 'error', error: 'not_found' })
    expect(await getJobStatus(1)).toBe('gone')
  })

  it('treats any other error envelope as gone, so the caller re-reads', async () => {
    stubFetch(429, { state: 'error', error: 'rate_limited' })
    expect(await getJobStatus(1)).toBe('gone')
  })
})

/**
 * The order in the URL (D51), end to end: what the browser's address says, what
 * `readSearch` reads back out of it, and what the API is then asked for.
 *
 * The property being pinned is **"absent means the deadline order"** in all
 * three directions at once. It has to hold in all three or the Radar quietly
 * disagrees with itself: a link that spells `sort=deadline` out would make
 * `radarHref(readSearch(url)) !== url` for every address the product has ever
 * drawn, and `listKey` would then file the same list under two keys.
 */
describe('the sort in the URL', () => {
  it('leaves the default out, and writes the two that are a choice', () => {
    expect(radarHref({ cnpj: '1', sort: 'deadline' })).toBe('/radar?cnpj=1')
    expect(radarHref({ cnpj: '1', sort: null })).toBe('/radar?cnpj=1')
    expect(radarHref({ cnpj: '1' })).toBe('/radar?cnpj=1')
    expect(radarHref({ cnpj: '1', sort: 'valueDesc' })).toBe('/radar?cnpj=1&sort=valueDesc')
    expect(radarHref({ cnpj: '1', sort: 'valueAsc' })).toBe('/radar?cnpj=1&sort=valueAsc')
  })

  it('reads an absent, empty or misspelt order as the deadline order', () => {
    expect(readSearch(new URLSearchParams({ cnpj: '1' })).sort).toBe('deadline')
    expect(readSearch(new URLSearchParams({ cnpj: '1', sort: '' })).sort).toBe('deadline')
    expect(readSearch(new URLSearchParams({ cnpj: '1', sort: 'prazo' })).sort).toBe('deadline')
    expect(readSearch(new URLSearchParams({ cnpj: '1', sort: 'valueDesc' })).sort).toBe('valueDesc')
  })

  it('round-trips through a tender address and back to the same Radar', () => {
    const sorted = { ...SEARCH, sort: 'valueAsc' } as const
    const triagem = screeningHref(TENDER_ID, sorted)
    expect(triagem).toContain('sort=valueAsc')
    const back = readSearch(new URLSearchParams(triagem.split('?')[1]))
    expect(back.sort).toBe('valueAsc')
    expect(radarHref(back)).toBe(radarHref(sorted))
    expect(radarHref(back)).toBe(
      '/radar?cnpj=51885242000140&uf=SP&q=papel&group=check&sort=valueAsc',
    )
  })

  it('round-trips the default: the way back is the bare address, twice over', () => {
    const triagem = screeningHref(TENDER_ID, { ...SEARCH, sort: 'deadline' })
    expect(triagem).not.toContain('sort')
    const back = readSearch(new URLSearchParams(triagem.split('?')[1]))
    // `readSearch` filled it in, and `radarHref` takes it straight back out.
    expect(back.sort).toBe('deadline')
    expect(radarHref(back)).toBe(radarHref(SEARCH))
    // Idempotent: reading an address and rebuilding it is the same address.
    const again = readSearch(new URLSearchParams(radarHref(back).split('?')[1]))
    expect(radarHref(again)).toBe(radarHref(back))
  })

  it('asks the route for the same thing the address says', () => {
    expect(tendersUrl({ group: 'compatible', cnpj: '1' })).toBe(
      '/api/radar/tenders?group=compatible&cnpj=1',
    )
    expect(tendersUrl({ group: 'compatible', cnpj: '1', sort: 'deadline' })).toBe(
      '/api/radar/tenders?group=compatible&cnpj=1',
    )
    expect(tendersUrl({ group: 'compatible', cnpj: '1', sort: 'valueDesc' })).toBe(
      '/api/radar/tenders?group=compatible&cnpj=1&sort=valueDesc',
    )
    // The whole hop, as `radar-screen.tsx` makes it: address → search → request.
    const search = readSearch(new URLSearchParams('cnpj=1&uf=SP&q=papel&sort=valueAsc'))
    expect(
      tendersUrl({ group: 'keyword', cnpj: search.cnpj, state: search.state, q: search.q, sort: search.sort }),
    ).toBe('/api/radar/tenders?group=keyword&cnpj=1&state=SP&q=papel&sort=valueAsc')
  })

  /** `listKey` keys the Back button, so the order has to be part of it. */
  it('keys a differently sorted list as a different list', () => {
    const base = { cnpj: '1', state: null, q: null, group: 'compatible' } as const
    expect(listKey({ ...base, sort: 'deadline' })).toBe(listKey(base))
    expect(listKey({ ...base, sort: 'valueDesc' })).not.toBe(listKey(base))
    expect(listKey({ ...base, sort: 'valueDesc' })).not.toBe(listKey({ ...base, sort: 'valueAsc' }))
  })
})
