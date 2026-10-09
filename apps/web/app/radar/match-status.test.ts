import { describe, expect, it } from 'vitest'
import { matchStatus } from './match-status'

const mapped = { segments: [{ segment: 'Informática', fit: 'compatible' as const, fromMainCnae: true, fromSecondaryCnae: false }] }
const unmapped = { segments: [] }

describe('matchStatus', () => {
  it('a company with no CNAEs read is manualCnae, whatever the keyword', () => {
    for (const q of [null, 'baterias']) {
      expect(matchStatus(null, { manualCnae: true, cnpjNotFound: false }, q)).toEqual({
        kind: 'manualCnae',
        cnpjNotFound: false,
      })
    }
  })

  it('carries "both sources said it does not exist" through', () => {
    expect(matchStatus(null, { manualCnae: true, cnpjNotFound: true }, null)).toEqual({
      kind: 'manualCnae',
      cnpjNotFound: true,
    })
  })

  it('an answer without the field is "could not read", which is what it used to mean', () => {
    expect(matchStatus(null, { manualCnae: true }, null)).toEqual({
      kind: 'manualCnae',
      cnpjNotFound: false,
    })
  })

  it('a company read since is ready again — the line the background refresh lacked', () => {
    expect(matchStatus(mapped, { manualCnae: false, cnpjNotFound: false }, null)).toEqual({
      kind: 'ready',
    })
  })

  it('CNAEs that reach no segment are noSegments, unless the keyword found something', () => {
    const read = { manualCnae: false, cnpjNotFound: false }
    expect(matchStatus(unmapped, read, null)).toEqual({ kind: 'noSegments' })
    expect(matchStatus(unmapped, read, 'baterias')).toEqual({ kind: 'ready' })
  })
})
