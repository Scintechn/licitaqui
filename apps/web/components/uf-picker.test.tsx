import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { messages } from '@/lib/messages'
import { UfPicker } from './uf-picker'

/**
 * The first render — what a reader sees before React hydrates, and what the
 * form posts if it never does. Ticking, the region shortcuts and the
 * indeterminate state are effects and handlers, which `environment: 'node'`
 * never runs (CLAUDE.md §4c): those are `e2e/journeys/radar-ufs.spec.ts`.
 */
function render(defaultValue: string[] = []) {
  return renderToStaticMarkup(<UfPicker id="uf" label="UF onde você entrega" defaultValue={defaultValue} />)
}

const ticked = (html: string) =>
  [...html.matchAll(/<input[^>]*name="uf"[^>]*value="([A-Z]{2})"[^>]*>/g)]
    .filter((match) => / checked=""/.test(match[0]))
    .map((match) => match[1])
    .sort()

describe('UfPicker, first render', () => {
  it('nothing ticked reads Todo o Brasil, with that box ticked', () => {
    const out = render()
    expect(out).toContain(`id="uf-value" class="truncate">${messages.radar.ufAll}<`)
    expect(ticked(out)).toEqual([])
  })

  it('ticks the UFs it was given and says so in the button', () => {
    const out = render(['SP', 'RJ', 'MG'])
    expect(ticked(out)).toEqual(['MG', 'RJ', 'SP'])
    expect(out).toContain('id="uf-value" class="truncate">MG, RJ e SP<')
  })

  it('a whole region ticks the region box too', () => {
    const out = render(['PR', 'SC', 'RS'])
    expect(out).toContain('>Sul<')
    expect(out).toMatch(/<input[^>]*type="checkbox"[^>]*checked=""[^>]*\/?>\s*<span id="uf-region-S">Sul</)
  })

  it('posts `uf` from the state boxes only — the shortcuts carry no name', () => {
    const out = render()
    expect(out.match(/name="uf"/g)).toHaveLength(27)
    expect(out.match(/type="checkbox"/g)).toHaveLength(27 + 5 + 1)
  })
})
