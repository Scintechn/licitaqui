/**
 * The pure, browser-safe half of the founders module: seat arithmetic and the
 * labels the offer page renders. `@/lib/founders` must stay importable from a
 * Client Component, so the signup transaction (`./signup`) and its Zod input
 * (`./input`) are **not** re-exported here — they pull in Drizzle and `pg`, and
 * belong to the route handlers alone.
 */
export * from './seats'
