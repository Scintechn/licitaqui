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

/**
 * WCAG 1.4.11 non-text contrast: a boundary that is the only thing identifying
 * a control needs 3:1 against its adjacent ground.
 */
const AA_NON_TEXT = 3

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

  /*
   * `/fundadores` alternates its section grounds between Ivory and
   * `fill-muted` from 2026-09-24, so every tier of public-page text now gets
   * painted on the muted fill as well as on Ivory. `muted`/`fill-muted` and
   * `ink`/`fill-muted` were already here for the in-app chips; these three are
   * the public page's own tiers, which nothing had checked on that fill.
   */
  ['ink-soft', 'fill-muted', 'public-page body copy on an alternating section'],
  ['blue', 'fill-muted', 'the section eyebrow on an alternating section'],
  ['muted', 'fill-muted', 'the price chain’s quiet values on an alternating section'],
  ['on-ink', 'ink', 'body copy on the graphite panel'],
  ['on-ink-muted', 'ink', 'secondary copy on the graphite panel'],
]

/**
 * The same idea one rung down, for borders rather than ink.
 *
 * `PAIRS` above covers only text, and that gap is exactly how a 1.55:1 field
 * border shipped: `--color-line-strong` (#d6cfc5) drew every input, select and
 * secondary button, and nothing in CI looked at it because no rule here knew
 * borders existed. 1.4.11 asks 3:1 of a boundary that is the only thing
 * identifying a control — and on a form field the boundary is all there is.
 *
 * So: border token, the ground it is drawn on, and where. Only boundaries that
 * *carry meaning* belong here. A chip or card edge drawn in `line-strong` is
 * decoration beside a label that is already legible, and 1.4.11 does not ask
 * 3:1 of decoration — which is why `line-strong` stayed where it was instead
 * of being darkened under every chip in the product.
 */
const BORDER_PAIRS: [string, string, string][] = [
  ['field-line', 'surface', 'Field, Select and the secondary Button on a card'],
  ['field-line', 'ivory', 'the same controls on the page background'],
  ['field-line', 'fill-muted', "LockedBlock's dashed border on the muted fill"],
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

  it('records what the blue eyebrow measures on ivory, so a change has to be deliberate', () => {
    // `/fundadores`' section eyebrows went from `tone="muted"` to
    // `tone="accent"` on 2026-09-24 (Sci). They are 12px `caption`, normal
    // text, so they need the full 4.5 — no large-text exemption. Recorded
    // rather than merely bounded: if somebody lightens `--color-blue` for the
    // buttons, this says what it costs the eyebrows.
    expect(contrast(token('blue'), token('ivory'))).toBeCloseTo(5.78, 2)
  })

  it('checks the ratio maths against a pair with a known answer', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
  })
})

describe('WCAG 1.4.11 · every border that is the only marker of a control', () => {
  it.each(BORDER_PAIRS)('%s on %s clears 3:1 (%s)', (line, fill) => {
    const ratio = contrast(token(line), token(fill))
    expect(
      ratio,
      `--color-${line} (${token(line)}) on --color-${fill} (${token(fill)}) is ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(AA_NON_TEXT)
  })

  it('records what the old field border measured, so this cannot come back', () => {
    // These three are the audit's numbers for `--color-line-strong`, the token
    // that drew every form field until it was measured. Nothing should paint a
    // control boundary in it again; if something does, these are what it is
    // worth.
    expect(contrast(token('line-strong'), token('surface'))).toBeCloseTo(1.55, 2)
    expect(contrast(token('line-strong'), token('ivory'))).toBeCloseTo(1.45, 2)
    expect(contrast(token('line-strong'), token('fill-muted'))).toBeCloseTo(1.34, 2)
  })

  it('leaves the field border headroom over the 3:1 floor', () => {
    // 3.41:1 on the muted fill is the tightest of the three. It passes, and it
    // passes by little: lightening `field-line` breaks 1.4.11 on LockedBlock
    // first.
    expect(contrast(token('field-line'), token('fill-muted'))).toBeCloseTo(3.41, 2)
  })
})
