import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GateCards } from '@/app/admin/gate-cards'
import type { Gate } from './gates'

/**
 * `app/admin/gate-cards.tsx` had no test of any kind until 2026-10-09, which
 * is **B40**'s shape on the one screen whose job is to warn. This file is not
 * that card — it covers the one behaviour changed here: a gate with no target.
 *
 * `environment: 'node'` (§4c), so these are `renderToStaticMarkup` strings.
 * They can say what the markup contains and nothing about how it looks.
 */

/**
 * Text, not markup. `toContain('meta')` on the raw HTML matches the Tailwind
 * class `text-meta`, so the first version of this file passed and failed for
 * reasons that had nothing to do with the target label.
 */
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()

const gate = (overrides: Partial<Gate> = {}): Gate => ({
  key: 'founders_signed_up',
  label: 'Fundadores inscritos',
  target: 150,
  unit: 'count',
  source: 'Linhas em founders_list.',
  reading: { state: 'counted', value: 1 },
  ...overrides,
})

describe('GateCards — a gate with no target', () => {
  const render = (g: Gate) =>
    text(renderToStaticMarkup(<GateCards gates={[g]} gateDate="06/11/2026" />))

  it('prints the target when there is one', () => {
    expect(render(gate())).toContain('meta ≥ 150')
  })

  it('prints no target at all when there is none', () => {
    // Not "meta ≥ 0". `target: null` means nobody set a bar, and formatting
    // null as zero draws a bar that is always met — the D4d mistake.
    const out = render(gate({ key: 'cnpj_search_count', target: null, label: 'Buscas por CNPJ' }))
    expect(out).toContain('Buscas por CNPJ')
    expect(out).not.toContain('meta ≥')
    expect(out).not.toContain('≥')
  })

  it('does not badge an untargeted gate as met, however large the number', () => {
    // `gateMet` returns null, so the card must not accent or pass it. 9 000 is
    // far past every real target on this screen; none of that makes it "met".
    const none = render(
      gate({ key: 'cnpj_search_count', target: null, reading: { state: 'counted', value: 9000 } }),
    )
    const met = render(gate({ reading: { state: 'counted', value: 9000 } }))
    expect(met).toContain('batida')
    expect(none).not.toContain('batida')
    // And not 'em aberto' either: that claims a bar it does not have.
    expect(none).not.toContain('em aberto')
  })
})
