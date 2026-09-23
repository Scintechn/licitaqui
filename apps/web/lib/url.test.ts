import { describe, expect, it } from 'vitest'
import { withQuery } from '@/lib/url'

describe('withQuery', () => {
  it('uses `?` when the base has none', () => {
    expect(withQuery('/conta', 'estado=empresa')).toBe('/conta?estado=empresa')
  })

  it('uses `&` when the base already has a query string', () => {
    // The whole point. `${base}?estado=empresa` here produces a URL with two
    // `?`, and everything after the second one is swallowed into the value of
    // the parameter before it — which is how the magic-link confirmation was
    // lost on 2026-09-23.
    expect(withQuery('/radar?cnpj=36955612000185', 'estado=empresa')).toBe(
      '/radar?cnpj=36955612000185&estado=empresa',
    )
    expect(withQuery('/radar?cnpj=1&uf=SP', 'estado=empresa')).toBe(
      '/radar?cnpj=1&uf=SP&estado=empresa',
    )
  })

  it('never produces two `?`', () => {
    for (const base of ['/x', '/x?a=1', '/x?a=1&b=2', '/x?', '/x&']) {
      const joined = withQuery(base, 'c=3')
      expect(joined.match(/\?/g)?.length ?? 0, `for ${base}`).toBeLessThanOrEqual(1)
    }
  })

  it('does not add an empty parameter when the base ends in a separator', () => {
    expect(withQuery('/x?', 'a=1')).toBe('/x?a=1')
    expect(withQuery('/x?a=1&', 'b=2')).toBe('/x?a=1&b=2')
  })

  it('returns the base untouched when there is nothing to append', () => {
    expect(withQuery('/conta', '')).toBe('/conta')
    expect(withQuery('/conta?a=1', new URLSearchParams())).toBe('/conta?a=1')
  })

  it('accepts URLSearchParams and encodes through it', () => {
    const params = new URLSearchParams({ estado: 'cnpj inválido' })
    expect(withQuery('/conta', params)).toBe('/conta?estado=cnpj+inv%C3%A1lido')
  })

  it('tolerates a leading `?` or `&` on the query it is given', () => {
    expect(withQuery('/x', '?a=1')).toBe('/x?a=1')
    expect(withQuery('/x?a=1', '&b=2')).toBe('/x?a=1&b=2')
  })

  it('keeps a fragment last, where a fragment has to be', () => {
    expect(withQuery('/x#top', 'a=1')).toBe('/x?a=1#top')
    expect(withQuery('/x?a=1#top', 'b=2')).toBe('/x?a=1&b=2#top')
  })
})
