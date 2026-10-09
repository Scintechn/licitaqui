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
        # B36's two. They are on the clock **in the same change as their
        # handlers**, because B32 is the alternative: a handler that works, no
        # enqueuer, and a price feed that stopped growing for two days with
        # nobody noticing. The vocabulary is weekly because `statusPdm` flips
        # on the scale of months; the map is daily because new editais arrive
        # daily and an unmapped item shows no price at all, and it makes no API
        # call — measured, the whole open corpus resolves in minutes of CPU.
        "sync_catalog_vocabulary",
        "map_item_codes",
        # B35's price refresh, half an hour behind the map it reads: the sweep
        # orders codes by how many open items point at them, from
        # `tender_item_codes`. Daily although a code only falls due weekly —
        # the per-code cadence lives in `catalog_prices` and a daily sweep
        # spreads the pass instead of bursting it.
        "refresh_catalog_prices",
        "sync_awards",
        # B17's inventory sweep. It sits beside `sync_open_tenders` rather than
        # replacing it because the two ask different questions: that one reads
        # a change feed and is the only thing that can see an amendment or a
        # suspension; this one asks what is open and is the only thing that can
        # see an edital published once and never touched again — 54 of the 72
        # misses B17 measured were exactly that.
        "reconcile_open_tenders",
        # B27, sharing `reconcile_open_tenders`' 04:00 on purpose. It reads
        # Neon's API rather than the database, so its cost is a wake — and a
        # job that opened a wake of its own to report on wakes would be
        # measuring itself. Daily because awake time is a trend.
        "neon_usage",
        "sweep_titles",
        # B17's closure test, standing since 2026-10-05. 05:10 BRT is 70
        # minutes after the inventory it measures (one cycle took about 37
        # minutes — inferred from its 07:37 UTC completion row against this
        # file's 04:00 entry, not timed) and inside the hour
        # `refresh_catalog_prices`' per-code jobs
        # keep the compute awake, so it costs a job slot and not a wake tail.
        # Priority 8 rather than 9 is what stops it queueing behind a thousand
        # of those price jobs and being measured at an unpredictable hour.
        "coverage_check",
        "weekly_digest",
        # **F4's two billing sweeps, on the clock in the same change as their
        # handlers** — B32's rule again. `charge_reminder` is 07:05 BRT, five
        # minutes behind the digest: a civil hour, because an e-mail stamped
        # 04:00 about money is not what anybody wants to find, and on Mondays
        # the wake is already open. `expire_subscriptions` is 03:50, inside the
        # overnight cluster, because it is pure SQL and the boundary it acts on
        # is a date — any hour of the day after `ends_on` is the same answer.
        "charge_reminder",
        "expire_subscriptions",
        # `sweep_tender_values` is on the clock for the same reason
        # `sweep_titles` is, and a sharper one: the per-tender follow-up that
        # would otherwise cover it is enqueued by the search fallback, which
        # fires exactly when `/api/consulta` is down — so that follow-up
        # usually fails, and only a sweep comes back for the row.
        "sweep_tender_values",
        # **E20, twice, and the duplication is the point.** The founders opening
        # is one `jobs` row placed by a person; on 2026-10-03 it was deleted and
        # nothing noticed for two days. 09:00 BRT is three hours before the
        # 12:00 BRT broadcast, so a missing row is still re-placeable on the
        # day; 15:00 BRT is three hours after, so whether it fired is answered
        # the same afternoon. Two entries rather than an interval because
        # `test_config.py` caps an interval entry at the idle poll, and because
        # these two hours are *chosen* against the broadcast rather than spaced
        # — see `scheduler.py`'s comment and `apps/web/lib/admin/opening.ts`,
        # whose 30 h staleness threshold is derived from the 18 h gap between
        # them.
        "opening_broadcast_check",
        "opening_broadcast_check",
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


def test_two_entries_of_one_kind_each_keep_their_own_hour(fake_queue: FakeQueue):
    """**The test that was missing, and the defect it found was live.**

    E20 needs two readings a day of `opening_broadcast_check` — 09:00 BRT, three
    hours before the founders broadcast, and 15:00 BRT, three hours after. Those
    are the first two entries of one kind this schedule has ever held, and
    `Scheduler._due` was keyed by `kind`: the dict comprehension kept the last
    duplicate, `ready` saw both due at once because they shared a value, and the
    loop overwrote the slot twice inside a tick. **The 09:00 run never fired on
    any day** — which on 17/10 is the whole point of E20 gone, because the last
    reading before a 12:00 BRT send would have been 21 h old, and a row deleted
    in between would have shown a green *na fila* straight through the send.

    The suite could not see it. `test_the_schedule_holds_only_the_collector_jobs_that_exist`
    asserts the entry *list*, and `test_opening_check.py` read `daily_at` off the
    two entries and checked its own arithmetic against itself. Neither walks a
    clock past 09:00.

    So this walks one, minute by minute across two days, and asserts the **BRT
    wall-clock hours of the ticks that actually enqueued** — behaviour, not
    declaration. Written against a generic pair of hours rather than E20's, so
    it guards the scheduler for every future caller rather than one card.
    """
    morning = ScheduleEntry(kind="twice_daily", daily_at="09:00", priority=8)
    afternoon = ScheduleEntry(kind="twice_daily", daily_at="15:00", priority=8)
    clock = {"now": datetime(2026, 10, 15, 8, 0, tzinfo=BRT).astimezone(UTC)}
    scheduler = Scheduler(
        fake_queue.connect, entries=(morning, afternoon), now=lambda: clock["now"]
    )

    assert len(scheduler._due) == 2, "each entry needs its own due slot, or one is discarded"

    fired: list[str] = []
    for _ in range(2 * 24 * 60):
        before = len(fake_queue.calls)
        scheduler.tick()
        for _call in fake_queue.calls[before:]:
            fired.append(f"{clock['now'].astimezone(BRT):%d %H:%M}")
        clock["now"] += timedelta(minutes=1)

    # Two full days from 08:00 on the 15th ends at 08:00 on the 17th, so the
    # window holds two complete pairs and stops one hour short of the third
    # morning. Four firings, alternating — which is the proof: before the fix
    # this was `['15 15:00', '15 15:00', '16 15:00', '16 15:00']`, both entries
    # going off together in the same minute and the 09:00 hour never appearing.
    assert fired == [
        "15 09:00",
        "15 15:00",
        "16 09:00",
        "16 15:00",
    ], f"both hours must fire, on their own days: {fired}"
    # Every key distinct, so nothing dedupes away: `ScheduleEntry.key` is the due
    # instant in BRT, which is what makes two entries of one kind safe once they
    # each have a slot of their own.
    assert len({call[1] for call in fake_queue.calls}) == len(fired)


def test_two_schedulers_produce_the_same_key_so_the_index_dedupes(fake_queue: FakeQueue):
    """A second scheduler during a deploy must not double every sync."""
    start = datetime(2026, 9, 17, 10, 0, tzinfo=UTC)
    later = start + timedelta(minutes=31)
    entry = ScheduleEntry(kind="cleanup", every_seconds=1800)

    for _ in range(2):
        scheduler = Scheduler(fake_queue.connect, entries=(entry,), now=lambda: start)
        # Keyed by position since 2026-10-09 — see `Scheduler._due`.
        scheduler._due[0] = start
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
