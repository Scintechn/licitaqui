#!/usr/bin/env python3
"""Apply db/migrations/*.sql in order, exactly once each.

Idempotent: applied files are recorded in schema_migrations and skipped on a
rerun. Each file runs in its own transaction, so a failure leaves earlier
migrations applied and the failing one fully rolled back.

Connection: MIGRATOR_DATABASE_URL (the DDL role), falling back to
DATABASE_URL_UNPOOLED. Migrations must use a direct, non-pooled connection.
Reads .env.neon-roles.local then .env.local when the variable is not already
in the environment.

**It says which database it is about to change, and refuses when that is not
the one the application reads** — card B50, and the afternoon that bought it.
On 2026-10-13 `/conta/favoritos` was 500ing with `column "birth_date" does not
exist`, this script was run, and it printed `0 applied, 15 already present`
while the page stayed broken. Two Neon branches: the dev server reads
`DATABASE_URL` → endpoint `ep-small-cake-ac4lizlb`, branch `staging`, 14
migrations; this script resolved `MIGRATOR_DATABASE_URL` → endpoint
`ep-flat-firefly-acai77cp`, branch `main`, 15. The priority order above is
*why* — it exists to stop migrations running as the DML-only `app` role, and
was written without a thought for the **database** on the other end of that
credential. So whenever the two disagree, this migrated the one nobody was
reading and reported success.

Pass ``--allow-other-database`` when that is deliberate, which is exactly what
migrating `staging` by hand is (see CLAUDE.md). ``--check`` applies nothing and
exits non-zero with the pending list, for a preflight or a dashboard.
"""

from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit

import psycopg

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = Path(__file__).resolve().parent / "migrations"
ENV_FILES = (".env.neon-roles.local", ".env.local")
VARS = ("MIGRATOR_DATABASE_URL", "DATABASE_URL_UNPOOLED")

#: Where the **application's** own connection string lives, for the comparison
#: in :func:`check_target`. `apps/web/.env.local` is the one `next dev` reads;
#: the root copy is included because the two have drifted apart before and the
#: one that matters is whichever names a different endpoint.
APP_ENV_FILES = (".env.local", "apps/web/.env.local")
APP_VAR = "DATABASE_URL"


def _from_file(path: Path, var: str) -> str | None:
    if not path.exists():
        return None
    for line in path.read_text().splitlines():
        line = line.strip()
        if line.startswith(f"{var}="):
            return line.split("=", 1)[1].strip().strip('"').strip("'") or None
    return None


def dsn() -> str:
    """Resolve the connection string, honouring VARS strictly by priority.

    MIGRATOR_DATABASE_URL must win wherever it is defined. Scanning files
    line-by-line instead would pick whichever variable appears first in the
    file, which silently hands migrations the DML-only `app` role.
    """
    for var in VARS:
        if os.environ.get(var):
            return os.environ[var]
        for fname in ENV_FILES:
            value = _from_file(ROOT / fname, var)
            if value:
                return value
    sys.exit(f"set one of {' or '.join(VARS)} (env, or {' / '.join(ENV_FILES)})")


def app_dsn() -> str | None:
    """The connection string the **application** uses, or ``None``.

    ``None`` is a legitimate answer and must not stop a migration: in CI there
    are no env files at all and only ``MIGRATOR_DATABASE_URL`` is set, which is
    precisely the case `migrate.yml` runs. The comparison is then skipped and
    said to be skipped.
    """
    if os.environ.get(APP_VAR):
        return os.environ[APP_VAR]
    for fname in APP_ENV_FILES:
        value = _from_file(ROOT / fname, APP_VAR)
        if value:
            return value
    return None


def endpoint_of(url: str) -> str | None:
    """The Neon endpoint id in a connection string, or ``None``.

    ``ep-small-cake-ac4lizlb-pooler.sa-east-1.aws.neon.tech`` and
    ``ep-small-cake-ac4lizlb.sa-east-1.aws.neon.tech`` are the pooled and the
    direct door onto **one** compute, so the ``-pooler`` suffix is dropped.
    Comparing hosts verbatim would call those two databases and refuse every
    ordinary run — the guard would be noise and would be switched off, which is
    how a guard becomes worse than nothing.
    """
    host = urlsplit(url).hostname
    if not host:
        return None
    first = host.split(".")[0]
    return first[: -len("-pooler")] if first.endswith("-pooler") else first


def database_of(url: str) -> str | None:
    """The database name, which is **not** enough on its own: both branches of
    this project are called `neondb`, which is Neon's default."""
    path = urlsplit(url).path.lstrip("/")
    return path.split("?")[0] or None


def role_of(url: str) -> str | None:
    """The role. Printed, never compared — `migrator` and `neondb_owner` are
    both correct answers for the same database."""
    return urlsplit(url).username


def describe(url: str) -> str:
    """One line naming where the writes are about to go. No credential."""
    return (
        f"endpoint={endpoint_of(url) or '?'} "
        f"database={database_of(url) or '?'} "
        f"role={role_of(url) or '?'}"
    )


def check_target(url: str, *, allow_other: bool) -> None:
    """Refuse when this is not the database the application reads.

    Compared on the **endpoint**, because that is the thing that differed and
    the only field that can: the database name is `neondb` on both branches,
    and the role differs by design.
    """
    app = app_dsn()
    if app is None:
        print("  (no DATABASE_URL to compare against — nothing checked)")
        return
    mine, theirs = endpoint_of(url), endpoint_of(app)
    if mine is None or theirs is None or mine == theirs:
        return
    print(f"  the application reads {describe(app)}")
    if allow_other:
        print("  --allow-other-database: continuing against a different endpoint")
        return
    sys.exit(
        "refusing: this would migrate an endpoint the application does not read.\n"
        f"  about to migrate {mine}\n"
        f"  the application reads {theirs}\n"
        "Pass --allow-other-database if that is deliberate — migrating `staging`\n"
        "by hand is (see CLAUDE.md, Schema changes). Otherwise set\n"
        "MIGRATOR_DATABASE_URL to the database you mean."
    )


def pending_versions(applied: dict[str, str], files: list[Path]) -> list[str]:
    """The migrations on disk that this database has never seen."""
    return [path.stem for path in files if path.stem not in applied]


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    only_check = "--check" in args
    allow_other = "--allow-other-database" in args
    unknown = [a for a in args if a not in ("--check", "--allow-other-database")]
    if unknown:
        sys.exit(f"unknown argument(s): {' '.join(unknown)}")

    files = sorted(MIGRATIONS.glob("*.sql"))
    if not files:
        print("no migrations found")
        return 0

    url = dsn()
    # **Before anything is read or written**: say where. One line, and it is the
    # line whose absence cost an afternoon (B50).
    print(f"{'checking' if only_check else 'migrating'} {describe(url)}")
    if not only_check:
        check_target(url, allow_other=allow_other)

    with psycopg.connect(url, connect_timeout=30, autocommit=True) as conn:
        with conn.cursor() as cur:
            if only_check:
                # A read-only mode must not create the table it reports on: on
                # a database that has never been migrated the honest answer is
                # "everything is pending", not a new empty table.
                cur.execute(
                    "select exists (select 1 from information_schema.tables"
                    " where table_name = 'schema_migrations')"
                )
                row = cur.fetchone()
                if not (row and row[0]):
                    print(f"  no schema_migrations table: all {len(files)} migrations pending")
                    return 1
            else:
                cur.execute(
                    "create table if not exists schema_migrations ("
                    "  version    text primary key,"
                    "  sha256     text not null,"
                    "  applied_at timestamptz not null default now())"
                )
            cur.execute("select version, sha256 from schema_migrations")
            applied = dict(cur.fetchall())

        if only_check:
            waiting = pending_versions(applied, files)
            drifted = [
                path.stem
                for path in files
                if path.stem in applied
                and applied[path.stem] != hashlib.sha256(path.read_text().encode()).hexdigest()
            ]
            for version in waiting:
                print(f"  + {version} (pending)")
            for version in drifted:
                print(f"  ! {version} (applied, but the file has changed since — see B46)")
            print(f"{len(waiting)} pending, {len(applied)} applied")
            # Non-zero so a preflight or a CI step can gate on it.
            return 1 if (waiting or drifted) else 0

        pending = 0
        for path in files:
            version = path.stem
            body = path.read_text()
            digest = hashlib.sha256(body.encode()).hexdigest()

            if version in applied:
                if applied[version] != digest:
                    sys.exit(
                        f"{version} was already applied but its contents changed.\n"
                        "Migrations are immutable: add a new file instead of editing this one."
                    )
                print(f"  = {version} (already applied)")
                continue

            pending += 1
            print(f"  + {version} …", end=" ", flush=True)
            with conn.transaction(), conn.cursor() as cur:
                cur.execute(body)
                cur.execute(
                    "insert into schema_migrations (version, sha256) values (%s, %s)",
                    (version, digest),
                )
            print("ok")

        print(f"{pending} applied, {len(files) - pending} already present")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
