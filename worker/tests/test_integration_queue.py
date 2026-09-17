"""Queue semantics against the real database.

Acceptance criterion 1 lives here: two consumers never run the same job. The
claim statement is the only thing standing between two containers and a
duplicated PNCP sweep, so it is tested with real concurrent connections rather
than asserted in a comment.

Every test works on a job kind of its own and claims with that filter, because
the test database is shared with other tasks' test runs; an unfiltered claim
would pick up their rows and mark them `running`.

Skipped when TEST_DATABASE_URL is not configured.
"""

from __future__ import annotations

import threading
from collections import Counter
from datetime import UTC, datetime, timedelta

import psycopg
import pytest

from licitaqui import queue
from licitaqui.queue import Job
from tests.conftest import unique_key, unique_kind


def _status(conn: psycopg.Connection, job_id: int) -> tuple[str, int, str | None]:
    row = conn.execute(
        "select status, attempts, error from jobs where id = %s", (job_id,)
    ).fetchone()
    assert row is not None
    return row[0], row[1], row[2]


# -- criterion 1: two consumers never run the same job ---------------------


def test_two_consumers_never_claim_the_same_job(clean_dsn: str, conn: psycopg.Connection):
    kind = unique_kind("race_")
    total_jobs = 40
    workers = 8
    ids = {queue.enqueue(conn, kind, unique_key("race-")) for _ in range(total_jobs)}
    assert len(ids) == total_jobs

    claimed: list[int] = []
    lock = threading.Lock()
    start = threading.Barrier(workers)
    errors: list[BaseException] = []

    def consume() -> None:
        try:
            with psycopg.connect(clean_dsn, autocommit=True, connect_timeout=15) as own:
                start.wait(timeout=30)  # make them contend for the same rows
                while True:
                    job = queue.claim(own, kinds=[kind])
                    if job is None:
                        break
                    with lock:
                        claimed.append(job.id)
                    queue.mark_done(own, job.id)
        except BaseException as exc:  # surfaced below so the test fails loudly
            errors.append(exc)

    threads = [threading.Thread(target=consume, name=f"c{i}") for i in range(workers)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(timeout=60)

    assert errors == []
    duplicates = [job_id for job_id, count in Counter(claimed).items() if count > 1]
    assert duplicates == [], f"the same job was claimed twice: {duplicates}"
    assert set(claimed) == ids, "every job must be claimed exactly once"
    assert len(claimed) == total_jobs
    done = conn.execute(
        "select count(*) from jobs where kind = %s and status = 'done'", (kind,)
    ).fetchone()[0]
    assert done == total_jobs


def test_a_locked_row_is_skipped_not_waited_for(clean_dsn: str, conn: psycopg.Connection):
    """SKIP LOCKED, not plain FOR UPDATE: a slow consumer must not block others."""
    kind = unique_kind("skip_")
    first = queue.enqueue(conn, kind, unique_key("skip-a-"), priority=1)
    second = queue.enqueue(conn, kind, unique_key("skip-b-"), priority=2)

    holder = psycopg.connect(clean_dsn, autocommit=False, connect_timeout=15)
    try:
        # Hold the row lock the claim subquery would take, without committing.
        locked = holder.execute(
            "select id from jobs where status = 'queued' and run_after <= now()"
            " and kind = %s order by priority, id for update skip locked limit 1",
            (kind,),
        ).fetchone()
        assert locked is not None and locked[0] == first

        other = psycopg.connect(
            clean_dsn,
            autocommit=True,
            connect_timeout=15,
            # If the claim waited on the lock instead of skipping it, this turns
            # a hanging test into a failing one.
            options="-c statement_timeout=5000",
        )
        try:
            job = queue.claim(other, kinds=[kind])
        finally:
            other.close()
        assert job is not None, "the second consumer blocked instead of skipping"
        assert job.id == second
    finally:
        holder.rollback()
        holder.close()


def test_claim_order_is_priority_then_id(conn: psycopg.Connection):
    kind = unique_kind("prio_")
    low = queue.enqueue(conn, kind, unique_key("prio-low-"), priority=9)
    high = queue.enqueue(conn, kind, unique_key("prio-high-"), priority=1)
    mid = queue.enqueue(conn, kind, unique_key("prio-mid-"), priority=5)

    assert [queue.claim(conn, kinds=[kind]).id for _ in range(3)] == [high, mid, low]


def test_a_job_scheduled_for_later_is_not_claimed(conn: psycopg.Connection):
    kind = unique_kind("future_")
    later = datetime.now(UTC) + timedelta(hours=1)
    queue.enqueue(conn, kind, unique_key("future-"), run_after=later)
    assert queue.claim(conn, kinds=[kind]) is None


def test_the_unfiltered_claim_is_the_statement_from_the_spec():
    """The production path takes no kind filter; both share one statement."""
    normalised = " ".join(queue.CLAIM_SQL.split())
    assert "for update skip locked" in normalised
    assert "order by priority, id" in normalised
    assert "attempts = attempts + 1" in normalised
    assert "status = 'queued' and run_after <= now() order by" in normalised
    assert normalised == " ".join(queue.CLAIM_KINDS_SQL.replace("and kind = any(%s)", "").split())


# -- dedupe ---------------------------------------------------------------


def test_one_live_job_per_kind_and_key(conn: psycopg.Connection):
    kind = unique_kind("dedupe_")
    key = unique_key("dedupe-")
    first = queue.enqueue(conn, kind, key)
    assert first is not None
    assert queue.enqueue(conn, kind, key) is None, "the partial unique index must dedupe"

    job = queue.claim(conn, kinds=[kind])
    assert job is not None and job.id == first
    assert queue.enqueue(conn, kind, key) is None, "a running job still dedupes"

    queue.mark_done(conn, first)
    again = queue.enqueue(conn, kind, key)
    assert again is not None and again != first, "a finished job frees the key"


def test_the_payload_round_trips_as_jsonb(conn: psycopg.Connection):
    kind = unique_kind("payload_")
    payload = {"uf": "SP", "modalidade": 6, "nested": {"page": 2}}
    job_id = queue.enqueue(conn, kind, unique_key("payload-"), payload=payload)
    job = queue.claim(conn, kinds=[kind])
    assert job is not None and job.id == job_id
    assert job.payload == payload


# -- criterion 2: retries and backoff --------------------------------------


def test_a_failing_job_retries_with_backoff_then_fails(conn: psycopg.Connection):
    """Four attempts spaced 2, 8 and 30 minutes apart, then `failed` (§7.2)."""
    kind = unique_kind("retry_")
    job_id = queue.enqueue(conn, kind, unique_key("retry-"))
    delays = []

    for attempt in range(1, 5):
        job = queue.claim(conn, kinds=[kind])
        assert job is not None, f"attempt {attempt}: the job should be claimable"
        assert job.attempts == attempt
        outcome = queue.mark_failed(conn, job, "TimeoutError: PNCP detail timed out")
        row = conn.execute(
            "select status, extract(epoch from run_after - now())::int from jobs where id = %s",
            (job_id,),
        ).fetchone()
        if attempt < 4:
            assert outcome == "queued"
            assert row[0] == "queued"
            delays.append(row[1])
            # Put it back in the past so the next attempt can be claimed now.
            conn.execute("update jobs set run_after = now() where id = %s", (job_id,))
        else:
            assert outcome == "failed"
            assert row[0] == "failed"

    assert [round(d / 60) for d in delays] == [2, 8, 30]
    status, attempts, error = _status(conn, job_id)
    assert (status, attempts) == ("failed", 4)
    assert "TimeoutError" in error
    assert queue.claim(conn, kinds=[kind]) is None, "a failed job must not be claimed again"


def test_the_stored_error_is_redacted_and_truncated(conn: psycopg.Connection):
    kind = unique_kind("redact_")
    job_id = queue.enqueue(conn, kind, unique_key("redact-"))
    job = queue.claim(conn, kinds=[kind])
    assert job is not None
    secret = "postgresql://app:hunter2@ep-x.neon.tech/licitaqui"
    queue.mark_failed(conn, job, f"OperationalError: could not connect to {secret} " + "x" * 5000)

    _, _, error = _status(conn, job_id)
    assert "hunter2" not in error
    assert "app:***@" in error
    assert len(error) == queue.ERROR_MAX_CHARS


# -- housekeeping ---------------------------------------------------------


def test_a_job_abandoned_by_a_dead_consumer_is_requeued(conn: psycopg.Connection):
    kind = unique_kind("stale_")
    job_id = queue.enqueue(conn, kind, unique_key("stale-"))
    claimed = queue.claim(conn, kinds=[kind])
    assert claimed is not None

    fresh = queue.requeue_stale(conn, older_than_seconds=3600, kinds=[kind])
    assert fresh == 0, "a fresh job is not stale"

    conn.execute("update jobs set updated_at = now() - interval '2 hours' where id = %s", (job_id,))
    assert queue.requeue_stale(conn, older_than_seconds=3600, kinds=[kind]) == 1

    again = queue.claim(conn, kinds=[kind])
    assert again is not None and again.id == job_id
    assert again.attempts == 2, "the wasted attempt still counts towards the budget"


def test_requeue_stale_can_be_limited_to_one_consumers_kinds(conn: psycopg.Connection):
    mine, other = unique_kind("sweep_a_"), unique_kind("sweep_b_")
    for kind in (mine, other):
        queue.enqueue(conn, kind, unique_key("sweep-"))
        queue.claim(conn, kinds=[kind])
    conn.execute(
        "update jobs set updated_at = now() - interval '2 hours' where kind = any(%s)",
        ([mine, other],),
    )

    assert queue.requeue_stale(conn, older_than_seconds=3600, kinds=[mine]) == 1
    assert _kind_status(conn, other) == "running", "another consumer's job was touched"
    assert queue.requeue_stale(conn, older_than_seconds=3600, kinds=[other]) == 1


def _kind_status(conn: psycopg.Connection, kind: str) -> str:
    return conn.execute("select status from jobs where kind = %s", (kind,)).fetchone()[0]


def test_mark_failed_is_a_pure_function_of_the_attempt_count(conn: psycopg.Connection):
    """A short backoff can be injected, which is what the consumer test uses."""
    kind = unique_kind("inject_")
    queue.enqueue(conn, kind, unique_key("inject-"))
    job = queue.claim(conn, kinds=[kind])
    assert job is not None
    assert queue.mark_failed(conn, job, "boom", max_attempts=1, backoff=(0,)) == "failed"


def test_job_is_a_plain_value_object():
    job = Job(id=1, kind="noop", key="k", priority=5, payload=None, attempts=0)
    with pytest.raises(AttributeError):
        job.id = 2  # type: ignore[misc]
