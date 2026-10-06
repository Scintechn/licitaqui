import { describe, expect, it } from 'vitest'
import { DEFAULT_SORT } from './contract'
import {
  ME_EPP_PARAM,
  MODALITY_PARAM,
  radarHref,
  readSearch,
  tendersUrl,
  type RadarSearch,
} from './client'
import { listKey } from './list-cache'

/**
 * D52's two parameters, round-tripped: **the address, the request and the cache
 * key have to agree, or the filter is a lie in one of three different ways.**
 *
 * | the one that drops it | what the reader sees |
 * |---|---|
 * | `radarHref` | pressing *Aplicar filtros* changes nothing |
 * | `tendersUrl` | the URL says Dispensa and the list is everything |
 * | `listKey` | Back restores the other filter's rows, with no request |
 *
 * The third is the quiet one and it has happened here before, on `group`: a
 * snapshot served under a key that was never searched (2026-09-23). So the key
 * is asserted to *change*, not merely to exist.
 */

const SEARCH: RadarSearch = {
  cnpj: '51885242000140',
  state: 'SP',
  q: 'papel',
  modality: 'dispensa',
  meEpp: 'other',
  group: 'compatible',
  // D51's order, written out: it is left out of the URL when it is the default
  // and `readSearch` still answers `DEFAULT_SORT`, so the round trip below is
  // only an equality if this field is here. The two filters behave the other
  // way round — absent reads back as `null` — because *Todas* is not a value
  // the list can be in, it is the absence of a condition.
  sort: DEFAULT_SORT,
}

/** `readSearch` takes anything with a `get`, which is what the screens hand it. */
function search(href: string): RadarSearch {
  return readSearch(new URL(href, 'https://licitaqui.com.br').searchParams)
}

describe('the Radar address carries both filters', () => {
  it('writes them, and reads back exactly what it wrote', () => {
    const href = radarHref(SEARCH)
    expect(href).toContain(`${MODALITY_PARAM}=dispensa`)
    expect(href).toContain(`${ME_EPP_PARAM}=other`)
    expect(search(href)).toEqual(SEARCH)
  })

  it('leaves *Todas* out of the URL entirely', () => {
    const href = radarHref({ ...SEARCH, modality: null, meEpp: null })
    expect(href).not.toContain(MODALITY_PARAM)
    expect(href).not.toContain(ME_EPP_PARAM)
    // …and reading that address back gives `null`, not `''`: the absence of a
    // filter has one spelling, so `scope()` has one thing to test.
    expect(search(href).modality).toBeNull()
    expect(search(href).meEpp).toBeNull()
  })

  it('drops a value the enum does not know rather than carrying it', () => {
    // A hand-typed `?modality=leilao` must not reach the route as a filter that
    // matches nothing: the route would 400 and the reader would see an error
    // for a word they did not type.
    const invented = search(`/radar?${MODALITY_PARAM}=leilao&${ME_EPP_PARAM}=quota`)
    expect(invented.modality).toBeNull()
    expect(invented.meEpp).toBeNull()
  })
})

describe('the request carries both filters', () => {
  it('spells them the same way the page does', () => {
    const url = tendersUrl({
      ...SEARCH,
      // `RadarSearch.group` may be `null` — "the reader has not chosen a tab" —
      // while a request always asks for one. That is the one place the two
      // shapes genuinely differ, and it is spelled out rather than spread.
      group: 'compatible',
    })
    expect(url).toContain(`${MODALITY_PARAM}=dispensa`)
    expect(url).toContain(`${ME_EPP_PARAM}=other`)
    // One spelling on both sides, unlike `uf`/`state`: the names in the
    // address and in the request are the same constants.
    const asked = new URL(url, 'https://licitaqui.com.br').searchParams
    const carried = new URL(radarHref(SEARCH), 'https://licitaqui.com.br').searchParams
    expect(asked.get(MODALITY_PARAM)).toBe(carried.get(MODALITY_PARAM))
    expect(asked.get(ME_EPP_PARAM)).toBe(carried.get(ME_EPP_PARAM))
  })

  it('omits them when they are *Todas*', () => {
    const url = tendersUrl({ group: 'compatible', cnpj: SEARCH.cnpj, q: SEARCH.q })
    expect(url).not.toContain(MODALITY_PARAM)
    expect(url).not.toContain(ME_EPP_PARAM)
  })
})

describe('the cache key carries both filters', () => {
  const base = { cnpj: '51885242000140', state: 'SP', q: 'papel', group: 'compatible' } as const

  it('keys two differently-filtered lists apart', () => {
    const unfiltered = listKey(base)
    expect(listKey({ ...base, modality: 'dispensa' })).not.toBe(unfiltered)
    expect(listKey({ ...base, meEpp: 'exclusive' })).not.toBe(unfiltered)
    expect(listKey({ ...base, meEpp: 'other' })).not.toBe(listKey({ ...base, meEpp: 'exclusive' }))
    expect(listKey({ ...base, modality: 'dispensa' })).not.toBe(
      listKey({ ...base, modality: 'pregao-eletronico' }),
    )
  })

  it('keys the same filters the same way', () => {
    expect(listKey({ ...base, modality: 'dispensa', meEpp: 'other' })).toBe(
      listKey({ ...base, modality: 'dispensa', meEpp: 'other' }),
    )
    // `null` and absent are the same list, because they are the same URL.
    expect(listKey({ ...base, modality: null, meEpp: null })).toBe(listKey(base))
  })

  it('cannot be collided by a keyword that looks like the next field', () => {
    // The NUL separator, re-asserted for the two new fields: `q` is free text
    // and the reader can type anything into it.
    expect(listKey({ ...base, q: 'a', modality: 'dispensa' })).not.toBe(
      listKey({ ...base, q: 'a\u0000dispensa' }),
    )
  })
})
