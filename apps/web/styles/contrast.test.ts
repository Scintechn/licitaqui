import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every colour pair the product actually paints text in must clear WCAG AA.
 *
 * `--color-attention` shipped at `#a15c00` with the comment "4.9:1 on ivory".
 * That was true and it was the wrong measurement: the `VERIFICAR` badge, the
 * quota chip and the visitor banner all paint attention on
 * `--color-attention-soft`, its own fill, where it measured **4.42:1** — under
 * the 4.5 AA needs for normal text, on 11px uppercase mono.
 *
 * The lesson is the reason this file exists: a colour is legible against the
 * surface it is *on*, not against the page behind that surface. So the pairs
 * below are the pairs that ship, taken from the components rather than from the
 * palette, and a soft fill is checked against its own ink.
 *
 * AA, normal text, 4.5:1. Nothing here qualifies for the 3:1 large-text
 * exemption: the smallest of these is 11px and the largest is 15px.
 */

const TOKENS = readFileSync(
  join(fileURLToPath(new URL('.', import.meta.url)), 'tokens.css'),
  'utf8',
)

function token(name: string): string {
  const found = TOKENS.match(new RegExp(`--color-${name}\\s*:\\s*(#[0-9a-fA-F]{6})`))
  if (!found) throw new Error(`--color-${name} is not in tokens.css`)
  return found[1]
}

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(foreground: string, background: string): number {
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

const AA_NORMAL = 4.5

/** ink token, fill token, and where the pairing is rendered. */
const PAIRS: [string, string, string][] = [
  // The one this file was written for: Status kind="check", Tag tone="attention".
  ['attention', 'attention-soft', 'the VERIFICAR badge and the quota chip, 11px'],
  // B9's tender-status banner and the SUSPENSA/REVOGADA/ANULADA chip paint the
  // same pair. Listed separately because it is a different surface, and because
  // the first draft quieted the banner's source line with `opacity-90` — which
  // blends this 5.30:1 down to 4.37:1 and fails. Opacity over a soft fill is
  // not a free way to make text secondary.
  ['attention', 'attention-soft', 'the tender-status banner and its status chip'],
  ['attention', 'ivory', 'admin counters and the screening page marker'],
  ['attention', 'surface', 'a Tag tone="attention" on a card'],

  // Measured at the same time and deliberately left alone: both pass with no
  // headroom, so lightening either one breaks them.
  ['success', 'success-soft', 'a satisfied finding on the screening screen'],
  ['muted', 'fill-muted', 'the keyword badge and muted tags'],
  // The Itens tab's total sits in Archivo on the muted fill, with its label
  // beside it in `muted` — the pair above. Both are pinned rather than one.
  ['ink', 'fill-muted', 'the sum of the items on the Opportunity screen'],
  ['muted', 'ivory', 'every secondary line in the app'],
  ['muted', 'surface', 'secondary lines inside a card'],

  ['blue', 'blue-soft', 'the COMPATÍVEL badge and the price example block'],
  ['blue', 'ivory', 'links and the primary action as text'],
  ['blue', 'surface', 'the active item chip on the price screen'],

  ['error', 'error-soft', 'a blocking finding on the screening screen'],

  ['ink', 'ivory', 'body copy'],
  ['ink', 'surface', 'body copy on a card'],
  ['ink-soft', 'ivory', 'public-page body copy'],
  ['on-ink', 'ink', 'body copy on the graphite panel'],
  ['on-ink-muted', 'ink', 'secondary copy on the graphite panel'],
]

describe('WCAG AA · every ink/fill pair the product paints text in', () => {
  it.each(PAIRS)('%s on %s clears 4.5:1 (%s)', (ink, fill) => {
    const ratio = contrast(token(ink), token(fill))
    expect(
      ratio,
      `--color-${ink} (${token(ink)}) on --color-${fill} (${token(fill)}) is ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(AA_NORMAL)
  })

  it('records what attention actually measures, so a change has to be deliberate', () => {
    // The old #a15c00 was 4.42:1 here. If this number moves, somebody changed
    // the token: check the badge at 320px before accepting it.
    expect(contrast(token('attention'), token('attention-soft'))).toBeCloseTo(5.3, 1)
  })

  it('checks the ratio maths against a pair with a known answer', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
  })
})
