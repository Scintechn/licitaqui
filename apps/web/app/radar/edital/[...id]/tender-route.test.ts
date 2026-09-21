import { describe, expect, it } from 'vitest'
import { readTenderRoute } from './tender-route'

/**
 * The dispatch a catch-all segment forces on us — see `tender-route.ts` for
 * why the three screens share one route file.
 */

const ID = '00394544000185-1-002027/2026'
const SEGMENTS = ID.split('/')

describe('readTenderRoute', () => {
  it('reads the bare id as the Opportunity screen', () => {
    expect(readTenderRoute(SEGMENTS)).toEqual({ view: 'opportunity', tenderId: ID })
  })

  it('reads the two screens the board puts behind it', () => {
    expect(readTenderRoute([...SEGMENTS, 'triagem'])).toEqual({ view: 'screening', tenderId: ID })
    expect(readTenderRoute([...SEGMENTS, 'preco'])).toEqual({ view: 'price', tenderId: ID })
  })

  it('keeps the slash inside the id rather than losing it to the segments', () => {
    const route = readTenderRoute([...SEGMENTS, 'triagem'])
    expect(route).toHaveProperty('tenderId', '00394544000185-1-002027/2026')
  })

  it('shows the "edital não encontrado" card for a malformed id', () => {
    expect(readTenderRoute(['nao-e-um-id'])).toEqual({ view: 'badId' })
    expect(readTenderRoute(['nao-e-um-id', 'triagem'])).toEqual({ view: 'badId' })
    expect(readTenderRoute(['00394544000185-1-002027', '20xx'])).toEqual({ view: 'badId' })
  })

  it('404s a path that is not one of the screens', () => {
    expect(readTenderRoute([...SEGMENTS, 'analise'])).toEqual({ view: 'unknown' })
    expect(readTenderRoute([...SEGMENTS, 'triagem', 'extra'])).toEqual({ view: 'unknown' })
    expect(readTenderRoute([])).toEqual({ view: 'unknown' })
    expect(readTenderRoute(undefined)).toEqual({ view: 'unknown' })
  })

  it('ignores an empty segment from a trailing slash', () => {
    expect(readTenderRoute([...SEGMENTS, ''])).toEqual({ view: 'opportunity', tenderId: ID })
  })
})
