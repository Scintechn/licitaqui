"""The retry schedule, as a pure function (§7.2: 2, 8, 30 min, then failed)."""

from __future__ import annotations

from licitaqui.queue import next_backoff


def test_the_schedule_is_two_eight_and_thirty_minutes():
    assert next_backoff(1) == 120
    assert next_backoff(2) == 480
    assert next_backoff(3) == 1800


def test_the_fourth_attempt_is_the_last():
    assert next_backoff(4) is None
    assert next_backoff(9) is None


def test_a_job_that_was_never_attempted_has_no_backoff():
    assert next_backoff(0) is None
