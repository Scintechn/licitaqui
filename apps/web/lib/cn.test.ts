import { describe, expect, it } from 'vitest'
import { cn } from './cn'

describe('cn', () => {
  it('joins truthy class names with a single space', () => {
    expect(cn('a', 'b', 'c')).toBe('a b c')
  })

  it('drops undefined, null, false and empty strings', () => {
    expect(cn('a', undefined, null, false, '', '   ', 'b')).toBe('a b')
  })

  it('keeps a literal zero, which is a valid class name', () => {
    expect(cn('a', 0)).toBe('a 0')
  })

  it('trims each value so conditionals cannot leave double spaces', () => {
    expect(cn('  a  ', 'b ')).toBe('a b')
  })

  it('returns an empty string when nothing survives', () => {
    expect(cn(false, undefined)).toBe('')
  })
})
