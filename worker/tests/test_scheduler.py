"""The scheduler only creates jobs, on a cadence, with deduplicating keys."""

from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from licitaqui import scheduler as scheduler_module
from licitaqui.scheduler import DEFAULT_SCHEDULE, ScheduleEntry, Scheduler

UTC = ZoneInfo("UTC")
BRT = ZoneInfo("America/Sao_Paulo")


class FakeQueue:
    """Records enqueue calls and emulates the partial unique dedupe index."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, int]] = []
        self.live: set[tuple[str, str]] = set()
        self.connections = 0

    @contextmanager
    def connect(self):
        self.connections += 1
        yield object()

    def enqueue(self, _conn, kind, key, *, priority=5, payload=None):
        self.calls.append((kind, key, priority))
        if (kind, key) in self.live:
            return None
        self.live.add((kind, key))
        return len(self.calls)


@pytest.fixture
def fake_queue(monkeypatch: pytest.MonkeyPatch) -> FakeQueue:
    fake = FakeQueue()
    monkeypatch.setattr(scheduler_module.queue, "enqueue", fake.enqueue)
    return fake


def test_the_schedule_holds_only_the_collector_jobs_that_exist():
    """B1 shipped an empty schedule; B2 added its sweep, B8 the nightly awards
    one, E1 the Monday digest, and the short titles their hourly one.

    B3 and B4 do not appear at all: they are enqueued per changed tender by the
    sweep, not on a clock. `sweep_titles` is the opposite case and is on the
    clock deliberately — a title also goes stale when the *items* change, which
    a tender-level follow-up would never see.

    The property this guards is that the scheduler never enqueues a kind
    nothing can run — every such row would burn four attempts before landing in
    `failed` — so the list is checked against the registry below rather than
    only against itself.
    """
    from licitaqui import handlers
    from licitaqui.registry import REGISTRY

    assert [entry.kind for entry in DEFAULT_SCHEDULE] == [
        "sync_open_tenders",
        "sync_awards",
        # B17's inventory sweep. It sits beside `sync_open_tenders` rather than
        # replacing it because the two ask different questions: that one reads
        # a change feed and is the only thing that can see an amendment or a
        # suspension; this one asks what is open and is the only thing that can
        # see an edital published once and never touched again — 54 of the 72
        # misses B17 measured were exactly that.
        "reconcile_open_tenders",
        "sweep_titles",
        "weekly_digest",
        # `sweep_tender_values` is on the clock for the same reason
        # `sweep_titles` is, and a sharper one: the per-tender follow-up that
        # would otherwise cover it is enqueued by the search fallback, which
        # fires exactly when `/api/consulta` is down — so that follow-up
        # usually fails, and only a sweep comes back for the row.
        "sweep_tender_values",
    ]
    assert handlers.registered_kinds()  # importing handlers is what completes the registry
    assert {entry.kind for entry in DEFAULT_SCHEDULE} <= set(REGISTRY.kinds())


def test_an_entry_needs_exactly_one_cadence():
    with pytest.raises(ValueError, match="exactly one"):
        ScheduleEntry(kind="x")
    with pytest.raises(ValueError, match="exactly one"):
        ScheduleEntry(kind="x", every_seconds=60, daily_at="07:00")


def test_interval_entries_fall_on_fixed_buckets():
    entry = ScheduleEntry(kind="sync_open_tenders", every_seconds=1800)
    after = datetime(2026, 9, 17, 10, 5, 13, tzinfo=UTC)
    assert entry.next_due(after) == datetime(2026, 9, 17, 10, 30, tzinfo=UTC)


def test_daily_entries_use_brazilian_wall_clock_time():
    entry = ScheduleEntry(kind="weekly_alerts", daily_at="07:00")
    after = datetime(2026, 9, 17, 12, 0, tzinfo=UTC)  # 09:00 BRT, already past 07:00
    due = entry.next_due(after)
    assert due.astimezone(BRT).strftime("%Y-%m-%d %H:%M") == "2026-09-18 07:00"


def test_nothing_due_means_no_connection_is_opened(fake_queue: FakeQueue):
    now = datetime(2026, 9, 17, 10, 0, tzinfo=UTC)
    entry = ScheduleEntry(kind="sync_open_tenders", every_seconds=1800)
    scheduler = Scheduler(fake_queue.connect, entries=(entry,), now=lambda: now)

    assert scheduler.tick() == 0
    assert fake_queue.connections == 0, "an idle scheduler must not keep Neon awake"


def test_a_due_entry_is_enqueued_once_per_bucket(fake_queue: FakeQueue):
    clock = {"now": datetime(2026, 9, 17, 10, 0, tzinfo=UTC)}
    entry = ScheduleEntry(kind="sync_open_tenders", every_seconds=1800, priority=5)
    scheduler = Scheduler(fake_queue.connect, entries=(entry,), now=lambda: clock["now"])

    clock["now"] += timedelta(minutes=31)
    assert scheduler.tick() == 1
    assert scheduler.tick() == 0, "the same bucket must not be enqueued twice"

    clock["now"] += timedelta(minutes=31)
    assert scheduler.tick() == 1
    assert [call[0] for call in fake_queue.calls] == ["sync_open_tenders"] * 2
    assert len({call[1] for call in fake_queue.calls}) == 2


def test_two_schedulers_produce_the_same_key_so_the_index_dedupes(fake_queue: FakeQueue):
    """A second scheduler during a deploy must not double every sync."""
    start = datetime(2026, 9, 17, 10, 0, tzinfo=UTC)
    later = start + timedelta(minutes=31)
    entry = ScheduleEntry(kind="cleanup", every_seconds=1800)

    for _ in range(2):
        scheduler = Scheduler(fake_queue.connect, entries=(entry,), now=lambda: start)
        scheduler._due["cleanup"] = start
        scheduler.now = lambda: later
        scheduler.tick()

    assert len(fake_queue.calls) == 2
    assert len({call[1] for call in fake_queue.calls}) == 1, "keys must collide"
    assert len(fake_queue.live) == 1, "the dedupe index keeps a single live job"


def test_a_tick_that_enqueues_notifies_the_consumers(fake_queue: FakeQueue):
    """One wake window per cycle, not two — the 2026-09-30 compute change.

    The scheduler and the consumers are two independent reasons to open a
    connection, and Neon suspends after five minutes without one, so every wake
    costs a five-minute tail whether or not there is work in it. Unsynchronised
    they cost two tails an hour *and* leave the work waiting up to a poll
    interval to start.

    This notify is also what makes `DEFAULT_POLL_INTERVAL_SECONDS = 3600` safe:
    scheduled work is no longer discovered by polling, so the poll became a
    safety net rather than the mechanism. Without it, raising the interval is
    the silent degradation `config.py` warns about — an hourly sync quietly
    becoming two-hourly.
    """
    woken: list[int] = []
    clock = {"now": datetime(2026, 9, 17, 10, 0, tzinfo=UTC)}
    entry = ScheduleEntry(kind="sync_open_tenders", every_seconds=1800, priority=5)
    scheduler = Scheduler(
        fake_queue.connect,
        entries=(entry,),
        now=lambda: clock["now"],
        on_enqueue=lambda: woken.append(1),
    )

    clock["now"] += timedelta(minutes=31)
    assert scheduler.tick() == 1
    assert woken == [1], "a tick that enqueued work must start the consumers"


def test_a_tick_with_nothing_due_notifies_nobody(fake_queue: FakeQueue):
    """A notify is a wake. Sending one for an empty tick would spend the very
    five-minute tail this mechanism exists to avoid."""
    woken: list[int] = []
    clock = {"now": datetime(2026, 9, 17, 10, 0, tzinfo=UTC)}
    entry = ScheduleEntry(kind="sync_open_tenders", every_seconds=1800, priority=5)
    scheduler = Scheduler(
        fake_queue.connect,
        entries=(entry,),
        now=lambda: clock["now"],
        on_enqueue=lambda: woken.append(1),
    )
    clock["now"] += timedelta(minutes=31)
    scheduler.tick()
    woken.clear()

    assert scheduler.tick() == 0
    assert woken == []
