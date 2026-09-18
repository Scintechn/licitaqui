# db/

Versioned SQL migrations and the development seed. This directory is the single
source of truth for the schema (spec §4); the worker uses plain SQL and the web
app's Drizzle schema must follow what is here, not the other way round.

## Commands

```bash
pnpm db:migrate   # apply every unapplied file in db/migrations, in order
pnpm db:seed      # load db/seed/fixtures into the database (dev only)
```

Both resolve their connection string in this priority order:

1. `MIGRATOR_DATABASE_URL` from the environment
2. `MIGRATOR_DATABASE_URL` from `.env.neon-roles.local`, then `.env.local`
3. `DATABASE_URL_UNPOOLED` from the same places

Always a **direct, non-pooled** connection: DDL must not go through PgBouncer.
The `migrator` role owns DDL; `app` is DML-only (spec §5.1), so pointing these
scripts at the `app` credential fails with `permission denied for schema public`.
That error means the wrong role, not a broken migration.

## Migrations are immutable

`migrate.py` records each applied file's `sha256` in `schema_migrations` and
**refuses to run if an already-applied file changed**. To alter the schema, add
a new numbered file. Never edit one that has shipped.

Each file runs in its own transaction, so a failure leaves earlier migrations
applied and the failing one fully rolled back.

## Bootstrapping a brand-new database

`0001_initial.sql` starts with `create extension if not exists unaccent / pg_trgm
/ citext`. On Neon, **the `migrator` role cannot create extensions in a database
it does not own** — that needs CREATE on the database itself:

```
ERROR: permission denied to create extension "unaccent"
HINT:  Must have CREATE privilege on current database to create this extension.
```

This does **not** affect normal operation:

| Target | Works? | Why |
|---|---|---|
| `neondb` (production `main`) | ✅ | Extensions were created by the owner during task A2 |
| A Neon **branch** (preview, `dev`) | ✅ | Branches copy the parent database, extensions included |
| A brand-new **database** | ❌ | Its `public` schema and extensions start empty |

So before the first `pnpm db:migrate` against a newly created database, connect
**as the database owner** and run once:

```sql
create extension if not exists unaccent;
create extension if not exists pg_trgm;
create extension if not exists citext;

grant connect on database <db> to migrator, app;
grant usage, create on schema public to migrator;
grant usage on schema public to app;
grant migrator to current_user;
alter default privileges for role migrator in schema public
  grant select, insert, update, delete on tables to app;
alter default privileges for role migrator in schema public
  grant usage, select on sequences to app;
```

After that the migration's `if not exists` guards make the extension statements
no-ops and `migrator` can proceed.

## Seed data

`db/seed/fixtures/pncp/` holds 20 real PNCP tender payloads (940 items, 14
states) captured by the POCs and committed deliberately, so local dev, tests and
previews never depend on the read-only knowledge-base folder or on PNCP being
reachable.

The seed is **development, test and preview only** — production data comes from
the collector. `pnpm db:seed` has never been run against `neondb`, and should not
be.

Both scripts are idempotent: `db:migrate` skips applied files, `db:seed` upserts
on natural keys. Re-running either changes nothing.

## The CNAE → segment map

`db/reference/cnae_segments.csv` is the reviewed artefact behind
`0003_cnae_segments.sql` (task B6, gap G6). The migration's seed block is
generated from it; `db/cnae_reference.py` does the rendering and
`worker/tests/test_cnae_segments.py` fails if the two drift apart. Edit the CSV,
never the generated block, and render into a **new** numbered migration once
0003 has shipped — see `db/reference/README.md`.
