#!/usr/bin/env python3
"""Backfill `tenders.short_title`, through the same code the job runs.

The nightly sweep enqueues a `title_tender` per untitled tender and the
consumer drains it; this script does the same work in one pass, for the ~4,760
rows that existed before the column did. It calls
:func:`licitaqui.title_tender.build_for` and
:func:`licitaqui.title_tender.write_title` — the real branch logic, the real
validator, the real breaker — because a backfill that reimplemented the write
path would prove nothing about the write path.

```bash
python -m scripts.backfill_titles --dry-run          # cost and split, writes nothing
python -m scripts.backfill_titles                    # the real thing
python -m scripts.backfill_titles --limit 200        # a slice
python -m scripts.backfill_titles --dry-run --out /tmp/titles.json
```

## --dry-run

Everything except the `update`: it still reads the rows, still calls the model,
still validates. That is deliberate — it is how the spend was measured before
`0005_tender_short_title.sql` had been applied anywhere, since CLAUDE.md
reserves migrations on the Neon `main` branch for Sci. A dry run needs only the
read path, so it works against a database that has not got the columns yet.

## What it costs

Nothing for the quarter of the corpus the deterministic branch can title, and
one ~550-token call for the rest. `--report-every` prints the running spend, and
the final line is the real total against the estimate.

## Rate limits

:func:`licitaqui.titles.model_title` retries a 429 with jittered backoff. A
tender that is *still* rate-limited after that is counted and **left untitled**,
so the next run picks it up — it is never recorded as titled with the unfit
deterministic string frozen onto it.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import psycopg  # noqa: E402

from licitaqui import config, title_tender, titles  # noqa: E402
from licitaqui.breaker import CircuitOpen  # noqa: E402
from licitaqui.observability import get_logger  # noqa: E402

log = get_logger("backfill_titles")

#: The brief's estimate, for the line this script exists to print.
ESTIMATE_BRL = 0.36

ALL_SQL = """
select t.id from tenders t
 order by t.proposals_close_at desc nulls last, t.id
 limit %(limit)s
"""


def dsn() -> str:
    value = config.resolve_secret("DATABASE_URL")
    if not value:
        sys.exit("set DATABASE_URL")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=10_000)
    parser.add_argument("--dry-run", action="store_true", help="call and score, write nothing")
    parser.add_argument("--report-every", type=int, default=250)
    parser.add_argument("--out", type=Path, help="write every before/after row here as JSON")
    parser.add_argument("--stale-only", action="store_true", help="only rows needing a title")
    args = parser.parse_args()

    key = titles.ai_tender.api_key()
    counts: Counter[str] = Counter()
    rejects: Counter[str] = Counter()
    cost = 0.0
    tokens_in = tokens_out = 0
    retried_calls = 0
    rows_out: list[dict[str, Any]] = []
    started = time.time()

    with psycopg.connect(dsn(), autocommit=True) as conn:
        if args.stale_only:
            ids = title_tender.pending(conn, limit=args.limit)
        else:
            with conn.cursor() as cur:
                cur.execute(ALL_SQL, {"limit": args.limit})
                ids = [r[0] for r in cur.fetchall()]
        print(f"{len(ids)} tenders; dry-run={args.dry_run}")

        for n, tender_id in enumerate(ids, 1):
            inputs = title_tender.read_inputs(conn, tender_id, check_stale=not args.dry_run)
            if inputs is None:
                counts["gone"] += 1
                continue
            try:
                result = title_tender.build_for(inputs, key=key)
            except CircuitOpen as exc:
                counts["circuit_open"] += 1
                log.warning("circuit open, stopping", extra={"retry_in_s": exc.retry_in})
                break

            if result is None:
                counts["rate_limited"] += 1
                continue

            counts[result.source] += 1
            if result.rejected:
                rejects[result.rejected] += 1
            # Every attempt past the first is a 429 the backoff absorbed. Without
            # this, a run reports "0 rate limits" when it means "none that
            # survived four tries", which is a different and much weaker claim.
            if result.attempts > 1:
                counts["retried_429"] += 1
                retried_calls += result.attempts - 1
            cost += result.cost_brl
            tokens_in += result.input_tokens
            tokens_out += result.output_tokens

            if not args.dry_run:
                title_tender.write_title(conn, tender_id, result, inputs.basis)
            if args.out is not None:
                rows_out.append(
                    {
                        "id": tender_id,
                        "object": inputs.object_text,
                        "title": result.text,
                        "source": result.source,
                        "rejected": result.rejected,
                    }
                )
            if args.report_every and n % args.report_every == 0:
                print(
                    f"  {n}/{len(ids)}  R$ {cost:.5f}  {dict(counts)}  {time.time() - started:.0f}s"
                )

    total = sum(
        counts[k]
        for k in (titles.SOURCE_DETERMINISTIC, titles.SOURCE_AI, titles.SOURCE_AI_FALLBACK)
    )
    calls = counts[titles.SOURCE_AI] + counts[titles.SOURCE_AI_FALLBACK]
    print("\n" + "=" * 78)
    print(f"titled {total} of {len(ids)} in {time.time() - started:.0f}s")
    for kind, count in counts.most_common():
        print(f"  {kind:16s} {count:6d}  ({count / max(len(ids), 1):6.1%})")
    if rejects:
        print("\nvalidator rejections / call failures:")
        for reason, count in rejects.most_common():
            print(f"  {count:5d}  {reason}")
    print(
        f"\n429s: {counts['retried_429']} tender(s) needed a retry "
        f"({retried_calls} extra call(s)); {counts['rate_limited']} still rate-limited "
        f"after {titles.RATE_LIMIT_ATTEMPTS} attempts and left untitled"
    )
    print(
        f"model calls {calls}   tokens avg "
        f"{tokens_in / max(calls, 1):.0f} in / {tokens_out / max(calls, 1):.0f} out"
    )
    print(
        f"real spend  R$ {cost:.4f}   estimate R$ {ESTIMATE_BRL:.2f}   "
        f"per model call R$ {cost / max(calls, 1):.8f}"
    )
    print("=" * 78)

    if args.out is not None:
        args.out.write_text(json.dumps(rows_out, ensure_ascii=False, indent=1))
        print(f"wrote {len(rows_out)} rows to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
