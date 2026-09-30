"""``neon_usage`` — card **B27**.

The assertions that matter here are about **refusing to invent a number**. The
card this feeds is the one screen whose purpose is warning before Neon stops
the database, and its previous version rendered *338% and a red alert* on a
database in no danger. So: an unreadable API raises rather than writing a zero,
and Neon's own compute figures are not published at all, because on 2026-09-30
they disagreed across endpoints within three hours.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from licitaqui import neon_usage
from licitaqui.neon_usage import SUSPEND_TAIL_SECONDS, NeonUnavailable, awake_windows

NOW = datetime(2026, 9, 30, 12, 0, tzinfo=UTC)


def op(action: str, minutes_ago: int) -> dict[str, Any]:
    return {
        "action": action,
        "created_at": (NOW - timedelta(minutes=minutes_ago)).isoformat().replace("+00:00", "Z"),
    }


class FakeConn:
    def __init__(self) -> None:
        self.writes: list[tuple[str, Any]] = []

    def execute(self, sql: str, params: Any = None):
        self.writes.append((sql, params))
        return self


class _Log:
    def info(self, *_a: Any, **_k: Any) -> None: ...


class FakeCtx:
    def __init__(self, conn: FakeConn, payload: dict[str, Any] | None = None) -> None:
        self.conn = conn
        self.payload = payload or {}
        self.log = _Log()


# -- pairing --------------------------------------------------------------


def test_starts_and_suspends_become_awake_windows():
    since = NOW - timedelta(hours=4)
    ops = [
        op("start_compute", 200),
        op("suspend_compute", 170),
        op("start_compute", 100),
        op("suspend_compute", 80),
    ]

    windows = awake_windows(ops, since, NOW)

    assert [round((b - a).total_seconds() / 60) for a, b, _ in windows] == [30, 20]
    assert not any(live for _, _, live in windows)


def test_a_start_with_no_suspend_means_awake_right_now():
    """Not a gap in the data — the most important thing the card can say."""
    since = NOW - timedelta(hours=4)
    windows = awake_windows([op("start_compute", 45)], since, NOW)

    assert len(windows) == 1
    start, end, live = windows[0]
    assert live is True
    assert end == NOW
    assert round((end - start).total_seconds() / 60) == 45


def test_two_starts_without_a_suspend_keep_the_earlier_one():
    """The awake period began at the first start; counting from the second
    would under-report exactly the thing being measured."""
    since = NOW - timedelta(hours=4)
    windows = awake_windows([op("start_compute", 90), op("start_compute", 60)], since, NOW)

    assert len(windows) == 1
    assert round((windows[0][1] - windows[0][0]).total_seconds() / 60) == 90


def test_a_window_that_began_before_the_period_is_clipped_to_it():
    since = NOW - timedelta(hours=1)
    windows = awake_windows([op("start_compute", 300), op("suspend_compute", 30)], since, NOW)

    assert round((windows[0][1] - windows[0][0]).total_seconds() / 60) == 30


# -- the job --------------------------------------------------------------


def install(
    monkeypatch: pytest.MonkeyPatch, ops: list[dict[str, Any]], storage: int = 1_754_308_608
):
    monkeypatch.setenv("NEON_PROJECT_ID", "proj")
    monkeypatch.setattr(neon_usage, "read_operations", lambda _p, _s: ops)
    monkeypatch.setattr(
        neon_usage, "_get", lambda _p, _q=None: {"project": {"synthetic_storage_size": storage}}
    )


def props_of(conn: FakeConn) -> dict[str, Any]:
    return conn.writes[0][1][1].obj


def test_it_reports_awake_time_and_what_the_tails_cost(monkeypatch: pytest.MonkeyPatch):
    install(monkeypatch, [op("start_compute", 200), op("suspend_compute", 170)])
    conn = FakeConn()

    neon_usage.neon_usage(FakeCtx(conn, {"days": 1}))

    props = props_of(conn)
    assert props["wake_cycles"] == 1
    assert props["awake_seconds"] == 30 * 60
    assert props["suspend_tail_seconds"] == SUSPEND_TAIL_SECONDS
    assert props["tail_hours_per_day"] == pytest.approx(SUSPEND_TAIL_SECONDS / 3600, abs=0.01)
    assert props["project_storage_bytes"] == 1_754_308_608
    assert props["awake_now"] is False


def test_it_publishes_no_CU_hours_at_all(monkeypatch: pytest.MonkeyPatch):
    """**The point of the card.**

    Neon's console said 57.08 CU-h while its API said 19.25 and then 0, inside
    three hours, and `consumption_history` is Scale-only. A figure on this
    screen that contradicts Neon's own billing page is the defect B27 was
    opened for. The absence is deliberate and is stated in the row, so nobody
    reads it as an oversight and fills it in from an endpoint that disagrees
    with itself.
    """
    install(monkeypatch, [op("start_compute", 60), op("suspend_compute", 30)])
    conn = FakeConn()

    neon_usage.neon_usage(FakeCtx(conn, {"days": 1}))

    props = props_of(conn)
    assert props["compute_cu_hours"] is None
    assert "disagreed" in props["compute_note"]
    assert not any("cu_hours" in k and props[k] for k in props)


def test_an_empty_operations_log_raises_rather_than_writing_a_zero(
    monkeypatch: pytest.MonkeyPatch,
):
    """`0 h awake` read from a failed request is a measurement of our own
    request. Same rule as `coverage_check`, same reason."""
    install(monkeypatch, [])
    conn = FakeConn()

    with pytest.raises(NeonUnavailable, match="nothing measured"):
        neon_usage.neon_usage(FakeCtx(conn))

    assert conn.writes == [], "a failed read must leave no row behind"


def test_a_missing_project_id_raises(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("NEON_PROJECT_ID", raising=False)

    with pytest.raises(NeonUnavailable):
        neon_usage.neon_usage(FakeCtx(FakeConn()))


def test_it_is_scheduled_on_the_reconcile_wake_and_not_its_own(
    monkeypatch: pytest.MonkeyPatch,
):
    """A job about the compute bill must not open a wake of its own to report
    on wakes. Sharing 04:00 with `reconcile_open_tenders` makes it free."""
    from licitaqui.scheduler import DEFAULT_SCHEDULE

    mine = next(e for e in DEFAULT_SCHEDULE if e.kind == "neon_usage")
    reconcile = next(e for e in DEFAULT_SCHEDULE if e.kind == "reconcile_open_tenders")

    assert mine.daily_at == reconcile.daily_at, (
        "neon_usage must share an existing wake; a daily job of its own costs "
        "a five-minute tail to measure five-minute tails"
    )
    assert mine.every_seconds is None
