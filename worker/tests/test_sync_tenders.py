"""The parts of the sweep that are pure functions: the window and the scope.

Everything that needs a row lives in ``test_integration_sync_tenders.py``.
"""

from __future__ import annotations

from datetime import date

from licitaqui.scheduler import DEFAULT_SCHEDULE
from licitaqui.sync_tenders import MAX_WINDOW_DAYS, plan_window, scope_key

TODAY = date(2026, 9, 17)


# -- the window ------------------------------------------------------------


def test_a_first_run_reaches_back_one_day():
    assert plan_window(None, TODAY) == (date(2026, 9, 16), TODAY)


def test_a_first_run_can_be_told_to_reach_further():
    assert plan_window(None, TODAY, lookback_days=3) == (date(2026, 9, 14), TODAY)


def test_the_window_restarts_at_the_last_cycles_end_not_the_day_after():
    """The last cycle only swept that day up to the moment it ran.

    Starting at the day *after* the watermark would silently drop every update
    PNCP recorded during the rest of it. Re-sweeping the day costs nothing: the
    upsert writes nothing for a record whose timestamp has not moved.
    """
    assert plan_window(date(2026, 9, 16), TODAY) == (date(2026, 9, 16), TODAY)


def test_consecutive_cycles_on_the_same_day_sweep_the_same_single_day():
    assert plan_window(TODAY, TODAY) == (TODAY, TODAY)


def test_a_long_outage_is_drained_over_several_cycles_not_one_huge_job():
    """A fortnight of downtime must not become one job that cannot finish."""
    start, end = plan_window(date(2026, 9, 1), TODAY)
    assert start == date(2026, 9, 1)
    assert end == date(2026, 9, 7)
    assert (end - start).days + 1 == MAX_WINDOW_DAYS

    # …and the next cycle picks up from there, until it catches up.
    start, end = plan_window(end, TODAY)
    assert (start, end) == (date(2026, 9, 7), date(2026, 9, 13))
    assert plan_window(date(2026, 9, 13), TODAY) == (date(2026, 9, 13), TODAY)


def test_a_watermark_from_the_future_is_clamped_to_today():
    """A clock skew must not produce dataInicial > dataFinal."""
    start, end = plan_window(date(2026, 12, 25), TODAY)
    assert start == TODAY
    assert end == TODAY
    assert start <= end


# -- the scope -------------------------------------------------------------


def test_scope_distinguishes_sweeps_that_must_not_share_a_watermark():
    assert scope_key(None, (6, 8, 4)) == "BR:4,6,8"
    assert scope_key("sp", (6, 8, 4)) == "SP:4,6,8"
    assert scope_key(None, (6,)) != scope_key(None, (6, 8, 4))


def test_scope_does_not_depend_on_the_order_modalities_were_written_in():
    assert scope_key("SP", (8, 4, 6)) == scope_key("SP", (4, 6, 8))


# -- the schedule ----------------------------------------------------------


def test_the_sweep_is_scheduled_every_thirty_minutes():
    """§7.1. B1 left DEFAULT_SCHEDULE empty for this entry."""
    entries = [e for e in DEFAULT_SCHEDULE if e.kind == "sync_open_tenders"]
    assert len(entries) == 1
    assert entries[0].every_seconds == 30 * 60
    assert entries[0].priority == 5


def test_the_scheduled_sweep_carries_no_window_of_its_own():
    """The window comes from the watermark, so a tick cannot pin a stale one."""
    entry = next(e for e in DEFAULT_SCHEDULE if e.kind == "sync_open_tenders")
    assert entry.payload is None


def test_two_ticks_in_the_same_minute_produce_one_key():
    """The dedupe index turns a duplicated tick during a deploy into one job."""
    from datetime import UTC, datetime

    entry = next(e for e in DEFAULT_SCHEDULE if e.kind == "sync_open_tenders")
    due = datetime(2026, 9, 17, 12, 30, tzinfo=UTC)
    assert entry.key(due) == entry.key(due)
    assert entry.key(due) != entry.key(datetime(2026, 9, 17, 13, 0, tzinfo=UTC))


def test_the_handler_is_registered_under_the_name_the_schedule_uses():
    from licitaqui import sync_tenders  # noqa: F401 - the import is the registration
    from licitaqui.registry import REGISTRY

    assert "sync_open_tenders" in REGISTRY.kinds()
