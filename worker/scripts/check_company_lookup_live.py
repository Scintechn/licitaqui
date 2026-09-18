#!/usr/bin/env python3
"""B5 acceptance check: run `company_lookup` against BrasilAPI for real CNPJs.

This is the only thing in the repository that calls BrasilAPI. The unit and
integration suites never do — they use fixtures and a substituted client — so
`pytest` stays offline and deterministic and this stays a deliberate, separate
run:

    python worker/scripts/check_company_lookup_live.py --sample cnpjs.json --limit 50

`--sample` is a JSON list of 14-digit CNPJs; use real suppliers (PNCP award
winners) or publicly known companies, never personal data. The sample file is
**not** committed: a MEI's CNPJ can identify a person (§12), and the same
reasoning kept ADR-0002's own sample out of the repository.

The run writes to the isolated database named by `--dsn-var` (default
`TEST_DATABASE_URL_B5`), resolved the way `db/migrate.py` resolves its own
connection string, and deletes the rows it created unless `--keep` is given.
Nothing it prints or writes contains a CNPJ, a legal name or an address: rows
are identified by `company.cnpj_ref`, the same digest the worker logs.
"""

from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import sys
import time
from pathlib import Path

import httpx
import psycopg

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from licitaqui import brasilapi, company, config  # noqa: E402
from licitaqui.observability import setup_logging  # noqa: E402


def candidate_roots() -> tuple[Path, ...]:
    """This checkout, then the main one: env files live outside a worktree."""
    roots = [config.ROOT]
    try:
        common = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
            cwd=config.ROOT,
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return tuple(roots)
    if common:
        main_root = Path(common).parent
        if main_root not in roots:
            roots.append(main_root)
    return tuple(roots)


def resolve_dsn(var: str) -> str:
    for root in candidate_roots():
        dsn = config.resolve_secret(var, root=root)
        if dsn:
            return dsn
    sys.exit(f"{var} is not set (environment, or {', '.join(config.ENV_FILES)})")


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, int(fraction * len(ordered)))]


def summarise(values: list[float]) -> dict[str, float]:
    if not values:
        return {}
    return {
        "min": round(min(values), 2),
        "median": round(statistics.median(values), 2),
        "p95": round(percentile(values, 0.95), 2),
        "max": round(max(values), 2),
    }


class TimedClient:
    """Wraps the client `brasilapi.fetch` uses, timing the request only.

    The politeness delay happens before the call, and ``Response.elapsed`` is
    not readable from an event hook, so the measurement lives here.
    """

    def __init__(self, client: httpx.Client) -> None:
        self._client = client
        self.seconds: list[float] = []
        self.statuses: dict[str, int] = {}
        self.retry_after: list[str] = []

    def get(self, url: str) -> httpx.Response:
        started = time.monotonic()
        response = self._client.get(url)
        self.seconds.append(time.monotonic() - started)
        key = str(response.status_code)
        self.statuses[key] = self.statuses.get(key, 0) + 1
        for header in ("retry-after", "x-ratelimit-remaining", "ratelimit-remaining"):
            if header in response.headers:
                self.retry_after.append(f"{header}={response.headers[header]}")
        return response

    def close(self) -> None:
        self._client.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sample", required=True, help="JSON list of 14-digit CNPJs")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument(
        "--delay",
        type=float,
        default=brasilapi.MIN_INTERVAL_SECONDS,
        help="seconds between lookups; the floor the worker itself enforces",
    )
    parser.add_argument("--dsn-var", default="TEST_DATABASE_URL_B5")
    parser.add_argument("--out", default="company_lookup_live.json")
    parser.add_argument("--keep", action="store_true", help="do not delete the rows written")
    args = parser.parse_args()

    setup_logging()
    brasilapi.MIN_INTERVAL_SECONDS = args.delay

    cnpjs = [brasilapi.normalise_cnpj(c) for c in json.loads(Path(args.sample).read_text())][
        : args.limit
    ]
    if not cnpjs:
        sys.exit("sample is empty")

    # Measure the HTTP request itself, not the politeness delay in front of it.
    client = httpx.Client(
        timeout=brasilapi.TIMEOUT_SECONDS,
        follow_redirects=True,
        headers={"User-Agent": brasilapi.USER_AGENT, "Accept": "application/json"},
    )
    timed = TimedClient(client)
    brasilapi._shared_client = lambda: timed  # noqa: SLF001 - measurement harness

    dsn = resolve_dsn(args.dsn_var)
    outcomes: dict[str, int] = {}
    reasons: dict[str, int] = {}
    rows: list[dict] = []
    started_all = time.monotonic()

    with psycopg.connect(dsn, autocommit=True, connect_timeout=15) as conn:
        conn.execute("delete from companies where cnpj = any(%s)", (cnpjs,))
        for index, cnpj in enumerate(cnpjs, 1):
            started = time.monotonic()
            result = company.lookup(conn, cnpj)
            elapsed = time.monotonic() - started
            outcomes[result.status] = outcomes.get(result.status, 0) + 1
            if result.reason:
                reasons[result.reason] = reasons.get(result.reason, 0) + 1
            rows.append(
                {
                    "n": index,
                    "ref": company.cnpj_ref(cnpj),
                    "status": result.status,
                    "reason": result.reason,
                    "end_to_end_s": round(elapsed, 2),
                }
            )
            print(
                f"  {index:>3}/{len(cnpjs)} {company.cnpj_ref(cnpj)} "
                f"{result.status:<12} {result.reason or '':<22} {elapsed:5.2f}s",
                flush=True,
            )

        stored = read_back(conn, cnpjs)
        if not args.keep:
            conn.execute("delete from companies where cnpj = any(%s)", (cnpjs,))

    timed.close()

    report = {
        "n": len(cnpjs),
        "wall_s": round(time.monotonic() - started_all, 1),
        "delay_s": args.delay,
        "outcomes": outcomes,
        "resolved": outcomes.get("resolved", 0),
        "manual_cnae": outcomes.get("manual_cnae", 0),
        "reasons": reasons,
        "http_statuses": timed.statuses,
        "rate_limited_429": timed.statuses.get("429", 0),
        "rate_limit_headers": sorted(set(timed.retry_after)),
        "http_latency_s": summarise(timed.seconds),
        "end_to_end_s": summarise([r["end_to_end_s"] for r in rows]),
        "stored": stored,
    }
    Path(args.out).write_text(json.dumps({"report": report, "rows": rows}, indent=2))
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0


def read_back(conn: psycopg.Connection, cnpjs: list[str]) -> dict:
    """Summarise what actually landed in `companies`. No identifiers leave here."""
    with conn.cursor() as cur:
        cur.execute(
            "select main_cnae is not null as resolved, size, is_mei, registration_status,"
            " coalesce(cardinality(secondary_cnaes), 0) as secondary,"
            " legal_name is not null as has_legal_name,"
            " trade_name is not null as has_trade_name"
            " from companies where cnpj = any(%s)",
            (cnpjs,),
        )
        found = cur.fetchall()

    sizes: dict[str, int] = {}
    mei = {"true": 0, "false": 0, "null_unknown": 0}
    status_counts: dict[str, int] = {}
    secondary: list[int] = []
    resolved = trade = legal = 0
    for is_resolved, size, is_mei, reg_status, n_secondary, has_legal, has_trade in found:
        status_counts[str(reg_status)] = status_counts.get(str(reg_status), 0) + 1
        if not is_resolved:
            continue
        resolved += 1
        sizes[str(size)] = sizes.get(str(size), 0) + 1
        mei["null_unknown" if is_mei is None else str(is_mei).lower()] += 1
        secondary.append(n_secondary)
        legal += 1 if has_legal else 0
        trade += 1 if has_trade else 0

    return {
        "rows": len(found),
        "resolved_rows": resolved,
        "manual_cnae_rows": len(found) - resolved,
        "registration_status": status_counts,
        "size_from_codigo_porte": sizes,
        "is_mei": mei,
        "secondary_cnaes": {
            "zero": sum(1 for n in secondary if n == 0),
            "median": statistics.median(secondary) if secondary else 0,
            "max": max(secondary) if secondary else 0,
        },
        "legal_name_present": legal,
        "trade_name_present": trade,
    }


if __name__ == "__main__":
    sys.exit(main())
