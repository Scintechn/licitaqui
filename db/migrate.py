#!/usr/bin/env python3
"""Apply db/migrations/*.sql in order, exactly once each.

Idempotent: applied files are recorded in schema_migrations and skipped on a
rerun. Each file runs in its own transaction, so a failure leaves earlier
migrations applied and the failing one fully rolled back.

Connection: MIGRATOR_DATABASE_URL (the DDL role), falling back to
DATABASE_URL_UNPOOLED. Migrations must use a direct, non-pooled connection.
Reads .env.neon-roles.local then .env.local when the variable is not already
in the environment.
"""

from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = Path(__file__).resolve().parent / "migrations"
ENV_FILES = (".env.neon-roles.local", ".env.local")
VARS = ("MIGRATOR_DATABASE_URL", "DATABASE_URL_UNPOOLED")


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


def main() -> int:
    files = sorted(MIGRATIONS.glob("*.sql"))
    if not files:
        print("no migrations found")
        return 0

    with psycopg.connect(dsn(), connect_timeout=30, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "create table if not exists schema_migrations ("
                "  version    text primary key,"
                "  sha256     text not null,"
                "  applied_at timestamptz not null default now())"
            )
            cur.execute("select version, sha256 from schema_migrations")
            applied = dict(cur.fetchall())

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
