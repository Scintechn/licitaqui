#!/usr/bin/env python3
"""Create and migrate the test databases inside CI's Postgres container.

    python db/ci_databases.py            # create + migrate every database
    python db/ci_databases.py --print    # just print the DSNs as env lines

## Why this exists

The suites used to run against **Neon**, on the same compute endpoint as
production. Three things followed, and all three are gone with this script.

**Cost.** Neon bills wall-clock time the endpoint is awake, so every CI run
woke the *live* database and held it for the run plus a five-minute tail that
cannot be shortened (300 s is Launch's floor). `ci-worker.yml` said so itself:
*"the largest single line on the Neon bill after the idle poll: 95 runs in the
seven days to 2026-09-27, averaging ~28 minutes each"*.

**Speed.** That same comment measured the cause: *"~1,000 tests in 30 min is
1.8 s each against Neon in sa-east-1 where a round trip is ~200 ms, so most of
it is per-test fixture setup rather than assertions."* A container is on
localhost, so the round trip is gone rather than optimised.

**Safety that had been traded away.** Because the job was slow and expensive,
it stopped running on pull requests — *"a database-level defect now surfaces at
merge rather than on the pull request. This suite caught two real ones in the
week before this change."* Cheap and fast means it can run on every PR again.

## And two cards it retires

**B24** — two suites that could not run concurrently, because they shared a
database with another run. Each CI run now has its own container.

**B25** — the test databases had drifted three to six migrations behind
`db/migrations`, silently. Impossible here: they are created and migrated from
the same files, on every run.

## What this does *not* cover, and it matters

Neon fronts Postgres with **PgBouncer in transaction mode**; a plain container
does not. That difference has already cost a day here: `pg_advisory_lock` is
session-scoped and silently non-exclusive through Neon's pooler, so two runs
both "acquired" it ten seconds apart. On a container that lock behaves
correctly — which means a pooler bug can pass here and fail in production.

So this is the right home for the bulk of the suite and the wrong home for
anything asserting pooler semantics. Those keep a Neon database and say so at
the test.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parents[1]

#: The databases the suites ask for, by the variable each one reads.
#:
#: **Derived from the workflows, not invented here.** `TEST_DATABASE_URL` is
#: the shared one; the rest are per-task, created when several agents worked in
#: parallel and one suite's cleanup deleted another's fixtures. On a container
#: they cost nothing, so they stay rather than forcing a rewrite of every
#: suite's isolation at the same time as moving them.
SUFFIXES = (
    "",  # TEST_DATABASE_URL -> licitaqui_test
    "B2", "B3", "B4", "B5", "B6", "B8",
    "C1", "D3", "DL", "E1", "E2", "FH", "O1", "R1", "U1",
)


def database_name(suffix: str) -> str:
    return "licitaqui_test" if not suffix else f"licitaqui_test_{suffix.lower()}"


def var_name(suffix: str) -> str:
    return "TEST_DATABASE_URL" if not suffix else f"TEST_DATABASE_URL_{suffix}"


def base_dsn() -> str:
    dsn = os.environ.get("CI_POSTGRES_URL", "").strip()
    if not dsn:
        raise SystemExit("CI_POSTGRES_URL is not set (the container's postgres database)")
    return dsn


def dsn_for(base: str, name: str) -> str:
    """Swap the database component of the base DSN."""
    head, _, _tail = base.rpartition("/")
    return f"{head}/{name}"


def create(base: str) -> None:
    with psycopg.connect(base, autocommit=True, connect_timeout=30) as conn:
        for suffix in SUFFIXES:
            name = database_name(suffix)
            exists = conn.execute(
                "select 1 from pg_database where datname = %s", (name,)
            ).fetchone()
            if exists:
                print(f"  {name}: already there")
                continue
            # Identifier, so it cannot be parameterised. The names come from
            # SUFFIXES above and never from input.
            conn.execute(f'create database "{name}"')
            print(f"  {name}: created")


def migrate(base: str) -> None:
    for suffix in SUFFIXES:
        name = database_name(suffix)
        env = {**os.environ, "MIGRATOR_DATABASE_URL": dsn_for(base, name)}
        result = subprocess.run(
            [sys.executable, str(ROOT / "db" / "migrate.py")],
            env=env,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            print(result.stdout)
            print(result.stderr, file=sys.stderr)
            raise SystemExit(f"migrating {name} failed")
        last = [line for line in result.stdout.splitlines() if line.strip()]
        print(f"  {name}: {last[-1] if last else 'migrated'}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--print", action="store_true", help="only print the env lines")
    args = parser.parse_args()
    base = base_dsn()

    if args.print:
        for suffix in SUFFIXES:
            print(f"{var_name(suffix)}={dsn_for(base, database_name(suffix))}")
        return 0

    print(f"{len(SUFFIXES)} test databases in the CI container:")
    create(base)
    print("migrating:")
    migrate(base)
    return 0


if __name__ == "__main__":
    sys.exit(main())
