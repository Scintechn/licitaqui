import { describe, expect, it } from 'vitest'
import { readFeeds, type Feed } from './feeds'

/**
 * B37's logic, with a fake executor. No database.
 *
 * The state these tests exist for is `refusals_only`. B35 writes a
 * `catalog_bands` row whether it finds a band or refuses one, so a watchdog
 * that counted rows would report a dead feed as healthy — measured 2026-10-04,
 * a full pass produced **947 refusals and 74 bands**, and a pass of 1 028
 * refusals would look identical to a row count.
 */

const NOW = new Date('2026-10-05T12:00:00Z')

type Row = Record<string, unknown>

function executor(row: Row | undefined) {
  return { execute: async () => ({ rows: row === undefined ? [] : [row] }) } as never
}

const failing = { execute: async () => { throw new Error('boom') } } as never

/** Every column the query returns, so a test only states what it is about. */
function row(over: Row = {}): Row {
  const recent = '2026-10-05T07:40:00Z'
  return {
    vocab_wrote: recent, vocab_worked: recent,
    codes_wrote: recent, codes_worked: recent,
    prices_wrote: recent, prices_worked: recent,
    band_count: 74, refusal_count: 947,
    ...over,
  }
}

const find = (feeds: Feed[], key: Feed['key']) => feeds.find((f) => f.key === key)!

describe('readFeeds', () => {
  it('reports every feed, always — a hidden feed is one nobody watches', async () => {
    const feeds = await readFeeds(executor(row()), NOW)
    expect(feeds.map((f) => f.key)).toEqual([
      'catalog_vocabulary',
      'item_codes',
      'catalog_prices',
    ])
  })

  it('is fresh when the last real work is inside the threshold', async () => {
    const feeds = await readFeeds(executor(row()), NOW)
    const prices = find(feeds, 'catalog_prices')
    expect(prices.reading.state).toBe('fresh')
    if (prices.reading.state !== 'fresh') return
    expect(Math.round(prices.reading.hours)).toBe(4)
  })

  it('is stale when nothing real has happened for longer than the threshold', async () => {
    // The price feed is daily and alarms after three days.
    const feeds = await readFeeds(
      executor(row({ prices_worked: '2026-09-28T07:40:00Z' })),
      NOW,
    )
    expect(find(feeds, 'catalog_prices').reading.state).toBe('stale')
  })

  it('separates the weekly feed from the daily ones', async () => {
    // Four days of silence: fine for the weekly mirror, stale for a daily map.
    const fourDaysAgo = '2026-10-01T07:40:00Z'
    const feeds = await readFeeds(
      executor(row({ vocab_worked: fourDaysAgo, codes_worked: fourDaysAgo })),
      NOW,
    )
    expect(find(feeds, 'catalog_vocabulary').reading.state).toBe('fresh')
    expect(find(feeds, 'item_codes').reading.state).toBe('stale')
  })

  it('calls a feed that runs and produces nothing `refusals_only`, not fresh', async () => {
    /**
     * The defect this card is built around. The sweep wrote a row an hour ago,
     * so a row count says healthy; no band came out of it, so nothing was
     * achieved. `CLAUDE.md`: alarm on "0 done in N days", never on "0 queued".
     */
    const feeds = await readFeeds(
      executor(row({ prices_worked: null, band_count: 0, refusal_count: 1028 })),
      NOW,
    )
    const prices = find(feeds, 'catalog_prices')
    expect(prices.reading.state).toBe('refusals_only')
    if (prices.reading.state !== 'refusals_only') return
    // And it prints both counts, so the reader sees what happened.
    expect(prices.reading.detail).toContain('0 faixas')
    expect(prices.reading.detail).toContain('1028 recusas')
  })

  it('a mapper that resolves no exact match is not fresh either', async () => {
    const feeds = await readFeeds(executor(row({ codes_worked: null })), NOW)
    expect(find(feeds, 'item_codes').reading.state).toBe('refusals_only')
  })

  it('says `never` when a feed has not run, which is not the same as stale', async () => {
    const feeds = await readFeeds(
      executor(row({ prices_wrote: null, prices_worked: null })),
      NOW,
    )
    expect(find(feeds, 'catalog_prices').reading.state).toBe('never')
  })

  it('treats an empty result as never run rather than throwing', async () => {
    const feeds = await readFeeds(executor(undefined), NOW)
    expect(feeds.every((f) => f.reading.state === 'never')).toBe(true)
  })

  it('reports a failed query as an error, never as zero', async () => {
    const feeds = await readFeeds(failing, NOW)
    expect(feeds.every((f) => f.reading.state === 'error')).toBe(true)
    for (const feed of feeds) {
      if (feed.reading.state !== 'error') continue
      // A code, never a driver message (§12).
      expect(feed.reading.reason).toBe('query_failed')
      expect(feed.reading.reason).not.toContain('boom')
    }
  })

  it('counts bands and not rows — the trap a row count falls into', async () => {
    const feeds = await readFeeds(executor(row()), NOW)
    const prices = find(feeds, 'catalog_prices')
    if (prices.reading.state === 'never' || prices.reading.state === 'error') {
      throw new Error('unexpected')
    }
    expect(prices.reading.detail).toBe('74 faixas · 947 recusas')
  })
})
