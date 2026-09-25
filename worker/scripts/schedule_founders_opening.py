#!/usr/bin/env python3
"""Queue the one-off 08/10 19:00 BRT founders-opening broadcast (task E5).

    python worker/scripts/schedule_founders_opening.py            # dry run
    python worker/scripts/schedule_founders_opening.py --commit    # writes the row

## Why a script, and why it does nothing by default

`ScheduleEntry` (`licitaqui/scheduler.py`) can only express "every N seconds"
or "daily at HH:MM" — never a single date that will not repeat. Rather than
stretch that dataclass for one date, `licitaqui.whatsapp.enqueue_opening_broadcast`
writes **one row** directly with `queue.enqueue(..., run_after=...)` — the
same primitive every job kind already has for waiting, just used once instead
of on a recurring cadence. The row sits `queued` and inert: `jobs.run_after <=
now()` gates every claim (`queue.py`), so nothing happens until the moment
arrives *and* a consumer is running *and* `WHATSAPP_DELIVERY=send` — none of
which this script touches.

It is a deliberate command, run once by a person, rather than something the
scheduler's own startup does automatically. Writing a future-dated production
job is a side effect, and CLAUDE.md's rule is that external side effects need
Sci's own timing, not a consequence of merging or deploying this PR.

Idempotent either way: the job's key is fixed per opening day
(`licitaqui.whatsapp.broadcast_key`), so running this script twice — or
restarting a container that already ran it — dedupes through `jobs_dedupe`
(kind, key) the same way every other job kind does.

Without `--commit` this only prints what it would enqueue (and whether the row
already exists) and writes nothing, so it is safe to run against production
just to check.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime
from pathlib import Path

import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from licitaqui import config, whatsapp  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dsn-var", default=None, help="env var holding the connection string")
    parser.add_argument(
        "--commit", action="store_true", help="actually write the row; default is a dry run"
    )
    return parser.parse_args()


def existing_job(conn: psycopg.Connection, key: str) -> tuple[int, str, datetime] | None:
    row = conn.execute(
        "select id, status, run_after from jobs where kind = %s and key = %s",
        (whatsapp.BROADCAST_JOB_KIND, key),
    ).fetchone()
    return (int(row[0]), str(row[1]), row[2]) if row else None


def main() -> int:
    args = parse_args()
    run_after = whatsapp.broadcast_at()
    key = whatsapp.broadcast_key()

    dsn = (
        config.require_secret(args.dsn_var)
        if args.dsn_var
        else config.require_secret(*config.WORKER_DSN_VARS)
    )
    with psycopg.connect(dsn, autocommit=True, connect_timeout=30) as conn:
        if not args.commit:
            found = existing_job(conn, key)
            print(
                f"would enqueue kind={whatsapp.BROADCAST_JOB_KIND} key={key} "
                f"run_after={run_after.isoformat()} (UTC)"
            )
            if found:
                print(f"already present: id={found[0]} status={found[1]}")
            else:
                print("not queued yet")
            print("dry run — pass --commit to write the row")
            return 0

        job_id = whatsapp.enqueue_opening_broadcast(conn, run_after=run_after)
        if job_id is None:
            found = existing_job(conn, key)
            print(f"already queued: {found}")
        else:
            print(f"enqueued job {job_id}: run_after={run_after.isoformat()} (UTC)")
    return 0


if __name__ == "__main__":  # pragma: no cover - operator tool
    raise SystemExit(main())
