"""How long a person waited before their job started — card **B30**.

On 2026-09-30 two `ai_screening` jobs sat queued for **24 minutes** while
somebody watched *"a triagem está demorando mais que o normal"*. Nothing was
red. The worker was healthy, the queue was draining, every test passed — the
wake simply was not being sent, and the only thing that noticed was Sci
looking at a spinner.

*"Triage is available anytime"* was an opinion until this row existed.
"""

from __future__ import annotations

from typing import Any

from licitaqui.consumer import Consumer
from licitaqui.queue import Job


class FakeCursor:
    def __init__(self, sink: list[tuple[str, Any]]) -> None:
        self.sink = sink

    def execute(self, sql: str, params: Any = None) -> None:
        self.sink.append((sql, params))

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, *_a: Any) -> None:
        return None


class FakeConn:
    def __init__(self, fail: bool = False) -> None:
        self.writes: list[tuple[str, Any]] = []
        self.fail = fail

    def cursor(self) -> FakeCursor:
        if self.fail:
            raise RuntimeError("no cursor for you")
        return FakeCursor(self.writes)


def job(priority: int, waited: float = 12.5) -> Job:
    return Job(
        id=1,
        kind="ai_screening",
        key="k",
        priority=priority,
        payload=None,
        attempts=1,
        waited_seconds=waited,
    )


def consumer() -> Consumer:
    return Consumer(lambda: None, stale_after=0)  # type: ignore[arg-type]


def test_it_records_the_wait_for_a_job_somebody_is_watching():
    conn = FakeConn()
    consumer()._record_wait(conn, job(priority=1))

    assert len(conn.writes) == 1
    sql, params = conn.writes[0]
    assert "insert into events" in sql
    assert params[0] == "job_claim_latency"
    props = params[1].obj
    assert props["waited_seconds"] == 12.5
    assert props["kind"] == "ai_screening"


def test_it_records_nothing_for_background_work():
    """A row per claim across every kind would be an insert per job, and the
    backlog of 2026-09-30 was 10,758 of them. At priority 1 it is a handful a
    day — which is what makes measuring it free."""
    conn = FakeConn()
    consumer()._record_wait(conn, job(priority=5))
    consumer()._record_wait(conn, job(priority=9))

    assert conn.writes == []


def test_a_failed_metric_never_stops_the_queue():
    """A metric that can stop a queue draining is worse than no metric."""
    conn = FakeConn(fail=True)
    consumer()._record_wait(conn, job(priority=1))  # must not raise


def test_the_wait_comes_from_the_database_clock_not_ours():
    """`CLAUDE.md`'s clocks rule: on 2026-09-23 a worker was declared stalled
    for an hour because a database `now()` was read against a laptop clock. It
    was six minutes. So the claim computes `now() - created_at` in SQL and the
    worker only carries the answer."""
    from licitaqui.queue import CLAIM_SQL

    assert "extract(epoch from (now() - created_at))" in CLAIM_SQL
    assert "datetime.now" not in CLAIM_SQL


def test_the_priority_matches_the_web_apps_constant():
    """`PRIORITY_USER_WAITING = 1` in `apps/web/lib/jobs/index.ts`. If the two
    drift, this records the wrong population silently."""
    from pathlib import Path

    web = Path(__file__).resolve().parents[2] / "apps/web/lib/jobs/index.ts"
    source = web.read_text(encoding="utf-8")
    assert "export const PRIORITY_USER_WAITING = 1" in source
    assert Consumer.USER_WAITING_PRIORITY == 1
