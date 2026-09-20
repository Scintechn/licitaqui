import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getJobStatus,
  radarHref,
  tenderApiPath,
  tenderHref,
  tenderPath,
  tendersUrl,
} from './client'

const TENDER_ID = '51885242000140-1-000744/2026'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('tender addresses', () => {
  it('keeps the slash inside a PNCP id as a path separator, never %2F', () => {
    expect(tenderPath(TENDER_ID)).toBe('51885242000140-1-000744/2026')
    expect(tenderHref(TENDER_ID)).toBe('/radar/edital/51885242000140-1-000744/2026')
    expect(tenderHref(TENDER_ID)).not.toContain('%2F')
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
  it('leaves out what is empty and keeps the default group implicit', () => {
    expect(radarHref({})).toBe('/radar')
    expect(radarHref({ cnpj: '12345678000195', group: 'compatible' })).toBe(
      '/radar?cnpj=12345678000195',
    )
  })

  it('carries state, keyword and a non-default group', () => {
    expect(radarHref({ cnpj: '1', state: 'SP', q: 'material hospitalar', group: 'check' })).toBe(
      '/radar?cnpj=1&uf=SP&q=material+hospitalar&group=check',
    )
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
