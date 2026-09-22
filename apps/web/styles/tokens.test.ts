import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Every `text-`, `bg-` and `border-` utility must name a token that exists.
 *
 * Tailwind v4 drops an unknown utility **silently** — no build error, no lint
 * warning, no failing test. `legal-page.tsx` shipped `bg-canvas` and
 * `text-title`, neither of which is in `tokens.css`, and both reached
 * production on `/termos` and `/privacidade`: the background looked right only
 * because it inherited the body's ivory, and the `h1` rendered at the browser
 * default size on the two pages the law requires us to publish.
 *
 * Nothing in the toolchain could have caught it, which is why this is a test
 * and not a convention.
 */

const WEB = fileURLToPath(new URL('..', import.meta.url))
const TOKENS = readFileSync(join(WEB, 'styles/tokens.css'), 'utf8')

/** `--color-ink: …` → `ink`. Same for `--text-*`. */
function names(prefix: string): Set<string> {
  return new Set(
    [...TOKENS.matchAll(new RegExp(`--${prefix}-([a-z0-9-]+)\\s*:`, 'g'))].map((m) => m[1]),
  )
}

const colors = names('color')
const sizes = names('text')

/**
 * Tailwind's own utilities, which are not tokens and are legitimate.
 * Deliberately short: anything else has to be a token or a typo.
 */
const BUILT_IN = new Set([
  'base', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl',
  'left', 'center', 'right', 'justify', 'start', 'end', 'wrap', 'nowrap',
  'balance', 'pretty', 'ellipsis', 'clip', 'transparent', 'current', 'inherit',
  'white', 'black', 'none', 'solid', 'dashed', 'dotted', 'collapse', 'separate',
])

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(path))
    else if (/\.tsx?$/.test(entry.name) && !entry.name.includes('.test.')) out.push(path)
  }
  return out
}

describe('every design token a component names actually exists', () => {
  const files = [...sources(join(WEB, 'app')), ...sources(join(WEB, 'components'))]

  it('finds the token file and the source tree', () => {
    expect(colors.size).toBeGreaterThan(10)
    expect(sizes.size).toBeGreaterThan(5)
    expect(files.length).toBeGreaterThan(20)
  })

  it.each([
    ['text', sizes, colors],
    ['bg', colors, null],
    ['border', colors, null],
  ] as const)('%s-* names a real token', (prefix, primary, secondary) => {
    const unknown: string[] = []
    // Skips arbitrary values (`text-[13px]`) and opacity suffixes (`bg-ink/40`).
    //
    // `border-t`, `border-b`, `border-x` … are Tailwind's own side utilities and
    // carry no token. `border-t-blue` is a side *plus* a token, so the side is
    // stripped before the lookup — otherwise the check reads `t-blue`, finds no
    // such colour, and reports a false positive on correct code.
    const SIDES = /^([trblxyse])(?:-|$)/
    const pattern = new RegExp(`\\b${prefix}-([a-z][a-z0-9-]*)\\b`, 'g')
    for (const file of files) {
      for (const [, token] of readFileSync(file, 'utf8').matchAll(pattern)) {
        const bare = prefix === 'border' ? token.replace(SIDES, '') : token
        // `border-2`, `border-t-2` — a width, not a token.
        if (bare === '' || /^\d+$/.test(bare) || BUILT_IN.has(bare)) continue
        if (primary.has(bare) || secondary?.has(bare)) continue
        unknown.push(`${file.slice(WEB.length)}: ${prefix}-${token}`)
      }
    }
    expect(unknown).toEqual([])
  })
})
