"""The consumer, the idle loop and `/wake` against the real database.

Covers acceptance criteria 2, 3 and 4:

- a failing job retries 4× then goes to `failed`, driven by the real consumer;
- while idle the worker has no session in ``pg_stat_activity``, which is the
  precondition for the Neon compute suspending (§5.1);
- ``POST /wake`` makes a priority-1 job run in well under 5 s instead of
  waiting out the 2-minute poll.

Each test gives its consumer a job kind of its own, because the test database
is shared with other tasks' test runs.

Skipped when TEST_DATABASE_URL is not configured.
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from http.client import HTTPConnection

import psycopg
import pytest

from licitaqui import db, queue
from licitaqui.consumer import Consumer
from licitaqui.jobs import noop
from licitaqui.registry import JobRegistry
from licitaqui.service import WorkerService
from tests.conftest import unique_key, unique_kind

WAKE_TOKEN = "integration-test-token"  # noqa: S105 - local test server only


def _wait_for(predicate, timeout: float, interval: float = 0.05) -> float:
    """Block until ``predicate()`` is true. Returns the seconds it took."""
    started = time.monotonic()
    while time.monotonic() - started < timeout:
        if predicate():
            return time.monotonic() - started
        time.sleep(interval)
    raise AssertionError(f"condition not met within {timeout}s")


def _job_row(dsn: str, job_id: int) -> tuple[str, int, str | None]:
    with psycopg.connect(dsn, autocommit=True, connect_timeout=15) as conn:
        row = conn.execute(
            "select status, attempts, error from jobs where id = %s", (job_id,)
        ).fetchone()
    assert row is not None
    return row[0], row[1], row[2]


# -- criterion 2: 4 attempts then failed -----------------------------------


def test_the_consumer_retries_four_times_then_gives_up(clean_dsn: str, connect, conn):
    """End to end through Consumer.run, with the backoff shortened to zero.

    The four attempts and the `failed` terminal state are the real behaviour;
    only the 2/8/30-minute waits are replaced, so the test takes a second
    instead of forty minutes. test_integration_queue.py asserts the real delays.
    """
    kind = unique_kind("fails_")
    registry = JobRegistry()
    attempts: list[int] = []

    @registry.job(kind)
    def handler(ctx):
        attempts.append(ctx.job.attempts)
        raise TimeoutError("PNCP detail timed out after 30s")

    job_id = queue.enqueue(conn, kind, unique_key("consumer-retry-"), priority=1)
    consumer = Consumer(
        connect,
        registry=registry,
        kinds=[kind],
        poll_interval=0.05,
        backoff=(0, 0, 0),
        stale_after=0,
    )
    thread = threading.Thread(target=consumer.run, daemon=True)
    thread.start()
    try:
        _wait_for(lambda: _job_row(clean_dsn, job_id)[0] == "failed", timeout=30)
    finally:
        consumer.stop.set()
        consumer.wake.notify()
        thread.join(timeout=10)

    status, stored_attempts, error = _job_row(clean_dsn, job_id)
    assert attempts == [1, 2, 3, 4], "the handler must be tried exactly four times"
    assert (status, stored_attempts) == ("failed", 4)
    assert "TimeoutError: PNCP detail timed out after 30s" in error
    assert consumer.metrics.snapshot()["failed"] == 1
    assert consumer.metrics.snapshot()["retried"] == 3


def test_a_successful_job_is_marked_done(clean_dsn: str, connect, conn):
    kind = unique_kind("ok_")
    registry = JobRegistry()
    seen: list[dict] = []

    @registry.job(kind)
    def handler(ctx):
        seen.append(ctx.payload)

    job_id = queue.enqueue(conn, kind, unique_key("consumer-ok-"), payload={"uf": "SP"})
    consumer = Consumer(connect, registry=registry, kinds=[kind], stale_after=0)
    assert consumer.drain() == 1

    assert seen == [{"uf": "SP"}]
    assert _job_row(clean_dsn, job_id)[0] == "done"


def test_an_unregistered_kind_fails_the_job_instead_of_crashing_the_loop(
    clean_dsn: str, connect, conn
):
    kind = unique_kind("unknown_")
    job_id = queue.enqueue(conn, kind, unique_key("unknown-"))
    consumer = Consumer(connect, registry=JobRegistry(), kinds=[kind], stale_after=0)
    assert consumer.drain() == 1

    status, attempts, error = _job_row(clean_dsn, job_id)
    assert (status, attempts) == ("queued", 1), "an unknown kind is retried, not dropped"
    assert "no handler registered" in error


def test_a_consumer_only_claims_the_kinds_it_is_responsible_for(clean_dsn: str, connect, conn):
    mine, other = unique_kind("mine_"), unique_kind("other_")
    registry = JobRegistry()
    registry.register(mine, noop)
    registry.register(other, noop)

    mine_id = queue.enqueue(conn, mine, unique_key("split-a-"))
    other_id = queue.enqueue(conn, other, unique_key("split-b-"))

    assert Consumer(connect, registry=registry, kinds=[mine], stale_after=0).drain() == 1
    assert _job_row(clean_dsn, mine_id)[0] == "done"
    assert _job_row(clean_dsn, other_id)[0] == "queued"


# -- criterion 3: nothing connected while idle -----------------------------


def _sessions(dsn: str, application_name: str) -> int:
    with psycopg.connect(dsn, autocommit=True, connect_timeout=15) as conn:
        row = conn.execute(
            "select count(*) from pg_stat_activity where application_name = %s",
            (application_name,),
        ).fetchone()
    return int(row[0])


def test_an_idle_consumer_keeps_no_session_open(clean_dsn: str):
    """What lets the Neon compute suspend: no connection, no query, while idle.

    This proves the worker's side of it. It does not prove that Neon actually
    suspended — that needs five idle minutes and the Neon console.
    """
    application_name = f"licitaqui-idle-{uuid.uuid4().hex[:8]}"
    consumer = Consumer(
        db.factory(clean_dsn, application_name=application_name),
        kinds=[unique_kind("idle_")],
        poll_interval=60.0,
        stale_after=0,
    )
    thread = threading.Thread(target=consumer.run, daemon=True)
    thread.start()
    try:
        _wait_for(lambda: consumer.metrics.snapshot()["drains"] >= 1, timeout=30)
        samples = [_sessions(clean_dsn, application_name) for _ in _every(0.4, times=4)]
        assert samples == [0, 0, 0, 0], f"the idle worker held a session open: {samples}"
    finally:
        consumer.stop.set()
        consumer.wake.notify()
        thread.join(timeout=10)

    assert _sessions(clean_dsn, application_name) == 0
    assert consumer.metrics.snapshot()["drains"] == 1, "one poll only, over ~2 s of idling"


def _every(seconds: float, *, times: int):
    for index in range(times):
        if index:
            time.sleep(seconds)
        yield index


# -- criterion 4: /wake picks a priority-1 job in under 5 s ----------------


@pytest.fixture
def wake_kind() -> str:
    return unique_kind("wake_")


@pytest.fixture
def service(clean_dsn: str, wake_kind: str):
    registry = JobRegistry()
    registry.register(wake_kind, noop)  # the built-in handler, under a private kind
    worker = WorkerService(
        dsn=clean_dsn,
        wake_token=WAKE_TOKEN,
        host="127.0.0.1",
        port=0,
        concurrency=1,
        poll_interval=120.0,  # the production interval: only a wake can beat it
        scheduler_enabled=False,
        registry=registry,
        kinds=(wake_kind,),
    )
    worker.start()
    try:
        yield worker
    finally:
        worker.shutdown(timeout=10)


def _post_wake(port: int, token: str | None) -> int:
    conn = HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        headers = {"Content-Length": "0"}
        if token:
            headers["Authorization"] = f"Bearer {token}"
        conn.request("POST", "/wake", headers=headers)
        return conn.getresponse().status
    finally:
        conn.close()


def _health(port: int) -> dict:
    http = HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        http.request("GET", "/health")
        return json.loads(http.getresponse().read())
    finally:
        http.close()


def _wait_until_idle(port: int) -> None:
    """Block until the worker has finished a pass and is back in its poll wait."""
    _wait_for(lambda: _health(port)["jobs"]["drains"] >= 1, timeout=30)


def test_wake_runs_a_priority_one_job_in_under_five_seconds(
    clean_dsn: str, service, wake_kind, conn
):
    port = service._http.port
    _wait_until_idle(port)

    # The worker is now idle in its 120 s poll: a job enqueued here stays queued.
    control = queue.enqueue(conn, wake_kind, unique_key("wake-control-"), priority=5)
    time.sleep(2.0)
    assert _status(conn, control) == "queued", "the worker was not actually asleep"

    job_id = queue.enqueue(conn, wake_kind, unique_key("wake-p1-"), priority=1)
    posted_at = conn.execute("select now()").fetchone()[0]
    started = time.monotonic()
    assert _post_wake(port, WAKE_TOKEN) == 202
    _wait_for(lambda: _status(conn, job_id) == "done", timeout=10)
    wall_clock = time.monotonic() - started

    # The database clock brackets the worker alone; the wall clock also carries
    # this test's polling, which opens no connection of its own but still waits.
    finished_at = conn.execute("select updated_at from jobs where id = %s", (job_id,)).fetchone()[0]
    latency = (finished_at - posted_at).total_seconds()

    assert latency < 5.0, f"the priority-1 job took {latency:.2f}s"
    assert wall_clock < 5.0, f"observed end to end in {wall_clock:.2f}s"
    assert _job_row(clean_dsn, job_id)[1] == 1, "it should succeed on the first attempt"
    print(
        f"\n/wake -> priority-1 job done {latency:.3f}s after the call"
        f" (observed {wall_clock:.3f}s; the idle poll interval is 120s)"
    )


def _status(conn, job_id: int) -> str:
    """Status via the test's own connection, so polling adds no connect cost."""
    return conn.execute("select status from jobs where id = %s", (job_id,)).fetchone()[0]


def test_an_unauthenticated_wake_leaves_the_worker_asleep(clean_dsn: str, service, wake_kind, conn):
    port = service._http.port
    _wait_until_idle(port)
    job_id = queue.enqueue(conn, wake_kind, unique_key("wake-unauth-"), priority=1)

    assert _post_wake(port, None) == 401
    assert _post_wake(port, "wrong-token") == 401
    time.sleep(2.0)
    assert _status(conn, job_id) == "queued", "an unauthorised call must not wake it"


def test_health_reports_a_live_worker_without_querying_the_database(service):
    body = _health(service._http.port)

    assert body["status"] == "ok"
    assert body["consumers"] == {"configured": 1, "alive": 1}
    assert body["poll_interval_seconds"] == 120.0
    assert body["wake_configured"] is True
    assert set(body["jobs"]) == {
        "processed",
        "failed",
        "retried",
        "drains",
        "last_finished_at",
    }
