#!/usr/bin/env python3
"""Queue B17's coverage comparison — the `q=saas` re-run (card B17).

    python worker/scripts/check_coverage.py             # dry run
    python worker/scripts/check_coverage.py --commit     # writes the row
    python worker/scripts/check_coverage.py --commit --q limpeza

## Why this exists as a queued job rather than a script that measures

B17's acceptance is one comparison: ask PNCP for the editais matching a keyword
that are open for proposals, and count how many we hold. Measured 2026-09-27 as
**57 of 137 — 41,6%**.

**It cannot be re-run from a laptop.** On 2026-09-29 and 09-30 every attempt
from Portugal came back ``ReadError: [Errno 54] Connection reset by peer``,
including the client's own known-good parameter shape — so it was not a
malformed query, and an empty result would have been a measurement of our own
blocked request rather than of the Radar. The same endpoint answers the worker
without complaint: ``sync_open_tenders`` completed 47 times in the 24 h to
2026-09-30 06:53 UTC.

So this script writes a `coverage_check` job and the **worker** does the
asking, through the same client, breaker and throttle as every other PNCP read.
The answer lands in `events` and in the worker's log; nothing is printed here
except confirmation that the row was queued.

## Reading the answer

    select created_at, props from events
     where name = 'coverage_check'
     order by created_at desc limit 1;

`props.ratio` against `props.target` (0.95) is the pass, and
`props.baseline_2026_09_27` carries the number it has to beat. A **raised**
job rather than a row means PNCP answered nothing — the handler refuses to
record 0% from a failed walk, which is the `empty result is not absence` rule
this repo has been bitten by.

## Safe by default

Without `--commit` this prints what it would enqueue and writes nothing.
Idempotent with it: the key carries the query and the UTC date, so running it
twice in a day dedupes through `jobs_dedupe` like every other kind. Ask again
tomorrow and you get a fresh measurement.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

import psycopg

from licitaqui import config, queue
from licitaqui.coverage_check import DEFAULT_QUERY


def job_key(query: str, day: str) -> str:
    """One measurement per query per UTC day. The date is the log's, not the
    product's: this row is an engineering fact, and `CLAUDE.md` is explicit
    that the database and the logs are UTC while the product is BRT."""
    return f"coverage:{query}:{day}"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", action="store_true", help="actually write the row")
    parser.add_argument("--q", default=DEFAULT_QUERY, help="keyword to compare on")
    args = parser.parse_args()

    day = datetime.now(ZoneInfo("UTC")).date().isoformat()
    key = job_key(args.q, day)

    if not args.commit:
        print(f"dry run — would enqueue coverage_check key={key!r} q={args.q!r}")
        print("re-run with --commit to write it")
        return 0

    dsn = config.require_secret(*config.WORKER_DSN_VARS)
    with psycopg.connect(dsn, autocommit=True, connect_timeout=30) as conn:
        job_id = queue.enqueue(conn, "coverage_check", key, priority=9, payload={"q": args.q})

    if job_id is None:
        print(f"already queued today: key={key!r} — nothing written")
        return 0

    print(f"queued coverage_check job_id={job_id} key={key!r}")
    print("read it back with:")
    print("  select created_at, props from events")
    print("   where name = 'coverage_check' order by created_at desc limit 1;")
    return 0


if __name__ == "__main__":
    sys.exit(main())
