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

from collections.abc import Callable, Sequence
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
returning id, kind, key, priority, payload, attempts,
          extract(epoch from (now() - created_at))
"""


#: Spec §7.3, verbatim in effect: claim the highest-priority due job.
CLAIM_SQL = _claim_sql()
#: Same statement for a consumer dedicated to a subset of kinds.
CLAIM_KINDS_SQL = _claim_sql("\n                and kind = any(%s)")

# The dedupe index is partial, so ON CONFLICT has to name its predicate for
# Postgres to infer it: one live job per (kind, key).
#: The same insert, for many jobs in **one** round trip.
#:
#: `enqueue` is one statement per job, which is right for the handful a normal
#: cycle produces and wrong by two orders of magnitude for B17's first run:
#: ~13 000 new tenders × three follow-up kinds is 39 000 sequential round
#: trips, measured at **212 ms each against Neon in sa-east-1 — 138 minutes**.
#: `config.STALE_RUNNING_SECONDS` is 3600, so the job would be requeued as
#: stale while still running, and with `WORKER_CONCURRENCY > 1` a second
#: national sweep would start beside the first.
#:
#: `unnest` in the FROM rather than a built VALUES list: the row count does not
#: change the statement text, so psycopg sends the same five parameters however
#: many jobs are in the batch. `kind`, `priority` and `run_after` stay scalars —
#: `coalesce(unnest(...), now())` is rejected outright, a set-returning function
#: is not allowed there.
ENQUEUE_MANY_SQL = """
insert into jobs (kind, key, priority, payload, run_after)
select %(kind)s, batch.key, %(priority)s, batch.payload, coalesce(%(run_after)s, now())
  from unnest(%(keys)s::text[], %(payloads)s::jsonb[]) as batch(key, payload)
on conflict (kind, key) where status in ('queued', 'running') do nothing
returning id
"""

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
    #: Seconds this job sat queued before being claimed — card **B30**.
    #:
    #: **Computed in SQL, not here.** `now() - created_at` takes both sides
    #: from the database's clock. `CLAUDE.md` is explicit that mixing clocks
    #: has already produced a wrong answer in this repo — on 2026-09-23 a
    #: worker was declared stalled for an hour on a database `now()` read
    #: against a laptop clock, and it was six minutes. The worker's container
    #: has no reason to agree with Neon either.
    waited_seconds: float = 0.0


def enqueue_many(
    conn: psycopg.Connection,
    kind: str,
    keys: Sequence[str],
    *,
    priority: int = 5,
    payload_for: Callable[[str], dict[str, Any] | None] | None = None,
    run_after: datetime | None = None,
) -> int:
    """Add many jobs of one kind in a single round trip. Returns how many were
    actually created.

    Dedupes exactly as :func:`enqueue` does — the partial unique index decides,
    not this function — so a key already queued or running is skipped and not
    counted. Duplicate keys *within* one call are also collapsed, because the
    index applies to the statement's own rows too.

    The difference is round trips, and at B17's scale that is the difference
    between a job that finishes and one the queue requeues underneath itself:
    measured 212 ms per single enqueue against Neon in sa-east-1, so 39 000 of
    them is 138 minutes against a one-hour stale threshold.
    """
    unique = list(dict.fromkeys(keys))
    if not unique:
        return 0
    payloads = [
        Jsonb(payload_for(key)) if payload_for and payload_for(key) is not None else None
        for key in unique
    ]
    with conn.cursor() as cur:
        cur.execute(
            ENQUEUE_MANY_SQL,
            {
                "kind": kind,
                "priority": priority,
                "run_after": run_after,
                "keys": unique,
                "payloads": payloads,
            },
        )
        return len(cur.fetchall())


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
    return Job(
        id=row[0],
        kind=row[1],
        key=row[2],
        priority=row[3],
        payload=row[4],
        attempts=row[5],
        waited_seconds=float(row[6]) if row[6] is not None else 0.0,
    )


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
