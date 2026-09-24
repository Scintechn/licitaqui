import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vitest/config'

/**
 * A static PNG import, resolved the way Next resolves it.
 *
 * `next/image` takes either a string `src` **with** an explicit width and
 * height, or a static import that carries its own intrinsic size. The second
 * is what `/fundadores` uses for the hero shot, and it is the reason the page
 * reserves the right box before the bytes arrive.
 *
 * Vite resolves `import x from './a.png'` to a URL string, so under the test
 * runner that same component would be a string `src` with no dimensions and
 * `next/image` throws — which is a fact about this runner, not about the page.
 * Hand-typing `width={1600} height={1066}` into the JSX to get around it would
 * copy into the component a fact the file already states, and leave it
 * silently wrong the day the image is regenerated at another size.
 *
 * So the runner reads the size out of the file, as Next does, and shapes `src`
 * the way Next shapes it — `/_next/static/media/<name>.<hash>.png`. That
 * matters: the default image loader percent-encodes whatever string it is
 * handed, so an absolute filesystem path here would still produce a plausible
 * `/_next/image?url=…` and let a test assert a URL that would 404 in
 * production.
 *
 * **PNG only, and it declines rather than guesses.** Any other extension is
 * left to Vite's own resolution, exactly as before this plugin existed: a
 * shared config should not hard-fail somebody else's suite for importing an
 * SVG. What it costs is that a static `.jpg` into `next/image` would fail with
 * Next's "missing required width" rather than a message naming this file —
 * the trade is deliberate, and the fix is to teach this function that format.
 *
 * No `blurDataURL`: nothing on the page uses `placeholder="blur"`, and a fake
 * one would be a claim about bytes this plugin has not produced.
 */
function staticImages(): Plugin {
  return {
    name: 'next-static-png',
    enforce: 'pre',
    load(id) {
      const file = id.split('?')[0]
      if (!/\.png$/i.test(file)) return null

      const bytes = readFileSync(file)
      // PNG: an 8-byte signature, then the IHDR chunk — 4 bytes of length, 4 of
      // type, then width and height as big-endian 32-bit integers.
      const signature = '\x89PNG\r\n\x1a\n'
      if (bytes.subarray(0, 8).toString('binary') !== signature) {
        throw new Error(`vitest: ${file} has a .png name and is not a PNG`)
      }

      const name = basename(file, '.png')
      const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
      return `export default ${JSON.stringify({
        src: `/_next/static/media/${name}.${hash}.png`,
        width: bytes.readUInt32BE(16),
        height: bytes.readUInt32BE(20),
      })}`
    },
  }
}

export default defineConfig({
  plugins: [staticImages()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./', import.meta.url)) },
  },
  test: {
    // Components are rendered with `react-dom/server`, which needs no DOM: the
    // markup assertions below run in plain Node, so we keep jsdom out of the tree.
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    // `e2e/` is Playwright's: it needs a browser and a running server, and
    // `pnpm test` has to stay a fast, browserless run that CI's existing job
    // can keep calling unchanged. The suffix there is `*.spec.ts`, so the
    // `include` above already misses it — this is the second guard, because
    // one helper named `*.test.ts` in that folder would silently drag a
    // browser into the unit suite.
    exclude: ['node_modules', '.next', 'e2e/**'],
  },
})
