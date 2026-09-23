import { defineConfig, devices } from '@playwright/test'

/**
 * The persona journeys (`e2e/`) — Playwright, not Vitest and not Gherkin.
 *
 * ## What these are for
 *
 * Every serious defect of the last two days lived in a **seam between
 * screens**: a link that dropped the search (#68), a screen that never learned
 * a job had finished (#68 again), a value that was right in the database and
 * wrong on the card (#72). A component test cannot see a seam — it renders one
 * side of it. These tests walk the whole path, in a real browser, as a person:
 * Dona Marta arrives from a link and comes back to the list she left; Carla
 * looks at two clients in one afternoon.
 *
 * A failing test here should read like a sentence about a person — *"Dona
 * Marta cannot tell whether this edital is worth her time"* — which is why the
 * `test()` titles are written that way and the assertions are on what is on
 * screen rather than on props. The strings they match are Brazilian
 * Portuguese, because that is what is on the screen; everything around them is
 * English, like the rest of the repository (`CLAUDE.md`).
 *
 * ## Two projects, because they cost different things to run
 *
 * | project | what it needs | when it runs |
 * |---|---|---|
 * | `journeys` | a browser and this repo. **Nothing else** | always; safe on every PR |
 * | `accounts` | a real deployment, a real inbox, a real Telegram account | only when the env names them; otherwise each test skips with its reason |
 *
 * `journeys` is hermetic on purpose. **PNCP is unreliable** — `pncp-itens`
 * opened five times on the morning of 2026-09-23 — and a suite that goes red
 * because PNCP has weather is worse than no suite at all on launch day: nobody
 * can tell a regression from the forecast, and a suite that cries wolf is
 * ignored exactly when it matters. So every `/api/**` answer these tests see
 * comes from `e2e/fixtures/radar-api.ts`, which speaks the envelope of
 * `lib/radar/contract.ts` and is type-checked against it. What is asserted is
 * **our** behaviour: what the screens do with an answer, not whether PNCP
 * gave one.
 *
 * The cost of that choice, stated plainly: these tests cannot catch a route
 * that stops answering, or a query that returns the wrong rows. Those are
 * covered by the `*.db.test.ts` suites, which do talk to Postgres. The seam is
 * what is covered here, and the seam is where the bugs were.
 *
 * ## The server
 *
 * `next build` + `next start`, not `next dev`: dev re-invokes effects under
 * React strict mode, and two of these journeys count requests. Set
 * `E2E_BASE_URL` to point the suite at a deployment instead — that is how the
 * `accounts` project is meant to be run.
 */

const PORT = Number(process.env.E2E_PORT ?? 3100)
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: './e2e',
  // `*.spec.ts`, never `*.test.ts`: `vitest.config.mts` collects `**/*.test.ts`
  // and `pnpm test` must stay a fast, browserless unit run.
  testMatch: '**/*.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  /**
   * One retry in CI, zero locally — and a retry here is **instrumentation, not
   * treatment**: a test that passes only on the second attempt is reported by
   * Playwright as flaky, which is the signal we want, and it does not count as
   * green for the purposes of merging. A journey that needs a retry to pass
   * gets a root cause, not a second chance.
   */
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }], ['list']]
    : [['list'], ['html', { open: 'never' }]],
  timeout: 45_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL,
    /**
     * Everything needed to debug a red run from the artifact alone. "Works on
     * my machine" is a tooling failure, not an excuse.
     */
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  },

  projects: [
    {
      name: 'journeys',
      testDir: './e2e/journeys',
      use: {
        ...devices['Desktop Chrome'],
        // The board is drawn at 390px and the people in these journeys are on
        // phones. Chromium rather than a touch device so `click()` stays a
        // click; the width is what changes the layout.
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: 'accounts',
      testDir: './e2e/accounts',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  /**
   * No `DATABASE_URL`: the journeys never let a request reach a route handler,
   * and the Landing is written to drop its two server-read numbers rather than
   * fail when the database is unreachable (`lib/founders/seat-count.ts`).
   *
   * The `AUTH_*` values below are **placeholders, not secrets** — they are
   * here so `/conta/criar` renders the state a configured deployment renders
   * (both ways in, per U2) instead of the "login não configurado" degradation.
   * No sign-in is ever completed against them; nothing in this suite clicks
   * through to Google.
   */
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: `pnpm run build && pnpm exec next start --port ${PORT}`,
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 300_000,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          NEXT_TELEMETRY_DISABLED: '1',
          AUTH_SECRET: 'e2e-placeholder-not-a-secret',
          AUTH_GOOGLE_ID: 'e2e-placeholder.apps.googleusercontent.com',
          AUTH_GOOGLE_SECRET: 'e2e-placeholder-not-a-secret',
          AUTH_MAGIC_LINK: '1',
          RESEND_API_KEY: 're_e2e_placeholder',
          AUTH_EMAIL_FROM: 'noreply@example.invalid',
        },
      },
})
