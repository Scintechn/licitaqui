"""The cross-run sweep threshold must outlive every age a test fabricates.

`conftest` cleans up rows left by a *crashed* run by age, because a crashed
run's ``RUN_ID`` is unknowable. That makes the threshold load-bearing in a way
a reader would not guess: a row a **live** run has deliberately backdated past
it is indistinguishable from debris, so a second, concurrent run deletes it
mid-test.

That is not hypothetical. On 2026-09-20 `main`'s CI run (17:00–17:19) and PR
#31's (17:08–17:22) shared this database, and
``test_an_expired_list_is_fetched_again`` — which ages its own marker to 13 h to
prove the 12 h TTL expires — failed with ``'never' == 'ttl'``: the other run had
swept the marker between the backdate and the assertion.

This module is the guard. It fails the moment a TTL grows past the threshold,
rather than letting the suite become intermittently red again.
"""

from __future__ import annotations

import re
from pathlib import Path

from licitaqui.sync_files import FILES_TTL_HOURS
from licitaqui.sync_items import ITEMS_TTL_HOURS

from .conftest import CROSS_RUN_SWEEP_HOURS

#: Tests prove expiry by ageing a row one hour past the TTL it is testing.
OLDEST_AGE_A_TEST_FABRICATES = max(FILES_TTL_HOURS, ITEMS_TTL_HOURS) + 1


def test_the_sweep_cannot_reach_a_live_run_s_backdated_rows() -> None:
    assert CROSS_RUN_SWEEP_HOURS > OLDEST_AGE_A_TEST_FABRICATES, (
        f"a concurrent run would delete rows this suite backdates to "
        f"{OLDEST_AGE_A_TEST_FABRICATES} h. Raise CROSS_RUN_SWEEP_HOURS "
        f"(currently {CROSS_RUN_SWEEP_HOURS})."
    )


def test_no_sweep_uses_a_hard_coded_interval() -> None:
    """Every age predicate must go through the constant, or the guard is blind."""
    source = Path(__file__).with_name("conftest.py").read_text(encoding="utf-8")
    stragglers = re.findall(r"< now\(\) - interval '(?!\{CROSS_RUN_SWEEP_HOURS\})[^']+'", source)
    assert not stragglers, f"age predicates bypassing CROSS_RUN_SWEEP_HOURS: {stragglers}"


def test_b2_cleanup_covers_every_kind_its_sweep_can_enqueue() -> None:
    """Cleanup must not fall behind the code that creates the rows.

    `test_followups_are_queued_as_soon_as_a_handler_exists` asserts on **every**
    job kind under `B2_CNPJ-%`, so a kind the sweep enqueues and the cleanup does
    not delete survives into the next test and fails it with rows it never
    created. That is how `refresh_tender_value` broke that test on main: it was
    added to the search fallback's follow-ups while `_delete_b2_rows` still
    named two kinds in a SQL literal.

    Read off the sweep module rather than restated here, so adding a follow-up
    kind fails this test instead of a distant one two hundred lines away.
    """
    from licitaqui.sync_tenders import FOLLOWUP_KINDS, UPGRADE_KIND

    from .conftest import B2_JOB_KINDS

    enqueueable = set(FOLLOWUP_KINDS) | {UPGRADE_KIND}
    missing = enqueueable - set(B2_JOB_KINDS)
    assert not missing, (
        f"B2's cleanup does not delete {sorted(missing)}, which its sweep can "
        f"enqueue. Those rows will leak into the next test."
    )
