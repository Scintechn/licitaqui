"""Acceptance criterion 3 (part one), without a database.

What must be true for the Neon compute to suspend: while the queue is empty the
consumer holds no connection and issues no query, and it reopens one only once
per poll interval. Here that is measured against an instrumented connection
factory; ``test_integration_consumer.py`` repeats it against the real database
by looking the worker up in ``pg_stat_activity``.
"""

from __future__ import annotations

import threading
import time
from contextlib import contextmanager

import pytest

from licitaqui import consumer as consumer_module
from licitaqui.consumer import Consumer, WakeSignal


class TrackingFactory:
    """Counts connections and how long any of them stayed open."""

    def __init__(self) -> None:
        self.opened = 0
        self.closed = 0
        self.open_seconds = 0.0
        self.claims = 0

    def __call__(self):
        return self._session()

    @contextmanager
    def _session(self):
        self.opened += 1
        started = time.monotonic()
        try:
            yield object()
        finally:
            self.open_seconds += time.monotonic() - started
            self.closed += 1

    @property
    def open_now(self) -> int:
        return self.opened - self.closed


@pytest.fixture
def empty_queue(monkeypatch: pytest.MonkeyPatch) -> TrackingFactory:
    factory = TrackingFactory()

    def claim(_conn, **_kwargs):
        factory.claims += 1
        return None

    monkeypatch.setattr(consumer_module.queue, "claim", claim)
    monkeypatch.setattr(consumer_module.queue, "requeue_stale", lambda _conn, **_kw: 0)
    return factory


def _run_for(consumer: Consumer, seconds: float) -> float:
    thread = threading.Thread(target=consumer.run, daemon=True)
    started = time.monotonic()
    thread.start()
    time.sleep(seconds)
    consumer.stop.set()
    consumer.wake.notify()
    thread.join(timeout=5)
    assert not thread.is_alive()
    return time.monotonic() - started


def test_idle_holds_no_connection_and_polls_once_per_interval(empty_queue: TrackingFactory):
    poll = 0.25
    consumer = Consumer(empty_queue, poll_interval=poll, stale_after=0)
    elapsed = _run_for(consumer, 1.0)

    assert empty_queue.open_now == 0, "a connection was still open when the loop stopped"
    assert empty_queue.opened == empty_queue.closed
    # One drain per poll interval, not a hot loop.
    assert empty_queue.opened <= int(elapsed / poll) + 2
    assert empty_queue.claims == empty_queue.opened
    # And the connection existed for a negligible slice of the idle period.
    assert empty_queue.open_seconds < elapsed * 0.05


def test_the_default_consumer_waits_two_minutes_between_polls(empty_queue: TrackingFactory):
    """With the production poll interval, one second of idling means one poll."""
    consumer = Consumer(empty_queue, stale_after=0)
    assert consumer.poll_interval == 120.0
    _run_for(consumer, 1.0)
    assert empty_queue.opened == 1
    assert empty_queue.open_now == 0


def test_a_wake_cuts_the_poll_short(empty_queue: TrackingFactory):
    wake = WakeSignal()
    consumer = Consumer(empty_queue, poll_interval=120.0, wake=wake, stale_after=0)
    thread = threading.Thread(target=consumer.run, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 2
        while empty_queue.opened < 1 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert empty_queue.opened == 1

        started = time.monotonic()
        wake.notify()
        while empty_queue.opened < 2 and time.monotonic() - started < 5:
            time.sleep(0.005)
        assert empty_queue.opened == 2, "the wake did not interrupt the 2-minute poll"
        assert time.monotonic() - started < 1.0
    finally:
        consumer.stop.set()
        wake.notify()
        thread.join(timeout=5)


def test_a_database_failure_pauses_instead_of_spinning(monkeypatch: pytest.MonkeyPatch):
    attempts = []

    def failing_factory():
        attempts.append(time.monotonic())
        raise OSError("connection refused")

    consumer = Consumer(failing_factory, poll_interval=5.0, error_pause=0.2, stale_after=0)
    _run_for(consumer, 0.7)

    assert len(attempts) >= 2, "the loop should retry after the error pause"
    assert len(attempts) <= 6, "the loop must not hammer a database that is down"
