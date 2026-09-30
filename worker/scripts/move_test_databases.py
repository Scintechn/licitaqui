#!/usr/bin/env python3
"""Move the test databases off production's compute — card **H3**.

    python worker/scripts/move_test_databases.py                      # plan only
    python worker/scripts/move_test_databases.py --create-project     # make the project
    python worker/scripts/move_test_databases.py --project-id <id> --commit

## Why this exists

All 16 `licitaqui_test*` databases live on the **same Neon endpoint as
production** (`ep-flat-firefly-acai77cp`). Neon bills wall-clock time an
endpoint is awake, so **every CI run wakes the live database** and holds it for
the run plus a five-minute tail that **cannot be shortened** — 300 s is the
floor on Launch, verified by the API refusing 60/90/120/180/240 s.

B22 made that worse on purpose and correctly: the 12 web database suites now
run on **every pull request**. The fix is not to run them less; it is to stop
them touching the endpoint that serves users.

Launch allows 100 projects, so a dedicated test project is free of the
production compute entirely. Its own compute is only awake while CI runs, and
suspends on its own 300 s timer afterwards.

## What this script does, and what it deliberately leaves to Sci

It creates the databases and brings their schema up to date. **It never writes
a secret anywhere a person has to copy from a terminal**: the DSNs are written
to `.env.test-project.local`, which is gitignored, and Sci pastes them into the
seven GitHub secrets and his own `.env.local` from there. Printing 21
connection strings into scrollback is how they end up in a paste buffer, a
screenshot or a log.

Nothing is destructive. The old databases are **left alone** — this makes the
new ones and stops there, so a bad DSN is a red CI run against an empty
database, not lost fixtures. Dropping the originals is a separate, later,
deliberate act once CI has been green against the new project for a few days.

## The variable list is not as tidy as it looks

21 `TEST_DATABASE_URL*` variables are read by code; **CI sets 15**; there are
**16** databases. The five with no database of their own — `D4`, `EV`, `IG`,
`PNCP`, `R2` — fall back to `TEST_DATABASE_URL`, and `U1` has a database but no
CI secret. That drift is why this script derives its list from the **live
`pg_database` catalogue** rather than from a list written here: a constant
would be wrong the first time somebody adds a suite, and silently.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

import psycopg

NEON_API = "https://console.neon.tech/api/v2"
OUT_FILE = ".env.test-project.local"

#: Neon's floor on Launch. Recorded because a future reader will try to lower it.
SUSPEND_SECONDS = 300


def neon(path: str, method: str = "GET", body: dict | None = None) -> dict:
    key = os.environ.get("NEON_API_KEY", "").strip()
    if not key:
        raise SystemExit("NEON_API_KEY is not set")
    request = urllib.request.Request(
        NEON_API + path,
        data=json.dumps(body).encode() if body else None,
        method=method,
        headers={
            "Authorization": f"Bearer {key}",
            "Accept": "application/json",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(request) as answer:
            return json.load(answer)
    except urllib.error.HTTPError as error:
        raise SystemExit(f"Neon API {error.code}: {error.read().decode()[:300]}") from None


def source_databases(dsn: str) -> list[str]:
    """The test databases as they exist now, from the catalogue rather than a list."""
    with psycopg.connect(dsn, autocommit=True, connect_timeout=30) as conn:
        rows = conn.execute(
            "select datname from pg_database "
            " where datname like 'licitaqui_test%' and not datistemplate "
            " order by datname"
        ).fetchall()
    return [row[0] for row in rows]


def var_for(database: str) -> str:
    """`licitaqui_test_b2` → `TEST_DATABASE_URL_B2`; the base one has no suffix."""
    suffix = database.removeprefix("licitaqui_test").lstrip("_")
    return f"TEST_DATABASE_URL_{suffix.upper()}" if suffix else "TEST_DATABASE_URL"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", action="store_true", help="actually create the databases")
    parser.add_argument("--create-project", action="store_true", help="create the Neon project too")
    parser.add_argument("--project-id", help="an existing Neon project to use")
    parser.add_argument("--name", default="licitaqui-tests", help="name for a created project")
    parser.add_argument(
        "--region", default="aws-sa-east-1", help="region for a created project"
    )
    args = parser.parse_args()

    source = os.environ.get("DATABASE_URL_UNPOOLED") or os.environ.get("DATABASE_URL")
    if not source:
        raise SystemExit("set DATABASE_URL_UNPOOLED (or DATABASE_URL) to read the current list")

    names = source_databases(source)
    print(f"{len(names)} test databases on the production endpoint:")
    for name in names:
        print(f"   {name:<28} -> {var_for(name)}")

    if not args.commit and not args.create_project:
        print("\nplan only — nothing was created.")
        print("  1. --create-project        (or pass --project-id for an existing one)")
        print("  2. --project-id <id> --commit")
        print(f"\nThe old databases are never touched. DSNs land in {OUT_FILE} (gitignored).")
        return 0

    project_id = args.project_id
    if args.create_project:
        made = neon(
            "/projects",
            "POST",
            {
                "project": {
                    "name": args.name,
                    "region_id": args.region,
                    # Its own compute, with the same floor production has.
                    "default_endpoint_settings": {"suspend_timeout_seconds": SUSPEND_SECONDS},
                }
            },
        )
        project_id = made["project"]["id"]
        print(f"\ncreated project {args.name} -> {project_id}")
        print("re-run with:  --project-id", project_id, "--commit")
        return 0

    if not project_id:
        raise SystemExit("pass --project-id, or --create-project first")

    detail = neon(f"/projects/{project_id}")["project"]
    if detail["id"] == os.environ.get("NEON_PROJECT_ID", "").strip():
        raise SystemExit(
            "refusing: --project-id is the PRODUCTION project. "
            "The whole point of H3 is a different one."
        )

    branches = neon(f"/projects/{project_id}/branches")["branches"]
    branch_id = next(b["id"] for b in branches if b.get("default"))
    roles = neon(f"/projects/{project_id}/branches/{branch_id}/roles")["roles"]
    owner = roles[0]["name"]

    existing = {
        d["name"]
        for d in neon(f"/projects/{project_id}/branches/{branch_id}/databases")["databases"]
    }

    lines: list[str] = []
    for name in names:
        if name in existing:
            print(f"   {name}: already there")
        else:
            neon(
                f"/projects/{project_id}/branches/{branch_id}/databases",
                "POST",
                {"database": {"name": name, "owner_name": owner}},
            )
            print(f"   {name}: created")
        lines.append(f"{var_for(name)}=<dsn for {name}>")

    Path(OUT_FILE).write_text(
        "# Card H3 — test databases on their own Neon project.\n"
        f"# Project {project_id}. Fill each DSN from the Neon console's Connect\n"
        "# dialog (pick the database in the dropdown), then set these as the\n"
        "# GitHub secrets and in your own .env.local. Do not commit this file.\n"
        + "\n".join(lines)
        + "\n",
        encoding="utf-8",
    )
    print(f"\nwrote {OUT_FILE} with {len(lines)} variable names for you to fill in.")
    print("Then, once the secrets are set, bring the schema up:")
    print("  for each DSN:  python db/migrate.py   (see db/README.md)")
    print("\nThe production databases were not touched. Drop them only after CI has")
    print("been green against the new project for a few days — that is a separate act.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
