import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vitest/config'

/**
 * A static image import, resolved the way Next resolves it.
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
 * copy into the component a fact the file already states, and leave it silently
 * wrong the day the image is regenerated at another size.
 *
 * So the runner reads the size out of the file, as Next does. PNG only, and it
 * throws on anything else rather than guessing: a wrong intrinsic ratio is
 * exactly the defect the static import exists to prevent, and a test that
 * quietly invented one would be worse than no test.
 */
function staticImages(): Plugin {
  const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg)$/

  return {
    name: 'next-static-images',
    enforce: 'pre',
    load(id) {
      const file = id.split('?')[0]
      if (!IMAGE.test(file)) return null
      if (!file.endsWith('.png')) {
        throw new Error(
          `vitest: static import of ${file} — only PNG dimensions are read here. ` +
            'Teach `staticImages()` in vitest.config.mts to read this format.',
        )
      }

      const bytes = readFileSync(file)
      // PNG: an 8-byte signature, then the IHDR chunk — 4 bytes of length, 4 of
      // type, then width and height as big-endian 32-bit integers.
      const signature = '\x89PNG\r\n\x1a\n'
      if (bytes.subarray(0, 8).toString('binary') !== signature) {
        throw new Error(`vitest: ${file} is not a PNG`)
      }
      const width = bytes.readUInt32BE(16)
      const height = bytes.readUInt32BE(20)

      return `export default ${JSON.stringify({ src: file, width, height })}`
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
