"""E20's proof, against the real database: delete the row and watch it fire.

The card's third acceptance clause is *"proven by deleting the row in a test
database and watching it fire"*, and this is that. `test_opening_check.py` pins
the state machine as a pure function; **this file is the path** — a real
`jobs` row, the real registry, the real consumer, the real `events` insert, and
then the row removed underneath it.

## Why the path needs its own test

CLAUDE.md §4b: the previous ten defects found here all had a green suite,
because the test exercised the unit and never asked whether anything could
reach it. The unit here is `_state`, and it was green from the first minute. The
things only this file can see:

* that `opening_broadcast_check` is a kind the **consumer** can look up and run,
  rather than a function in a module nothing imports;
* that the `events` insert actually commits, with props Postgres accepts as
  `jsonb` (an `isoformat()` string and a `date` object are both fine in Python
  and only one of them survives `Jsonb`);
* that `scheduled_broadcast` finds the row through a real partial unique index
  rather than through a tuple a test handed it — including the case the index
  *allows*, two rows under one key;
* that the state flips from `queued` to `missing` when the row goes away, which
  is the 2026-10-03 incident replayed.

## Scoping

Every row this file writes is scoped by `RUN_ID`, never by a per-task constant
(CLAUDE.md's testing rule): the `jobs` key is built on
`conftest.E2_BROADCAST_KEY_PREFIX`, so conftest's own sweep removes it, and the
`events` rows this check writes carry that key in `props->>'expected_key'`, so
the fixture below removes those. Two concurrent runs of this suite therefore
delete only their own fixtures — a fixed `broadcast_key()` would have them
deleting each other's.

Skipped when `TEST_DATABASE_URL_E2` is not configured.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import psycopg
import pytest

from licitaqui import evolution, opening_check, queue, resend, whatsapp
from licitaqui.consumer import Consumer
from licitaqui.queue import Job
from tests.conftest import E2_BROADCAST_KEY_PREFIX, e2_email

#: The broadcast row this file pretends is the production one. Run-scoped
#: through `E2_BROADCAST_KEY_PREFIX`, and already swept by conftest for kind
#: `founders_opening_broadcast`.
BROADCAST_KEY = f"{E2_BROADCAST_KEY_PREFIX}opening-check"

#: The `opening_broadcast_check` job rows themselves. Not a kind conftest
#: sweeps, so this file deletes them (see :func:`_scope`).
CHECK_KEY_PREFIX = f"{E2_BROADCAST_KEY_PREFIX}check-"


class _NullCtx:
    """A connection factory that hands back the test's own connection."""

    def __init__(self, conn: psycopg.Connection) -> None:
        self._conn = conn

    def __enter__(self) -> psycopg.Connection:
        return self._conn

    def __exit__(self, *exc: object) -> None:
        return None


@pytest.fixture
def scope(e2_conn: psycopg.Connection) -> Iterator[psycopg.Connection]:
    """Delete this run's check jobs and check events, before and after.

    In a `finally`, and before as well as after: a run killed mid-test (the
    worker suite has been killed three times in one afternoon, CLAUDE.md) must
    not leave rows that make the next run's assertions pass for the wrong
    reason.
    """
    _purge(e2_conn)
    try:
        yield e2_conn
    finally:
        _purge(e2_conn)


def _purge(conn: psycopg.Connection) -> None:
    conn.execute(
        "delete from jobs where kind = %s and starts_with(key, %s)",
        (opening_check.CHECK_JOB_KIND, CHECK_KEY_PREFIX),
    )
    conn.execute(
        "delete from events where name = %s and props ->> 'expected_key' = %s",
        (opening_check.EVENT_NAME, BROADCAST_KEY),
    )


def run_check(conn: psycopg.Connection, label: str, **payload: Any) -> tuple[str, dict[str, Any]]:
    """Enqueue and run one check through the real consumer. Returns (status, props).

    Claimed by key rather than off the queue, for the reason
    `test_integration_whatsapp.py` gives: the claim statement takes the
    highest-priority due job of that kind, which in a shared database may
    belong to a concurrent run of this same suite. Everything after the claim —
    registry lookup, `JobContext`, the insert, `mark_done` — is production.
    """
    key = f"{CHECK_KEY_PREFIX}{label}"
    payload.setdefault("key", BROADCAST_KEY)
    job_id = queue.enqueue(conn, opening_check.CHECK_JOB_KIND, key, payload=payload)
    assert job_id is not None, f"the check job {key} was not enqueued"
    row = conn.execute(
        "update jobs set status = 'running', attempts = attempts + 1, updated_at = now()"
        " where id = %s returning id, kind, key, priority, payload, attempts",
        (job_id,),
    ).fetchone()
    assert row is not None
    job = Job(id=row[0], kind=row[1], key=row[2], priority=row[3], payload=row[4], attempts=row[5])
    status = Consumer(lambda: _NullCtx(conn), name="e2-opening-check").execute(conn, job)
    return status, _latest_reading(conn)


def _latest_reading(conn: psycopg.Connection) -> dict[str, Any]:
    """The newest reading this run wrote, read back out of `events`."""
    row = conn.execute(
        "select props from events"
        " where name = %s and props ->> 'expected_key' = %s"
        " order by id desc limit 1",
        (opening_check.EVENT_NAME, BROADCAST_KEY),
    ).fetchone()
    assert row is not None, "the check ran and wrote no reading"
    return dict(row[0])


def _readings(conn: psycopg.Connection) -> int:
    row = conn.execute(
        "select count(*) from events where name = %s and props ->> 'expected_key' = %s",
        (opening_check.EVENT_NAME, BROADCAST_KEY),
    ).fetchone()
    assert row is not None
    return int(row[0])


def place_broadcast(conn: psycopg.Connection, run_after: datetime | None = None) -> int:
    """The dated row, exactly as `schedule_founders_opening.py --commit` places it."""
    job_id = whatsapp.enqueue_opening_broadcast(
        conn, run_after=run_after or whatsapp.broadcast_at(), key=BROADCAST_KEY
    )
    assert job_id is not None, "the broadcast row was not placed"
    return job_id


# -- the incident, replayed ------------------------------------------------


def test_the_row_is_queued_then_deleted_and_the_check_turns_red(
    scope: psycopg.Connection, caplog: pytest.LogCaptureFixture
) -> None:
    """**2026-10-03, as a test.** Queued → deleted → `missing`, and it says so.

    One test rather than two, because what E20 is about is not either state but
    the *transition*: a check that reports `queued` forever, or `missing`
    forever, would pass a pair of narrower tests and notice nothing.
    """
    conn = scope
    job_id = place_broadcast(conn)

    status, healthy = run_check(conn, "before")
    assert status == "done"
    assert healthy["state"] == "queued"
    assert healthy["alarm"] is False
    assert healthy["job_id"] == job_id
    assert healthy["job_status"] == "queued"
    assert healthy["expected_key"] == BROADCAST_KEY

    # The deletion itself — `delete from jobs where id = 103288`, which is what
    # happened on 2026-10-03 and left no trace anybody was watching.
    conn.execute("delete from jobs where id = %s", (job_id,))

    with caplog.at_level(logging.ERROR, logger="licitaqui.consumer"):
        status, alarmed = run_check(conn, "after")

    assert status == "done", "the check must report a bad answer, never fail on it"
    assert alarmed["state"] == "missing"
    assert alarmed["alarm"] is True
    assert alarmed["job_id"] is None
    assert alarmed["job_status"] is None
    # Two readings, not one overwritten: the history is what makes "it was there
    # on Tuesday and gone on Thursday" answerable.
    assert _readings(conn) == 2


def test_a_bad_answer_is_logged_at_error_and_a_good_one_is_not(
    scope: psycopg.Connection, caplog: pytest.LogCaptureFixture
) -> None:
    """The half of the alarm that does not need `/admin` open.

    `docs/CLAIMS.md` records the limit this shares with B17's card (**B39**):
    nothing is *sent*. An `error` line is what a drain can see; a push is a
    card, not this one.
    """
    conn = scope
    with caplog.at_level(logging.DEBUG):
        run_check(conn, "noprow")
    errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert errors, "a missing broadcast row must be an error, not an info line"
    # The state word is in the line, so a drain can route on it rather than on
    # the message string — asserted as the parsed payload, not as a substring.
    payloads = [json.loads(getattr(r, "opening", "{}")) for r in errors]
    assert any(p.get("state") == "missing" and p.get("alarm") is True for p in payloads)
    # §12: no recipient, no address, no number, no name reaches the log line.
    for record in caplog.records:
        line = getattr(record, "opening", "")
        assert "@" not in line, "the reading must carry no address"
        assert "+55" not in line, "the reading must carry no number"

    caplog.clear()
    place_broadcast(conn)
    with caplog.at_level(logging.DEBUG):
        _, healthy = run_check(conn, "withrow")
    assert healthy["state"] == "queued"
    assert [r for r in caplog.records if r.levelno >= logging.ERROR] == []


# -- the partial index, which is why `scheduled_broadcast` exists ----------


def test_a_dead_row_beside_a_live_one_reads_as_the_live_one(
    scope: psycopg.Connection,
) -> None:
    """`jobs_dedupe` **allows** this, and reading the wrong one is E20's own note.

    The index is unique on (kind, key) only `where status in ('queued',
    'running')`, so a failed sweep plus a re-run leaves two rows under one key.
    An unordered `fetchone()` — which `schedule_founders_opening.py` had until
    this PR — can return either, so it could print *"status failed"* over a
    perfectly healthy queue on the morning of 17/10.

    Built through the real index rather than asserted about it: the first row is
    *made* dead by marking it `failed`, which is the only way a second insert
    under the same key is permitted at all.
    """
    conn = scope
    dead = place_broadcast(conn)
    conn.execute("update jobs set status = 'failed' where id = %s", (dead,))
    live = place_broadcast(conn)
    assert live != dead

    _, reading = run_check(conn, "twoRows")
    assert reading["job_id"] == live, "the live row decides, never the dead one"
    assert reading["state"] == "queued"
    assert reading["alarm"] is False

    # And with nothing live, the dead row is reported as dead rather than as
    # absent — a different sentence, and the one the card needs.
    conn.execute("update jobs set status = 'failed' where id = %s", (live,))
    _, after = run_check(conn, "bothDead")
    assert after["job_id"] == live
    assert after["state"] == "failed"
    assert after["alarm"] is True


def test_a_row_dated_nine_days_early_is_misdated_not_healthy(
    scope: psycopg.Connection,
) -> None:
    """The shape the deleted job actually had: present, and for the wrong instant."""
    conn = scope
    place_broadcast(conn, run_after=whatsapp.broadcast_at() - timedelta(days=9))
    _, reading = run_check(conn, "misdated")
    assert reading["state"] == "misdated"
    assert reading["alarm"] is True


# -- the question it asked --------------------------------------------------


def test_the_reading_names_the_date_it_asked_about_in_both_clocks(
    scope: psycopg.Connection,
) -> None:
    """E20's third clause: *the check names the date it is looking for*.

    A reading that did not record its own question could not be told apart from
    a reading about 08/10, which is precisely the confusion that made the
    2026-10-05 audit necessary.
    """
    conn = scope
    place_broadcast(conn)
    _, reading = run_check(conn, "dates")

    assert reading["opening_date"] == whatsapp.opening_date().isoformat()
    due = datetime.fromisoformat(reading["due_at"])
    assert due == whatsapp.broadcast_at()
    assert due.utcoffset() == timedelta(0), "`due_at` is UTC, as `jobs.run_after` is"
    brt = datetime.fromisoformat(reading["due_at_brt"])
    assert brt == due, "the same instant, said twice"
    assert brt.utcoffset() == timedelta(hours=-3), "and once in the clock the copy promises"
    assert reading["broadcast_hour_brt"] == "12:00"
    assert reading["date_matches_product"] is True

    # Both sides of the age from the database's own clock, never the laptop's.
    checked = datetime.fromisoformat(reading["checked_at"])
    assert checked.tzinfo is not None
    assert abs((due - checked).total_seconds() / 3600 - reading["hours_to_due"]) < 0.02


def test_an_env_override_that_disagrees_with_the_product_is_on_the_record(
    scope: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """E5 called this unverifiable from a laptop. It is a field in the row.

    `FOUNDERS_OPENING_DATE` is read by the worker and by nothing else, so a
    stale value there is invisible: the scheduling script and this check read
    the same variable, agree perfectly, and the card goes green over a broadcast
    dated for a day the product has moved off.
    """
    conn = scope
    # A **future** override, so the only thing wrong is the date. That isolates
    # the trap: the override and the row agree with each other perfectly, the
    # queue is healthy by every other measure, and the single fact that the
    # worker is dated a week off the product is the whole finding.
    monkeypatch.setenv(whatsapp.OPENING_DATE_VAR, "2026-10-24")
    place_broadcast(conn, run_after=whatsapp.broadcast_at())
    _, reading = run_check(conn, "override")

    assert reading["opening_date"] == "2026-10-24"
    assert reading["product_opening_date"] == "2026-10-17"
    assert reading["date_matches_product"] is False
    assert reading["state"] == "queued", "nothing about the row is wrong; only the date is"
    assert reading["expected_key"] == BROADCAST_KEY

    # **And the direction that actually happened.** E5 measured that the stale
    # 08/10 default made `broadcast_at()` an instant in the *past*, which
    # `jobs.run_after <= now()` makes claimable immediately — *"the stale
    # constant was not inert, it was early"*. Written as a date that is behind
    # today rather than as the literal 08/10 so the assertion does not start
    # lying the moment the calendar moves past whatever literal was chosen.
    behind = (datetime.now(UTC) - timedelta(days=2)).date()
    monkeypatch.setenv(whatsapp.OPENING_DATE_VAR, behind.isoformat())
    place_broadcast(conn, run_after=whatsapp.broadcast_at())
    _, stale = run_check(conn, "overrideStale")
    assert stale["date_matches_product"] is False
    assert stale["state"] == "late", "a past-dated broadcast is claimable now, not inert"
    assert stale["alarm"] is True
    assert stale["hours_to_due"] < 0


def test_the_reading_counts_who_the_sweep_reaches_and_who_it_does_not(
    scope: psycopg.Connection,
) -> None:
    """Seated against waitlisted, from the same SQL the sweep itself runs.

    The waitlist number is the open decision E5 names: both waitlist templates
    promise those people a message when the product opens and **no opening-day
    waitlist template exists**. Zero in production today, which is why it is a
    counter on the card rather than a silence.
    """
    conn = scope
    place_broadcast(conn)
    before = run_check(conn, "countsBefore")[1]

    conn.execute(
        "insert into founders_list (name, email, whatsapp, contact_consent, seat)"
        " values (%s, %s, %s, true, null)",
        ("Waitlisted Zzyzx", e2_email("opening-check-waitlisted"), "+5511999990001"),
    )
    after = run_check(conn, "countsAfter")[1]

    assert after["waitlisted"] == before["waitlisted"] + 1
    assert after["seated"] == before["seated"]
    assert after["seated"] >= 0


def test_the_reading_records_both_kill_switches_as_the_worker_sees_them(
    scope: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The one production fact no other surface can report.

    `preview_founders_opening.py` prints both switches too — but from the
    environment of whatever process runs it, which from Sci's laptop is the
    laptop. This job runs **on the worker**, so its two values are the real
    ones, and a row perfectly queued for the right instant while
    `WHATSAPP_DELIVERY` is unset is exactly the failure E20's card names:
    nothing happening on the day while every signal stays green.

    Kept as a **second dimension** rather than folded into `state`: the queue
    is fixed with a command and a switch with an env change, and a card that
    could not tell them apart would send somebody to do the wrong one.

    The autouse fixtures (`conftest._whatsapp_delivery_off`,
    `_email_delivery_off`) delete both switches suite-wide, so the off case is
    the default here and the on case has to be set — which is the right way
    round for the only irreversible thing this worker does.
    """
    conn = scope
    place_broadcast(conn)

    _, off = run_check(conn, "switchesOff")
    assert off["state"] == "queued", "the row itself is fine"
    assert off["whatsapp_delivery"] == "dry_run"
    assert off["email_delivery"] == "dry_run"
    assert off["delivery_ready"] is False
    # The mode, never a credential (§12).
    assert "apikey" not in json.dumps(off).lower()

    monkeypatch.setenv(evolution.DELIVERY_VAR, evolution.DELIVERY_SEND)
    _, half = run_check(conn, "switchesHalf")
    assert half["whatsapp_delivery"] == "send"
    assert half["email_delivery"] == "dry_run"
    assert half["delivery_ready"] is False, "both channels carry the link; one is not enough"

    monkeypatch.setenv(resend.DELIVERY_VAR, resend.DELIVERY_SEND)
    _, both = run_check(conn, "switchesOn")
    assert both["delivery_ready"] is True
    assert both["alarm"] is False


def test_the_check_reads_and_writes_only_its_own_event(scope: psycopg.Connection) -> None:
    """It reports; it does not repair. A watchdog that re-queued would be a
    watchdog that sends real WhatsApp messages to real founders, which
    CLAUDE.md reserves for Sci."""
    conn = scope
    before = conn.execute(
        "select count(*) from jobs where kind = %s", (whatsapp.BROADCAST_JOB_KIND,)
    ).fetchone()
    assert before is not None

    run_check(conn, "noRepair")

    after = conn.execute(
        "select count(*) from jobs where kind = %s", (whatsapp.BROADCAST_JOB_KIND,)
    ).fetchone()
    assert after is not None
    assert after[0] == before[0], "the check must never enqueue a broadcast"
    assert _latest_reading(conn)["state"] == "missing"


def test_the_clock_the_check_uses_is_the_databases_own(scope: psycopg.Connection) -> None:
    """CLAUDE.md's clocks: `jobs.run_after` is compared against the database's
    `now()` when a job is claimed, so that is the clock `late` must be decided
    on. A container one hour out — Sci's laptop is — would otherwise report a
    healthy queue as late, or a late one as healthy."""
    conn = scope
    place_broadcast(conn)
    row = conn.execute("select now()").fetchone()
    assert row is not None
    db_now = row[0].astimezone(UTC)

    _, reading = run_check(conn, "clock")
    checked = datetime.fromisoformat(reading["checked_at"])
    assert abs((checked - db_now).total_seconds()) < 30
