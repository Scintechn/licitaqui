"""``opening_broadcast_check`` — E20's watchdog over the one dated row.

## Why this exists, and why the card is evidence of itself

The founders opening is **one `jobs` row**, placed by a person running
`worker/scripts/schedule_founders_opening.py --commit`. Everything else about
it is automatic; the row is not. On **2026-10-03** that row — job `103288`,
`run_after` 2026-10-08 22:00 UTC — was deleted (`events` row
`founders_opening_broadcast_cancelled`) because Sci moved the opening, and
**two days passed with nothing scheduled and nothing noticing**. The 2026-10-05
audit found it by querying `jobs` by hand, not from an alarm, and
`docs/CLAIMS.md` was still offering the deleted id as live evidence for a
launch-blocking promise.

Nothing the worker runs on its own asserted it. `scheduler.DEFAULT_SCHEDULE`
has no entry for a single date and cannot have one —
`ScheduleEntry.__post_init__` requires `every_seconds` or `daily_at`.
`selfcheck` renders templates and never reads `jobs`; `preflight` reads
environment variables. So the one row the whole opening depends on was the only
moving part with no watch over it.

This is that watch. It writes one `events` row per run and `/admin` reads it
(`apps/web/lib/admin/opening.ts`), the same division of labour `coverage_check`
and `coverage.ts` already use for B17.

## B32's rule still applies, pointing the other way

`coverage.ts` says it loudly: *alarm on absence of success, never on absence of
queueing*, and **nothing there reads `jobs`**. Here the thing being watched
**is** a `jobs` row, so this module must read that table — but the rule is not
suspended, it moves up one level. A run of this check that never happens writes
no `events` row, and the reader treats that silence as its own alarm
(`stale`/`never`) rather than as health. The two are different facts: *the
broadcast row is gone*, against *we do not know whether the broadcast row is
gone*.

## It names the date it is looking for

E20's third acceptance clause, and the one with teeth. A check written against
"today" would ask a question nobody needs; a check written against
`broadcast_key()` on 2026-10-05 would have asked for
`founders-opening-broadcast:2026-10-08` and found the right answer to the wrong
question. So the expected key, the opening date and the due instant are all
recorded in the row, in **UTC** (what `jobs.run_after` stores) with the BRT
instant beside it (what the copy promises). CLAUDE.md's clocks table; both
sides of every comparison here come from the same clock, and that clock is the
database's own `now()`, because that is what `queue.claim` compares `run_after`
against.

## The env override is part of what is checked

`opening_date()` reads `FOUNDERS_OPENING_DATE` and falls back to
`product.OPENING_DATE`. E5 recorded that **whether the deployed container sets
that variable is unverifiable from a laptop**. It is verifiable from here: the
row carries both the effective date and `product.OPENING_DATE`, so an override
pointing the worker at a date the product has moved off becomes a fact on the
card instead of an invisible difference between two processes. A stale override
would otherwise be the quietest possible failure — this check and the scheduling
script read the same wrong variable, agree with each other perfectly, and the
card goes green over a broadcast dated nine days early.

## `jobs_dedupe` is partial, so "a row exists" is not the question

The index is unique on `(kind, key)` only ``where status in ('queued',
'running')`` (`db/migrations/0001_initial.sql`), so once a row is `done` or
`failed` another with the same key is allowed — which is exactly what a failed
sweep plus a re-run produces. `whatsapp.scheduled_broadcast` already resolves
that correctly (a live row wins, newest among equals), and this module uses it
rather than writing a second query that would have to learn the same lesson.
The states below then distinguish *dead row, nothing live* from *live row
queued*, which an unordered `fetchone()` cannot — and that unordered read is a
real defect `schedule_founders_opening.py` carried until this PR.

## It writes no job and fixes nothing

It reports. If the row is missing the fix is a person running
`schedule_founders_opening.py --commit` — enqueuing the real broadcast sends
real WhatsApp messages and e-mails to real founders, which CLAUDE.md reserves
for Sci. A watchdog that repaired itself would be a watchdog that sends.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

from psycopg.types.json import Jsonb

from . import evolution, product, resend, whatsapp
from .registry import REGISTRY, JobContext

CHECK_JOB_KIND = "opening_broadcast_check"

#: The `events.name` this writes and `apps/web/lib/admin/opening.ts` reads.
EVENT_NAME = "opening_broadcast_check"

#: How far `jobs.run_after` may sit from the configured instant before the row
#: counts as pointing at a different time. One minute: `broadcast_at()` is
#: computed to the minute from `FOUNDERS_OPENING_HOUR`, so anything inside this
#: is the same instant expressed twice, and anything outside it is a row queued
#: against a different date or hour than the one this build computes.
RUN_AFTER_TOLERANCE_SECONDS = 60.0

#: How long a claimable row may sit `queued` past its own `run_after` before
#: the reading is `late` rather than `queued`. The broadcast is priority 9, so
#: it queues behind user-facing work, and the consumer's idle poll is two
#: minutes (`consumer.py`) — fifteen minutes is comfortably past both and still
#: inside the window where somebody could do something about it on the day.
LATE_AFTER_SECONDS = 15 * 60.0

#: Live, by `jobs_dedupe`'s own definition.
LIVE_STATUSES = ("queued", "running")

#: Every state this check can record, and whether it is an alarm.
#:
#: Split finely on purpose: *the row is gone* and *the row already ran, nine
#: days early* are both "not queued" and need completely different sentences on
#: the card. Collapsing them is how the 2026-10-03 deletion could have read as
#: "the broadcast has been sent".
STATES: dict[str, bool] = {
    # A live row under the expected key, dated the instant this build computes.
    "queued": False,
    # It ran, at or after the instant it was queued for. The promise is kept —
    # though per-recipient proof is `preview_founders_opening.py` reading
    # `*.sent` events, never a job status (card E4, `docs/CLAIMS.md`).
    "sent": False,
    # No row at all under the expected key. **This is 2026-10-03.**
    "missing": True,
    # A live row whose `run_after` is not the configured instant. Either the row
    # or the configuration is wrong, and the card cannot tell which — so it
    # prints both and says so.
    "misdated": True,
    # Live, claimable, and nothing has claimed it. No consumer, or a wedged one.
    "late": True,
    # `done` before the instant it was queued for: the broadcast has already
    # gone out early, to every seated founder, with a link to a closed product.
    "fired_early": True,
    # The newest row under the key is `failed` and nothing live replaced it.
    "failed": True,
}


def _state(
    row: tuple[int, str, datetime] | None,
    *,
    due_at: datetime,
    now: datetime,
) -> str:
    """Which of :data:`STATES` the queue is in. Pure, so the suite can enumerate it.

    ``now`` and ``due_at`` are both aware UTC and both arrive from the caller
    already converted — this function never reads a clock, which is what lets a
    test walk it through the day without monkeypatching time, and what keeps the
    two sides of every comparison on one clock.
    """
    if row is None:
        return "missing"
    _job_id, status, run_after = row
    if status in LIVE_STATUSES:
        if abs((run_after - due_at).total_seconds()) > RUN_AFTER_TOLERANCE_SECONDS:
            return "misdated"
        if (now - run_after).total_seconds() > LATE_AFTER_SECONDS:
            return "late"
        return "queued"
    if status == "done":
        # Against `run_after`, not against `due_at`. This asks whether the row
        # ran at the time it was *queued* for, which is the only thing its own
        # status can answer; a `done` row dated differently from the current
        # configuration is a date change, and the card reports it from the
        # recorded `job_run_after` rather than as an early send.
        return "sent" if now >= run_after else "fired_early"
    return "failed"


def _counts(ctx: JobContext) -> tuple[int, int]:
    """Seated and waitlisted, from the same SQL the sweep and the preview use."""
    with ctx.conn.cursor() as cur:
        cur.execute(whatsapp.SEATED_FOUNDERS_SQL)
        seated = len(cur.fetchall())
    return seated, whatsapp.waitlisted_count(ctx.conn)


@REGISTRY.job(CHECK_JOB_KIND)
def opening_broadcast_check(ctx: JobContext) -> None:
    """Assert the dated founders-opening row is queued, and record what it found.

    Payload, optional:

    ``day``
        An ISO date to check instead of the configured opening. For tests, and
        for asking about a date that has passed; a run without it asks about the
        opening the product is actually selling, which is the only question
        `/admin` may show.
    ``key``
        The `jobs.key` to look for, instead of :func:`whatsapp.broadcast_key`'s
        derivation from ``day``. **Tests only**, and for exactly the reason
        `enqueue_opening_broadcast` already documents for its own override: the
        derived key is a fixed string per opening day, so two concurrent runs of
        the suite would write and delete each other's fixture row. A production
        run never passes it, and the key it derived is recorded in the row, so a
        reading can be checked against the question it answered.

    Always writes exactly one row, including — especially — when the answer is
    bad. A check that raised instead would leave the queue retrying and the
    reader with nothing to read, which is the same silence this card is about.
    The alarming states are additionally logged at `error`, so a log drain sees
    them without waiting for somebody to open `/admin`.
    """
    raw_day = ctx.payload.get("day")
    day = datetime.fromisoformat(str(raw_day)).date() if raw_day else whatsapp.opening_date()

    key = str(ctx.payload.get("key") or whatsapp.broadcast_key(day))
    due_at = whatsapp.broadcast_at(day=day)
    # One clock for both sides of every comparison below, taken from the
    # database rather than from the container: `jobs.run_after` is compared
    # against the database's own `now()` when a job is claimed (`queue.py`), so
    # that is the clock that decides whether this row is late. A container whose
    # clock had drifted would otherwise report `late` about a healthy queue.
    with ctx.conn.cursor() as cur:
        cur.execute("select now()")
        row = cur.fetchone()
    now = (row[0] if row else datetime.now(UTC)).astimezone(UTC)

    found = whatsapp.scheduled_broadcast(ctx.conn, key=key)
    state = _state(found, due_at=due_at, now=now)
    seated, waitlisted = _counts(ctx)

    props: dict[str, Any] = {
        "state": state,
        "alarm": STATES[state],
        # The question, recorded, so a reading can never be mistaken for one
        # about a different date (E20's third acceptance clause).
        "expected_key": key,
        "opening_date": day.isoformat(),
        "due_at": due_at.isoformat(),
        "due_at_brt": due_at.astimezone(ZoneInfo(whatsapp.BRT_ZONE)).isoformat(),
        "checked_at": now.isoformat(),
        "hours_to_due": round((due_at - now).total_seconds() / 3600, 2),
        # **The env override, made visible.** E5 recorded this as unverifiable
        # from a laptop; it is a field here. A `false` means the worker is dated
        # by `FOUNDERS_OPENING_DATE` and not by `product.OPENING_DATE`, and the
        # two disagreeing is the quietest way this can fail.
        "product_opening_date": product.OPENING_DATE.isoformat(),
        "date_matches_product": day == product.OPENING_DATE,
        "broadcast_hour_brt": "{:02d}:{:02d}".format(*whatsapp.broadcast_hour()),
        # **Both kill switches, as the deployed worker sees them**, and this is
        # the only place that can say so.
        #
        # `preview_founders_opening.py` prints these too, but it reads
        # `os.environ` in the process *it* runs in — so run from a laptop, its
        # switch lines describe the laptop, and its `would_send` verdict is
        # therefore "would this founder receive it **if the worker had my
        # environment**". The database half of that script is true of production
        # because it reads production's tables; the environment half is not, and
        # the two sit in the same report.
        #
        # This job runs *on* the worker, so these two values are the real ones.
        # A row that is perfectly queued for the right instant while
        # `WHATSAPP_DELIVERY` is unset is exactly the failure E20's card names —
        # nothing happening on the day while every other signal stays green —
        # and before this field nothing on `/admin` could see it.
        #
        # The **mode**, never a key: `delivery_mode()` returns only `send` or
        # `dry_run` (§12, and nothing here may log a credential).
        "whatsapp_delivery": evolution.delivery_mode(),
        "email_delivery": resend.delivery_mode(),
        # A **second dimension**, deliberately not folded into `state`. The
        # state is about the row; this is about whether a message that row fans
        # out can leave the process. Collapsing them would make a perfect queue
        # with a dead switch indistinguishable from a missing row, and they need
        # different fixes — one is a command, the other is an env change.
        "delivery_ready": evolution.sending_enabled() and resend.sending_enabled(),
        "job_id": found[0] if found else None,
        "job_status": found[1] if found else None,
        "job_run_after": found[2].isoformat() if found else None,
        # Who the sweep would reach, and who it would not. The waitlist count is
        # the open decision E5 names — both waitlist templates promise these
        # people a message on the day and no template covers it — so it is a
        # number on the card rather than a sentence in a docstring.
        "seated": seated,
        "waitlisted": waitlisted,
    }

    ctx.conn.execute(
        "insert into events (name, props) values (%s, %s)",
        (EVENT_NAME, Jsonb(props)),
    )
    # No recipient, no number, no name — counts, a state word and two delivery
    # modes only (§12).
    line = json.dumps(props)
    # Either dimension is enough to make the day fail: a missing row sends
    # nothing, and a dead switch sends nothing from a perfect row.
    if STATES[state] or not props["delivery_ready"]:
        ctx.log.error("founders opening broadcast check failed", extra={"opening": line})
    else:
        ctx.log.info("founders opening broadcast checked", extra={"opening": line})
