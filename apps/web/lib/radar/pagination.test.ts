import { describe, expect, it } from 'vitest'
import type { TenderCard } from './contract'
import { appendTenders } from './pagination'

function card(id: string): TenderCard {
  return { id } as TenderCard
}

const page1 = [card('a'), card('b')]
const page2 = [card('c'), card('d')]

describe('appendTenders', () => {
  it('adds the new page after the one already on screen', () => {
    expect(appendTenders(page1, page2).map((t) => t.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('is the identity for the first page', () => {
    expect(appendTenders([], page1)).toBe(page1)
  })

  it('returns the same array when the page is empty, so React re-renders nothing', () => {
    expect(appendTenders(page1, [])).toBe(page1)
    expect(appendTenders(page1, [card('a')])).toBe(page1)
  })

  it('never duplicates a tender the sweep moved across the cursor', () => {
    const overlapping = [card('b'), card('c')]
    expect(appendTenders(page1, overlapping).map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })

  it('does not mutate the page it was given', () => {
    const current = [...page1]
    appendTenders(current, page2)
    expect(current).toHaveLength(2)
  })
})
