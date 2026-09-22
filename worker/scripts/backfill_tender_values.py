#!/usr/bin/env python3
"""Backfill `tenders.estimated_value`, through the same code the job runs.

`sweep_tender_values` enqueues a `refresh_tender_value` per unvalued tender and
the consumer drains it; this script does the same work in one pass, for the
5,080 rows the ADR-0001 search fallback ingested before anything went back for
them. It calls :func:`licitaqui.tender_value.refresh_one` — the real
precedence, the real breaker, the real writes — because a backfill that
reimplemented the write path would prove nothing about the write path.

```bash
python -m scripts.backfill_tender_values --dry-run        # counts and cost, writes nothing
python -m scripts.backfill_tender_values --items-only     # no PNCP call at all
python -m scripts.backfill_tender_values --limit 200
python -m scripts.backfill_tender_values --resume         # skip what a previous run valued
```

## It is resumable because of what it selects, not because of a cursor

The work queue is a query: *tenders with no positive `estimated_value` whose
`next_refresh_at` has come round*. A run that dies at row 3,000 leaves the
remaining rows matching that query and the next run picks them up — there is no
offset to lose, and the target may move underneath it (the sweep ingests new
tenders continuously) without either run redoing the other's work. Each row is
written and marked in its own autocommit statement, so there is no batch to roll
back.

## Storage, which is why this script is careful

The obvious implementation merges the Consulta payload into `tenders.raw`.
Measured with `pg_column_size` against production, that adds **2,822 bytes to
each of the 5,373 search-sourced rows — about 14 MB** — on a Neon project at
**496.7 MB of a 512 MB limit**. It would fill the disk rather than fix the
Radar. :mod:`licitaqui.tender_value` therefore writes columns and leaves `raw`
alone; the remaining cost is one rewritten heap tuple per row (`tenders` heap is
9.6 MB for 5,965 rows, ~1.6 KB each, so ~8 MB of dead tuples for a full pass)
which autovacuum reclaims and which **no** implementation avoids, because an
UPDATE is an UPDATE.

`--check-headroom` refuses to start when the database is within
:data:`MIN_HEADROOM_MB` of the limit, and `--pause-every` gives autovacuum room
to keep up during a long run.

## A failed write is never a success

`DiskFull` — and any other write error — is caught per row, counted under
`failed`, and **not** counted as upgraded. Nothing is marked, and
`next_refresh_at` is left alone, so the row matches the selection query again on
the next run. That is the same rule the title lane applied to a 429: a row we
could not finish is a row we come back to, never a row we quietly record as
done.
"""

from __future__ import annotations

import argparse
import sys
import time
from collections import Counter
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import psycopg  # noqa: E402

from licitaqui import config, tender_value  # noqa: E402
from licitaqui.observability import get_logger  # noqa: E402
from licitaqui.pncp import PncpClient  # noqa: E402

log = get_logger("backfill_tender_values")

#: Refuse to start with less than this much room on the Neon project. The
#: coordinator hit `DiskFull` mid-backfill at 496.7 of 512 MB; a full pass needs
#: roughly 8 MB of transient dead tuples before autovacuum reclaims them.
MIN_HEADROOM_MB = 20

#: Neon project storage limit, for the headroom line. Overridable because a
#: plan change should not need a code change.
DEFAULT_LIMIT_MB = 512

DUE_SQL = """
select t.id
  from tenders t
 where (t.estimated_value is null or t.estimated_value <= 0)
   and (%(ignore_backoff)s or t.next_refresh_at is null or t.next_refresh_at <= now())
 order by t.proposals_close_at desc nulls last, t.id
 limit %(limit)s
"""

#: **Every** database on the branch, not `current_database()`.
#:
#: The 512 MB ceiling is the Neon *project's*, and this branch carries 18
#: databases: `neondb` at 305 MB plus sixteen `licitaqui_test_*` at ~9 MB each,
#: 458 MB in total. `pg_database_size(current_database())` answers 305 MB and
#: would have reported 207 MB free on a project the coordinator had just watched
#: hit `DiskFull` — a headroom check that cheerful is worse than none.
#:
#: Neon's own figure reads higher still (496.7 MB when this was written) because
#: it counts WAL and branch history that no `pg_database_size` can see, so treat
#: this as a floor and keep `MIN_HEADROOM_MB` generous.
SIZE_SQL = """
select coalesce(sum(pg_database_size(datname)), 0)
  from pg_database where datistemplate = false
"""

COVERAGE_SQL = """
select count(*)                                                as total,
       count(*) filter (where estimated_value > 0)             as valued,
       count(*) filter (where estimated_value = 0)             as zero,
       count(*) filter (where estimated_value is null)         as null_value,
       count(price_registration)                               as with_srp,
       count(confidential_budget)                              as with_sigiloso_known
  from tenders
"""


def _mb(value: int) -> float:
    return value / 1024 / 1024


def check_headroom(conn: psycopg.Connection, limit_mb: int) -> float:
    """Megabytes left on the project, printed and returned.

    Falls back to the current database alone when the role may not enumerate
    `pg_database` — and says so, because that figure is an undercount and the
    caller must not read it as reassurance.
    """
    try:
        size = int(conn.execute(SIZE_SQL).fetchone()[0])
        scope = "all databases on the branch"
    except psycopg.Error:
        size = int(conn.execute("select pg_database_size(current_database())").fetchone()[0])
        scope = "THIS DATABASE ONLY — the project holds more"
    free = limit_mb - _mb(size)
    print(f"storage {_mb(size):.1f} MB of {limit_mb} MB — {free:.1f} MB free ({scope})")
    return free


def coverage(conn: psycopg.Connection) -> dict[str, int]:
    row = conn.execute(COVERAGE_SQL).fetchone()
    keys = ("total", "valued", "zero", "null_value", "with_srp", "with_sigiloso_known")
    return dict(zip(keys, (int(v) for v in row), strict=True))


def print_coverage(label: str, stats: dict[str, int]) -> None:
    total = stats["total"] or 1
    print(
        f"{label}: {stats['valued']}/{stats['total']} valued "
        f"({100 * stats['valued'] / total:.1f}%) · "
        f"{stats['null_value']} null · {stats['zero']} zero · "
        f"{stats['with_srp']} with srp"
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=10_000)
    parser.add_argument("--dry-run", action="store_true", help="read and decide, write nothing")
    parser.add_argument(
        "--items-only",
        action="store_true",
        help="never call PNCP; take the item sum. What to use while /api/consulta is down.",
    )
    parser.add_argument(
        "--ignore-backoff",
        action="store_true",
        help="include rows whose next_refresh_at has not come round yet",
    )
    parser.add_argument("--report-every", type=int, default=100)
    parser.add_argument(
        "--pause-every",
        type=int,
        default=500,
        help="sleep --pause-seconds after this many writes, to let autovacuum keep up",
    )
    parser.add_argument("--pause-seconds", type=float, default=2.0)
    parser.add_argument("--limit-mb", type=int, default=DEFAULT_LIMIT_MB)
    parser.add_argument(
        "--skip-headroom-check",
        action="store_true",
        help="run even when the project is nearly full (you had better be sure)",
    )
    args = parser.parse_args(argv)

    dsn = config.resolve_secret(*config.WORKER_DSN_VARS)
    if not dsn:
        print("no worker DSN configured", file=sys.stderr)
        return 2

    counts: Counter[str] = Counter()
    agreements = {"compared": 0, "agree": 0}
    disagreements: list[tuple[str, Decimal | None, Decimal | None]] = []
    started = time.monotonic()

    with psycopg.connect(
        dsn, autocommit=True, connect_timeout=config.DEFAULT_CONNECT_TIMEOUT_SECONDS
    ) as conn:
        before = coverage(conn)
        print_coverage("before", before)
        free = check_headroom(conn, args.limit_mb)
        if not args.dry_run and free < MIN_HEADROOM_MB and not args.skip_headroom_check:
            print(
                f"refusing to write: {free:.1f} MB free is under the {MIN_HEADROOM_MB} MB "
                f"this needs. Free space first, or pass --skip-headroom-check.",
                file=sys.stderr,
            )
            return 3

        tender_ids = [
            row[0]
            for row in conn.execute(
                DUE_SQL, {"limit": args.limit, "ignore_backoff": args.ignore_backoff}
            ).fetchall()
        ]
        print(f"{len(tender_ids)} tenders to value" + (" (dry run)" if args.dry_run else ""))

        client: PncpClient | None = None
        try:
            if not args.items_only:
                client = PncpClient()
            for index, tender_id in enumerate(tender_ids, start=1):
                state = tender_value.read_state(conn, tender_id)
                if not state.exists:
                    counts["vanished"] += 1
                    continue
                if args.dry_run:
                    # Decide without writing: the item sum is already known and
                    # a PNCP call would be the only other input.
                    counts["would_value_from_items" if state.item_sum else "no_source"] += 1
                    continue
                try:
                    outcome = tender_value.refresh_one(conn, client, tender_id, state)
                    tender_value.mark(conn, outcome)
                except psycopg.errors.DiskFull as exc:
                    # Never counted as upgraded, never marked, `next_refresh_at`
                    # untouched: the row is still due on the next run.
                    counts["failed_disk_full"] += 1
                    print(
                        f"\nDiskFull on {tender_id} after {counts['consulta'] + counts['items']} "
                        f"rows — stopping. {config.redact(str(exc))[:160]}",
                        file=sys.stderr,
                    )
                    break
                except psycopg.Error as exc:
                    counts["failed_write"] += 1
                    log.warning(
                        "backfill write failed",
                        extra={"tender_id": tender_id, "error": config.redact(str(exc))[:200]},
                    )
                    continue

                counts[outcome.source] += 1
                if outcome.agrees is not None:
                    agreements["compared"] += 1
                    if outcome.agrees:
                        agreements["agree"] += 1
                    elif len(disagreements) < 50:
                        disagreements.append(
                            (outcome.tender_id, outcome.header_value, outcome.item_sum)
                        )

                if args.report_every and index % args.report_every == 0:
                    print(
                        f"  {index}/{len(tender_ids)} · "
                        f"consulta={counts['consulta']} items={counts['items']} "
                        f"none={counts['none']} gone={counts['gone']}",
                        flush=True,
                    )
                if args.pause_every and index % args.pause_every == 0:
                    time.sleep(args.pause_seconds)
        finally:
            if client is not None:
                client.close()

        after = coverage(conn)
        print()
        print_coverage("after ", after)
        check_headroom(conn, args.limit_mb)

    print(f"\nsources: {dict(counts)}")
    if agreements["compared"]:
        rate = 100 * agreements["agree"] / agreements["compared"]
        print(
            f"consulta vs item sum: {agreements['agree']}/{agreements['compared']} "
            f"agree to the cent ({rate:.1f}%)"
        )
        for tender_id, header, item_sum in disagreements[:10]:
            print(f"  differ: {tender_id} consulta={header} items={item_sum}")
    print(f"gained {after['valued'] - before['valued']} valued tenders "
          f"in {time.monotonic() - started:.0f}s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
