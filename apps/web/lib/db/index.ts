import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema'

export * from './schema'

export type Database = NodePgDatabase<typeof schema>
/** The handle `db().transaction(async (tx) => ...)` hands its callback. */
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
/** Anything that can run a statement: the pool, or an open transaction. */
export type Executor = Database | Transaction

/**
 * The single Postgres pool for the web app (spec §5: Drizzle ORM + `pg`).
 *
 * Built lazily on first query, never at import time: route modules are imported
 * during `next build`, where `DATABASE_URL` is not set and nothing may connect.
 * The pool is cached on `globalThis` so `next dev`'s hot reload does not leak a
 * new pool per edit.
 *
 * Connection string: `DATABASE_URL` — the **pooled** Neon endpoint (PgBouncer,
 * transaction mode), per spec §5. Everything this module does is therefore
 * transaction-scoped; nothing relies on session state surviving between
 * statements, which PgBouncer would not preserve.
 */

const POOL = Symbol.for('licitaqui.pg.pool')
const DB = Symbol.for('licitaqui.pg.db')

type Holder = {
  [POOL]?: Pool
  [DB]?: Database
}

const holder = globalThis as unknown as Holder

/** An integer from the environment, or the default when unset or unparseable. */
function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

function connectionString(): string {
  const url = process.env.DATABASE_URL
  if (!url) {
    throw new Error('DATABASE_URL is not set')
  }
  return url
}

export function pool(): Pool {
  if (!holder[POOL]) {
    holder[POOL] = new Pool({
      connectionString: connectionString(),
      // Serverless functions open many connections; Neon's PgBouncer is the
      // real pool, so each instance keeps only a handful.
      max: envInt('DATABASE_POOL_MAX', 10),
      idleTimeoutMillis: 10_000,
      // Spec §7.2 timeout budget: connect 15 s, query 30 s. Both count the
      // wait for a pooled connection and the wait on a lock, so the concurrency
      // test — which queues 60 transactions behind one advisory lock over a
      // ~200 ms round trip — raises them rather than calling a slow network a
      // failed signup.
      connectionTimeoutMillis: envInt('DATABASE_CONNECT_TIMEOUT_MS', 15_000),
      statement_timeout: envInt('DATABASE_QUERY_TIMEOUT_MS', 30_000),
      query_timeout: envInt('DATABASE_QUERY_TIMEOUT_MS', 30_000),
    })
    // Without a listener, an idle-client error would crash the process.
    holder[POOL].on('error', (error) => {
      console.error('pg pool error', error.message)
    })
  }
  return holder[POOL]
}

export function db(): Database {
  if (!holder[DB]) {
    holder[DB] = drizzle(pool(), { schema })
  }
  return holder[DB]
}

/** Closes the pool. Tests only — a serverless function never calls this. */
export async function closeDb(): Promise<void> {
  const existing = holder[POOL]
  holder[POOL] = undefined
  holder[DB] = undefined
  if (existing) await existing.end()
}
