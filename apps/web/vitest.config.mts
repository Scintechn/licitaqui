import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
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
