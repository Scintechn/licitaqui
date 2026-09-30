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
from tests.test_config import NEON_SUSPEND_SECONDS


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


def test_the_default_consumer_polls_far_less_often_than_neon_suspends(
    empty_queue: TrackingFactory,
):
    """With the production poll interval, one second of idling means one poll.

    This used to pin 120 s. That number is what kept the Neon compute awake
    24/7: its suspend timer needs 300 s with no connections, and reconnecting
    every 120 s reset it forever (see `config.DEFAULT_POLL_INTERVAL_SECONDS`).
    The assertion now pins the relationship rather than the number, so raising
    the interval again does not require editing this test, and *lowering* it
    below the suspend timer does.
    """
    consumer = Consumer(empty_queue, stale_after=0)
    assert consumer.poll_interval > NEON_SUSPEND_SECONDS
    _run_for(consumer, 1.0)
    # Exactly one drain: the loop works before it waits, so a long interval
    # means the second poll is far beyond this test's one second.
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


def test_a_busy_drain_opens_one_connection_for_the_whole_batch(
    monkeypatch: pytest.MonkeyPatch,
):
    """**One connection per drain, never one per job** — card B28.

    Neon bills wall-clock awake time, and the suspend tail is **five minutes
    with no way to shorten it**: 300 s is the floor on Launch, verified by the
    API refusing 60, 90, 120, 180 and 240 s with *"suspend interval is too
    short for your plan"*. So a connection per job would not release the
    endpoint between jobs — it would buy ten thousand five-minute tails while
    the endpoint stayed up anyway.

    That makes `drain()`'s single `with self.connect()` a **cost decision**,
    not a style one, and nothing else in the suite would notice if somebody
    moved the `with` inside the loop to "hold connections for less time". It
    reads like an improvement and is the expensive shape.

    What actually shortens the awake window is finishing sooner, which is
    `DEFAULT_CONCURRENCY` — see `config.py`.
    """
    factory = TrackingFactory()
    jobs = list(range(25))

    def claim(_conn, **_kwargs):
        factory.claims += 1
        return jobs.pop() if jobs else None

    monkeypatch.setattr(consumer_module.queue, "claim", claim)
    monkeypatch.setattr(consumer_module.queue, "requeue_stale", lambda _conn, **_kw: 0)

    consumer = Consumer(factory, stale_after=0)
    monkeypatch.setattr(consumer, "execute", lambda _conn, _job: None)

    processed = consumer.drain()

    assert processed == 25
    assert factory.opened == 1, (
        "drain must hold one connection for the whole batch; a connection per "
        "job buys a five-minute Neon tail each and shortens nothing"
    )
    assert factory.open_now == 0, "the drain must close its connection when it ends"
