import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * **Every file this build reads must be a file that starts this build.**
 *
 * `ci-web.yml` triggered on `apps/web/**` and four root manifests. But the web
 * app reads five things from outside that tree, and two of them it *compiles
 * in*: `lib/product.ts` imports `docs/product.json`, and `lib/legal/document.ts`
 * reads `docs/legal/` at build time to generate `/termos` and `/privacidade`.
 *
 * So a pull request changing only `docs/product.json` — the one file a price is
 * supposed to change in, the whole point of Layer 1 — ran **no workflow at
 * all**. `product.test.ts` was written to fail loudly when a price change
 * leaves any of thirty other sites stale, and it could not be reached by the
 * only edit capable of breaking it. The guard was correct and unreachable,
 * which is the shape CLAUDE.md §4b names: the test exercised the unit, not the
 * path.
 *
 * Listing the paths in the workflow fixes today. This fixes tomorrow: it
 * derives the dependency set from the source rather than restating it, so a new
 * `docs/` import fails here until the workflow learns about it. It is
 * deliberately not a list of expected entries compared against itself — that
 * would pass forever and prove nothing.
 */

const root = join(import.meta.dirname, '..', '..', '..')
const webRoot = join(root, 'apps', 'web')
const workflow = readFileSync(join(root, '.github', 'workflows', 'ci-web.yml'), 'utf8')

/** Directories under `apps/web` that hold no source we need to scan. */
const SKIP = new Set(['node_modules', '.next', 'coverage', 'test-results', 'playwright-report'])

/**
 * **This file excludes itself, and that is the point.**
 *
 * It names `docs/legal/**` and the other four paths as string literals, so
 * scanning itself makes it its own dependency — and the assertions below then
 * confirm that its own text contains the text it was written to contain. The
 * first version did exactly that: blinding the scanner completely left all
 * eight tests green, because every path it claimed to detect was being read
 * back out of this file.
 */
const SELF = 'ci-triggers.test.ts'

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP.has(entry.name) || entry.name === SELF) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(full))
    else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) out.push(full)
  }
  return out
}

/** Comments out, so a prose mention of a path is not read as a dependency. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[^\n]*?\/\/.*$/gm, ' ')
}

/**
 * The repository-root paths a file depends on, as trigger entries.
 *
 * Two spellings reach `docs/`, and both are in use:
 *
 *   `from '../../../docs/product.json'`        — a bundled import
 *   `join(root, 'docs', 'CLAIMS.md')`          — a read at run or test time
 *
 * Only those two count. The first version of this matched any quoted string
 * containing `docs/`, and immediately "found" a dependency on
 * `docs/design/wireframes/DesignSystem.dc.html` that does not exist: the path
 * appears in a docstring on `app/dev/components/page.tsx:33` and as rendered
 * text inside a `<code>` element on line 491. A guard that cannot tell a
 * reference from a read would be a guard nobody could leave green, so it would
 * be switched off — and the useful signal goes with it.
 *
 * A directory becomes `docs/<dir>/**` because the dependency is on its
 * contents, not on the name: adding a clause to `docs/legal/termos-de-uso.md`
 * changes what `/termos` renders.
 */
function dependencies(text: string): Set<string> {
  const found = new Set<string>()
  const source = code(text)

  // A module specifier — the import is compiled into the bundle.
  const specifiers = [
    ...source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
    ...source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g),
  ]
  for (const [, specifier] of specifiers) {
    const at = specifier.indexOf('docs/')
    if (at !== -1) found.add(specifier.slice(at))
  }

  // A path assembled segment by segment: `join(root, 'docs', 'CLAIMS.md')`.
  //
  // Matched on the adjacent quoted tokens rather than by bounding the call.
  // Bounding it was the first attempt and it was worse than useless: the
  // argument pattern `([^)]*)` stops at the first `)`, so
  // `path.join(process.cwd(), '..', '..', 'docs', 'legal')` yielded the
  // arguments `"process.cwd("` and the legal dependency was never seen. The
  // suite stayed green because the workflow already listed `docs/legal/**` —
  // delete that line and nothing would have failed. `'docs', 'x'` as adjacent
  // quoted tokens is unambiguous enough on comment-stripped source.
  for (const [, segment] of source.matchAll(/['"]docs['"]\s*,\s*['"]([^'"]+)['"]/g)) {
    // A segment with no extension is a directory, so depend on its contents.
    found.add(segment.includes('.') ? `docs/${segment}` : `docs/${segment}/**`)
  }

  // A whole relative path in one string: `readFileSync('docs/x')`. The quote
  // must be followed immediately by `docs/` — matching it anywhere inside the
  // string is what produced the DesignSystem false positive.
  for (const [, path] of source.matchAll(/['"]docs\/([^'"]+)['"]/g)) found.add(`docs/${path}`)

  if (/['"]CLAUDE\.md['"]/.test(source)) found.add('CLAUDE.md')

  return found
}

/** The `paths:` entries of one `on:` trigger block, in order. */
function triggerPaths(yaml: string, trigger: 'pull_request' | 'push'): string[] {
  const block = yaml.slice(yaml.indexOf(`${trigger}:`))
  const paths = block.slice(block.indexOf('paths:'))
  const out: string[] = []
  for (const line of paths.split('\n').slice(1)) {
    const entry = /^\s+-\s+'([^']+)'/.exec(line)
    if (entry) out.push(entry[1])
    else if (/^\s*#/.test(line) || !line.trim()) continue
    else break
  }
  return out
}

/** Whether `entry` (a trigger glob) covers `dependency`. */
function covers(entry: string, dependency: string): boolean {
  if (entry === dependency) return true
  if (entry.endsWith('/**')) return dependency.startsWith(entry.slice(0, -2))
  return false
}

const declared = {
  pull_request: triggerPaths(workflow, 'pull_request'),
  push: triggerPaths(workflow, 'push'),
}

const required = new Map<string, string[]>()
for (const file of sources(webRoot)) {
  for (const dependency of dependencies(readFileSync(file, 'utf8'))) {
    const relative = file.slice(root.length + 1)
    required.set(dependency, [...(required.get(dependency) ?? []), relative])
  }
}

describe('ci-web triggers on everything the web build reads', () => {
  // **Pin what the scanner must see.** Everything below asks "is each found
  // dependency covered?", which a scanner finding nothing answers perfectly.
  // That is not hypothetical: the first version of this file missed
  // `docs/legal/**` and passed, because the workflow happened to list it
  // already. These name the five reads that exist today, so a scanner that
  // stops seeing one fails here instead of going quiet.
  it.each([
    ['docs/product.json', 'lib/product.ts imports it into the bundle'],
    ['docs/legal/**', 'lib/legal/document.ts generates /termos and /privacidade from it'],
    ['docs/CLAIMS.md', 'lib/claims.test.ts reads it'],
    ['docs/DEVELOPMENT_PLAN.md', 'lib/claims.test.ts reads it'],
    ['CLAUDE.md', 'lib/claims.test.ts reads it'],
  ])('detects the dependency on %s', (dependency, why) => {
    expect([...required.keys()], `${dependency} is read — ${why}`).toContain(dependency)
  })

  it.each(['pull_request', 'push'] as const)('%s covers every docs/ dependency', (trigger) => {
    const entries = declared[trigger]
    expect(entries.length).toBeGreaterThan(0)

    for (const [dependency, readers] of required) {
      const covered = entries.some((entry) => covers(entry, dependency))
      expect(
        covered,
        `ci-web.yml's ${trigger} paths do not include ${dependency}, read by ${readers.join(', ')}.` +
          ` A change to it would merge without this workflow running.`,
      ).toBe(true)
    }
  })

  it('declares the same paths for pull_request and push', () => {
    // Added to one list and not the other is the likely way this regresses:
    // the PR goes green because the workflow ran, and the merge publishes
    // without it. Worse than never adding it, because the PR looked checked.
    expect(declared.push).toEqual(declared.pull_request)
  })
})
