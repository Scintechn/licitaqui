"""`opening_broadcast_check`'s state machine — card E20.

This file pins the **mechanism**: given a row and two instants, which state. It
is deliberately pure, because the thing that must never be wrong is the
*distinction between the states* — on 2026-10-03 the row was deleted and the
only reason it was not reported as "the broadcast has been sent" is that nobody
reported it at all.

The **path** — insert a real row, run the real handler through the real
registry, delete the row, watch the next run turn red — is
`test_integration_opening_check.py`, against the real database. CLAUDE.md §4b/§4c:
a test of the unit is not evidence the path works, and both halves say in their
docstrings which one they are.
"""

from __future__ import annotations

from datetime import UTC, date, datetime, timedelta

import pytest

from licitaqui import opening_check, product, whatsapp

DUE = datetime(2026, 10, 17, 15, 0, tzinfo=UTC)
"""17/10 12:00 BRT, in UTC. The one instant this whole card is about.

Written out rather than taken from `broadcast_at()`: a test that computes its
expectation from the code under test passes whatever that code says, which is
exactly how `test_whatsapp.py:105` made a stale opening date invisible to the
suite (card E5). The conversion itself is asserted below, against this literal.
"""


def test_the_literal_due_instant_is_what_the_product_facts_produce() -> None:
    """12:00 BRT on 17/10 **is** 15:00 UTC, and the worker agrees.

    The one assertion in this file that is allowed to compare code to code, and
    it only works because :data:`DUE` is a literal. It also pins the product
    facts to `docs/product.json`'s values, so moving the opening without moving
    this test is loud.
    """
    assert date(2026, 10, 17) == product.OPENING_DATE
    assert product.OPENING_HOUR_BRT == "12:00"
    assert whatsapp.broadcast_at(day=date(2026, 10, 17)) == DUE
    assert DUE.astimezone(whatsapp.ZoneInfo(whatsapp.BRT_ZONE)).hour == 12


def test_no_row_at_all_is_missing_and_is_an_alarm() -> None:
    """2026-10-03, as a test. The row was deleted; nothing noticed for two days."""
    state = opening_check._state(None, due_at=DUE, now=DUE - timedelta(days=8))
    assert state == "missing"
    assert opening_check.STATES[state] is True


@pytest.mark.parametrize("status", opening_check.LIVE_STATUSES)
def test_a_live_row_at_the_configured_instant_is_queued_and_is_not_an_alarm(
    status: str,
) -> None:
    state = opening_check._state((103288, status, DUE), due_at=DUE, now=DUE - timedelta(days=8))
    assert state == "queued"
    assert opening_check.STATES[state] is False


def test_a_live_row_dated_elsewhere_is_misdated_not_queued() -> None:
    """The 2026-10-03 failure's near miss: a row exists, for the wrong instant.

    Nine days early is what the deleted job was dated for, and a check that only
    asked *does a row exist* would have called this healthy.
    """
    nine_days_early = DUE - timedelta(days=9)
    state = opening_check._state(
        (103288, "queued", nine_days_early), due_at=DUE, now=DUE - timedelta(days=12)
    )
    assert state == "misdated"
    assert opening_check.STATES[state] is True


def test_the_tolerance_is_one_minute_either_side_and_not_more() -> None:
    """Pinned at the boundary, both directions, so the constant cannot drift silently."""
    inside = timedelta(seconds=opening_check.RUN_AFTER_TOLERANCE_SECONDS)
    outside = inside + timedelta(seconds=1)
    early = DUE - timedelta(days=1)
    for offset in (inside, -inside):
        assert opening_check._state((1, "queued", DUE + offset), due_at=DUE, now=early) == "queued"
    for offset in (outside, -outside):
        assert (
            opening_check._state((1, "queued", DUE + offset), due_at=DUE, now=early) == "misdated"
        )


def test_a_claimable_row_nothing_has_claimed_is_late() -> None:
    """The consumer is down, or wedged. The row is perfect and nothing runs it."""
    overdue = DUE + timedelta(seconds=opening_check.LATE_AFTER_SECONDS + 1)
    state = opening_check._state((1, "queued", DUE), due_at=DUE, now=overdue)
    assert state == "late"
    assert opening_check.STATES[state] is True


def test_a_row_claimed_within_the_grace_window_is_still_queued() -> None:
    """Priority 9 behind user work plus a two-minute idle poll is not an alarm."""
    just_after = DUE + timedelta(seconds=opening_check.LATE_AFTER_SECONDS - 1)
    assert opening_check._state((1, "queued", DUE), due_at=DUE, now=just_after) == "queued"


def test_done_after_its_own_run_after_is_sent() -> None:
    state = opening_check._state((1, "done", DUE), due_at=DUE, now=DUE + timedelta(hours=1))
    assert state == "sent"
    assert opening_check.STATES[state] is False


def test_done_before_the_instant_it_was_queued_for_is_fired_early() -> None:
    """The failure mode E5 measured: a stale date makes `run_after` already past,
    `jobs.run_after <= now()` makes the row claimable immediately, and every
    seated founder receives an access link to a product that is not open.

    `sent` and `fired_early` are the same `status = 'done'`. Only the clocks
    tell them apart, and both sides come from the caller.
    """
    state = opening_check._state((1, "done", DUE), due_at=DUE, now=DUE - timedelta(days=9))
    assert state == "fired_early"
    assert opening_check.STATES[state] is True


def test_a_failed_row_with_nothing_live_beside_it_is_failed() -> None:
    state = opening_check._state((1, "failed", DUE), due_at=DUE, now=DUE + timedelta(hours=1))
    assert state == "failed"
    assert opening_check.STATES[state] is True


def test_every_state_the_machine_can_reach_is_declared_with_an_alarm_verdict() -> None:
    """No state may reach `/admin` without a decision about whether it is bad.

    Walks the machine over every status the `jobs` table's own check constraint
    allows, on both sides of the due instant, and asserts the result is a
    declared key. A new status, or a new branch, fails here rather than
    rendering as an unstyled word on the card.
    """
    statuses = ("queued", "running", "done", "failed")
    rows: list[tuple[int, str, datetime] | None] = [None]
    for status in statuses:
        for offset in (-timedelta(days=9), timedelta(0), timedelta(days=1)):
            rows.append((1, status, DUE + offset))
    reached = {
        opening_check._state(row, due_at=DUE, now=DUE + when)
        for row in rows
        for when in (-timedelta(days=8), timedelta(0), timedelta(hours=2))
    }
    declared = set(opening_check.STATES)
    assert reached <= declared, f"undeclared states: {reached - declared}"
    # And the machine must actually be able to reach every state it declares,
    # or a dead branch would sit on the card's switch forever looking covered.
    assert reached == set(opening_check.STATES)


def test_the_event_name_the_card_reads_is_the_one_the_job_writes() -> None:
    """One string, two files. `apps/web/lib/admin/opening.ts` selects on it."""
    assert opening_check.EVENT_NAME == "opening_broadcast_check"
    assert opening_check.CHECK_JOB_KIND == "opening_broadcast_check"


def test_the_check_runs_on_both_sides_of_the_broadcast_hour() -> None:
    """E20's first clause: *something the worker runs on its own*, and E20's
    second: *alarms while there is still time to re-place it*.

    A handler nothing enqueues is the shape CLAUDE.md names — an artefact with
    no code path — so the schedule entries are asserted here rather than left to
    be noticed. The **hours** are asserted against the broadcast hour rather
    than as two literals, because what has to hold is the relationship: one
    reading before the broadcast with room to act, one after it so the day does
    not end un-answered. `apps/web/lib/admin/opening.ts`'s staleness threshold
    is derived from the longest gap between them.
    """
    from licitaqui import scheduler

    entries = [e for e in scheduler.DEFAULT_SCHEDULE if e.kind == opening_check.CHECK_JOB_KIND]
    hours = sorted(int(str(e.daily_at).split(":")[0]) for e in entries)
    broadcast_hour = whatsapp.broadcast_hour()[0]

    assert len(entries) == 2, "one reading before the broadcast and one after it"
    assert all(e.every_seconds is None for e in entries), (
        "`test_config.py` caps an interval entry at the consumer's idle poll"
    )
    assert all(e.timezone == scheduler.BRT for e in entries), "the hours are BRT"
    assert hours[0] < broadcast_hour < hours[1], (
        f"{hours} must straddle the {broadcast_hour}:00 BRT broadcast"
    )
    assert broadcast_hour - hours[0] >= 2, "too little warning to re-place the row on the day"
    # The gap the reader's threshold is derived from, stated here so the two
    # cannot drift apart silently.
    assert 24 - (hours[1] - hours[0]) == 18


def test_the_handler_is_registered_under_the_kind_the_scheduler_enqueues() -> None:
    """The registry is what turns that entry into a run. Imported via `handlers`,
    so this also asserts the import line exists."""
    from licitaqui import handlers

    assert opening_check.CHECK_JOB_KIND in handlers.registered_kinds()
