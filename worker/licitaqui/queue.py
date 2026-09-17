"""The `jobs` queue: enqueue, claim, finish.

The schema lives in ``db/migrations/0001_initial.sql`` and is not this module's
to change. Everything here is DML, because the worker connects as the `app`
role, which has no DDL rights (§5.1).

Claiming uses the statement from spec §7.3: a single autocommit
``UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)``. The
subquery takes a row lock on exactly one `queued` row and skips any row another
consumer already holds, so two consumers can never claim the same job.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import psycopg
from psycopg.types.json import Jsonb

from . import config

ERROR_MAX_CHARS = 2000


def _claim_sql(kind_filter: str = "") -> str:
    return f"""
update jobs
   set status = 'running',
       attempts = attempts + 1,
       updated_at = now()
 where id = (select id
               from jobs
              where status = 'queued'
                and run_after <= now(){kind_filter}
              order by priority, id
              for update skip locked
              limit 1)
returning id, kind, key, priority, payload, attempts
"""


#: Spec §7.3, verbatim in effect: claim the highest-priority due job.
CLAIM_SQL = _claim_sql()
#: Same statement for a consumer dedicated to a subset of kinds.
CLAIM_KINDS_SQL = _claim_sql("\n                and kind = any(%s)")

# The dedupe index is partial, so ON CONFLICT has to name its predicate for
# Postgres to infer it: one live job per (kind, key).
ENQUEUE_SQL = """
insert into jobs (kind, key, priority, payload, run_after)
values (%(kind)s, %(key)s, %(priority)s, %(payload)s, coalesce(%(run_after)s, now()))
on conflict (kind, key) where status in ('queued', 'running') do nothing
returning id
"""

REQUEUE_STALE_SQL = """
update jobs
   set status = 'queued',
       error = %(error)s,
       updated_at = now()
 where status = 'running'
   and updated_at < now() - make_interval(secs => %(seconds)s)
   and (%(kinds)s::text[] is null or kind = any(%(kinds)s))
"""


@dataclass(frozen=True, slots=True)
class Job:
    """One claimed row of `jobs`."""

    id: int
    kind: str
    key: str
    priority: int
    payload: dict[str, Any] | None
    attempts: int


def enqueue(
    conn: psycopg.Connection,
    kind: str,
    key: str,
    *,
    priority: int = 5,
    payload: dict[str, Any] | None = None,
    run_after: datetime | None = None,
) -> int | None:
    """Add a job unless an identical one is already queued or running.

    Returns the new id, or ``None`` when the dedupe index rejected it.
    """
    with conn.cursor() as cur:
        cur.execute(
            ENQUEUE_SQL,
            {
                "kind": kind,
                "key": key,
                "priority": priority,
                "payload": Jsonb(payload) if payload is not None else None,
                "run_after": run_after,
            },
        )
        row = cur.fetchone()
    return None if row is None else int(row[0])


def claim(conn: psycopg.Connection, *, kinds: Sequence[str] | None = None) -> Job | None:
    """Claim the highest-priority due job, or ``None`` when there is nothing.

    ``kinds`` restricts a consumer to part of the queue, so one container can be
    dedicated to the slow AI jobs while another keeps the syncs moving. It only
    adds a predicate to the inner SELECT; the ``FOR UPDATE SKIP LOCKED`` lock
    that keeps two consumers off the same row is the same either way.
    """
    with conn.cursor() as cur:
        if kinds is None:
            cur.execute(CLAIM_SQL)
        else:
            cur.execute(CLAIM_KINDS_SQL, (list(kinds),))
        row = cur.fetchone()
    if row is None:
        return None
    return Job(id=row[0], kind=row[1], key=row[2], priority=row[3], payload=row[4], attempts=row[5])


def mark_done(conn: psycopg.Connection, job_id: int) -> None:
    with conn.cursor() as cur:
        cur.execute(
            "update jobs set status = 'done', error = null, updated_at = now() where id = %s",
            (job_id,),
        )


def next_backoff(
    attempts: int,
    *,
    max_attempts: int = config.MAX_ATTEMPTS,
    backoff: tuple[int, ...] = config.BACKOFF_SECONDS,
) -> int | None:
    """Seconds to wait before attempt ``attempts + 1``; ``None`` when spent.

    ``attempts`` is the number of attempts already made, i.e. the value the
    claim statement returned. Attempt 1 waits 2 min, 2 waits 8 min, 3 waits
    30 min; after attempt 4 the job is `failed` (§7.2).
    """
    if attempts >= max_attempts or attempts < 1:
        return None
    return backoff[min(attempts - 1, len(backoff) - 1)]


def mark_failed(
    conn: psycopg.Connection,
    job: Job,
    error: str,
    *,
    max_attempts: int = config.MAX_ATTEMPTS,
    backoff: tuple[int, ...] = config.BACKOFF_SECONDS,
) -> str:
    """Record a failed attempt. Returns the resulting status.

    ``queued`` when there are attempts left (with `run_after` pushed out by the
    backoff), ``failed`` once the budget is spent. The error is stored either
    way, redacted and truncated.
    """
    message = config.redact(error)[:ERROR_MAX_CHARS]
    delay = next_backoff(job.attempts, max_attempts=max_attempts, backoff=backoff)
    with conn.cursor() as cur:
        if delay is None:
            cur.execute(
                "update jobs set status = 'failed', error = %s, updated_at = now() where id = %s",
                (message, job.id),
            )
            return "failed"
        cur.execute(
            "update jobs set status = 'queued', error = %s,"
            " run_after = now() + make_interval(secs => %s), updated_at = now()"
            " where id = %s",
            (message, delay, job.id),
        )
        return "queued"


def requeue_stale(
    conn: psycopg.Connection,
    *,
    older_than_seconds: int = config.STALE_RUNNING_SECONDS,
    kinds: Sequence[str] | None = None,
) -> int:
    """Put back jobs left `running` by a consumer that died.

    Their attempt has already been counted, so a job whose consumer keeps dying
    still reaches `failed` after four attempts. ``kinds`` limits the sweep to
    the part of the queue this consumer is responsible for.
    """
    params = {
        "error": "requeued: consumer stopped while the job was running",
        "seconds": older_than_seconds,
        "kinds": None if kinds is None else list(kinds),
    }
    with conn.cursor() as cur:
        cur.execute(REQUEUE_STALE_SQL, params)
        return cur.rowcount
