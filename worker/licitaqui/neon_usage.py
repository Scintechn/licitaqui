"""``neon_usage`` — what the Neon bill is actually made of (card **B27**).

## Why this job exists, and why it does not report CU-hours

`/admin`'s usage card can measure one thing from inside Postgres —
`pg_database_size()` — and §3 forbids it reaching Neon's API inside a web
request. So the two remaining rows needed a job. This is it.

**It deliberately does not publish Neon's own compute figures**, because on
2026-09-30 they could not be reconciled:

| source | compute, same period |
|---|---|
| Neon console | **57.08 CU-hrs** |
| API, project level, 11:26 | 69 312 s = 19.25 CU-h |
| API, project level, 14:00 | **0** |
| API, branch level, 14:00 | 69 312 s |

Three answers from two endpoints inside three hours. Printing any of them
beside the word "CU-horas" would put a number on the one screen whose entire
purpose is warning before Neon stops the database — which is the defect B27
was opened for, committed a second time. `consumption_history`, which would be
authoritative, is **Scale-plan only** (403 on Launch).

## What it publishes instead

The **compute operations log** — `GET /projects/{id}/operations` — which is a
primary record rather than an aggregate: one row per `start_compute` and
`suspend_compute`, with timestamps. Pairing them gives *awake time*, and awake
time **is** what Neon charges for. It is also the number we control: card B28
exists because the endpoint is awake 61% of the day while the entire query
board totals under a minute.

Derived here, from that log:

- wake cycles per day,
- hours awake per day, and what share of the day that is,
- the five-minute tail those cycles cost, which is Launch's floor and cannot
  be shortened (60/90/120/180/240 s are all refused),
- whether the compute is awake **right now**, and since when.

Plus `synthetic_storage_size`, which is the billed storage metric and the one
API figure that has stayed self-consistent.

A reader can multiply awake hours by their own CU rate; the card does not
guess one. **Every number on it is either measured here or measured in
Postgres, and the row says which.**
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from datetime import UTC, datetime, timedelta
from typing import Any

from psycopg.types.json import Jsonb

from .registry import REGISTRY, JobContext

NEON_API = "https://console.neon.tech/api/v2"

#: How far back to read the operations log. A week is enough to see a trend
#: and short enough to stay inside a handful of pages.
DEFAULT_DAYS = 7

#: Neon's suspend floor on Launch, verified 2026-09-30 by the API refusing 60,
#: 90, 120, 180 and 240 s with "suspend interval is too short for your plan".
#: Every wake cycle carries this much idle, billed time at its end.
SUSPEND_TAIL_SECONDS = 300

#: Pages of 200; a week of cycles is well inside this.
MAX_PAGES = 10

EVENT_NAME = "neon_usage"


class NeonUnavailable(RuntimeError):
    """The API could not be read. Raise rather than write a zero."""


def _get(path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
    key = os.environ.get("NEON_API_KEY", "").strip()
    if not key:
        raise NeonUnavailable("NEON_API_KEY is not set")
    url = NEON_API + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {key}", "Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as answer:
            return json.load(answer)
    except urllib.error.HTTPError as error:
        raise NeonUnavailable(f"Neon API {error.code}") from None
    except OSError as error:
        raise NeonUnavailable(f"Neon API unreachable: {type(error).__name__}") from None


def _parse(stamp: str) -> datetime:
    return datetime.fromisoformat(stamp.replace("Z", "+00:00"))


def read_operations(project_id: str, since: datetime) -> list[dict[str, Any]]:
    """Every compute start/suspend back to `since`, newest first."""
    out: list[dict[str, Any]] = []
    cursor: str | None = None
    for _ in range(MAX_PAGES):
        params: dict[str, Any] = {"limit": 200}
        if cursor:
            params["cursor"] = cursor
        body = _get(f"/projects/{project_id}/operations", params)
        page = body.get("operations") or []
        if not page:
            break
        out.extend(page)
        if _parse(page[-1]["created_at"]) < since:
            break
        cursor = (body.get("pagination") or {}).get("cursor")
        if not cursor:
            break
    return [o for o in out if o.get("action") in ("start_compute", "suspend_compute")]


def awake_windows(
    operations: list[dict[str, Any]], since: datetime, now: datetime
) -> list[tuple[datetime, datetime, bool]]:
    """Pair starts with suspends into `(from, to, still_awake)` windows.

    The log is newest-first, so it is walked oldest-first here. A `start` with
    no matching `suspend` means the compute is **awake now** — which is not a
    gap in the data, it is the most important thing the card can say.
    """
    ordered = sorted(operations, key=lambda o: _parse(o["created_at"]))
    windows: list[tuple[datetime, datetime, bool]] = []
    opened: datetime | None = None
    for op in ordered:
        when = _parse(op["created_at"])
        if op["action"] == "start_compute":
            # Two starts without a suspend between them: keep the first, which
            # is when this awake period actually began.
            opened = opened or when
        elif op["action"] == "suspend_compute" and opened is not None:
            if when > since:
                windows.append((max(opened, since), when, False))
            opened = None
    if opened is not None:
        windows.append((max(opened, since), now, True))
    return windows


@REGISTRY.job(EVENT_NAME)
def neon_usage(ctx: JobContext) -> None:
    project_id = os.environ.get("NEON_PROJECT_ID", "").strip()
    if not project_id:
        raise NeonUnavailable("NEON_PROJECT_ID is not set")

    days = int(ctx.payload.get("days") or DEFAULT_DAYS)
    now = datetime.now(UTC)
    since = now - timedelta(days=days)

    operations = read_operations(project_id, since)
    if not operations:
        # **Not "it never woke".** An empty log is the API failing to answer,
        # and a card reading "0 h awake" from it would be a measurement of our
        # own request. Raise; the queue retries and no row is written.
        raise NeonUnavailable("no compute operations returned; nothing measured")

    windows = awake_windows(operations, since, now)
    awake_seconds = sum((end - start).total_seconds() for start, end, _ in windows)
    observed = (now - since).total_seconds()
    cycles = len(windows)
    live = windows[-1] if windows and windows[-1][2] else None

    project = _get(f"/projects/{project_id}")["project"]
    storage_bytes = project.get("synthetic_storage_size")

    props = {
        "observed_days": days,
        "observed_seconds": round(observed),
        "wake_cycles": cycles,
        "wake_cycles_per_day": round(cycles / days, 1) if days else None,
        "awake_seconds": round(awake_seconds),
        "awake_hours_per_day": round(awake_seconds / 3600 / days, 2) if days else None,
        "awake_share": round(awake_seconds / observed, 4) if observed else None,
        # What the cycles cost in idle-but-billed time. Launch's floor.
        "suspend_tail_seconds": SUSPEND_TAIL_SECONDS,
        "tail_hours_per_day": round(cycles * SUSPEND_TAIL_SECONDS / 3600 / days, 2)
        if days
        else None,
        "awake_now": live is not None,
        "awake_since": live[0].isoformat() if live else None,
        "project_storage_bytes": storage_bytes,
        # Said out loud, so nobody reads the absence as an oversight and
        # "fixes" it with a figure from an endpoint that contradicts itself.
        "compute_cu_hours": None,
        "compute_note": (
            "Neon's own compute figures disagreed across endpoints on 2026-09-30 "
            "(console 57.08 CU-h, API 19.25 then 0); consumption_history is Scale-only. "
            "Awake time is measured from the operations log instead."
        ),
        "measured_at": now.isoformat(),
    }

    ctx.conn.execute("insert into events (name, props) values (%s, %s)", (EVENT_NAME, Jsonb(props)))
    ctx.log.info("neon usage measured", extra={"neon_usage": json.dumps(props)})
