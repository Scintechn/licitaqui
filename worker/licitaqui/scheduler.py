"""The scheduler: one process that only ever creates jobs (§7.3).

It never runs work itself — consumers do that — so a scheduler tick is a short
INSERT and the connection closes again. Between ticks it holds nothing open,
for the same Neon reason as the consumer loop.

Every entry produces a deterministic key per due time, so the `jobs_dedupe`
index turns a duplicated tick (two scheduler instances during a deploy, a
retried container) into a single job instead of two.

B1 ships the engine with an empty schedule. B2 adds ``sync_open_tenders`` every
30 minutes, and the daily and weekly entries in spec §7.1 follow.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from . import queue
from .db import ConnectionFactory
from .observability import capture_exception, get_logger

_log = get_logger("scheduler")

BRT = "America/Sao_Paulo"
DEFAULT_TICK_SECONDS = 30.0


@dataclass(frozen=True)
class ScheduleEntry:
    """A job kind to enqueue on a fixed cadence.

    Exactly one of ``every_seconds`` and ``daily_at`` is set. ``daily_at`` is
    ``"HH:MM"`` in ``timezone`` (alerts and cleanup run on BRT wall-clock time,
    so they must survive the DST-free but UTC-offset-shifting Brazilian year).

    ``weekday`` narrows a ``daily_at`` entry to one day of the week, numbered
    as :meth:`datetime.date.weekday` numbers it (0 = Monday). §7.1 has both
    cadences — `sync_awards` is daily, `weekly_alerts` is Monday 07:00 — and
    the weekly one is a daily one that skips six days, so it is one field here
    rather than a second kind of entry.
    """

    kind: str
    every_seconds: float | None = None
    daily_at: str | None = None
    weekday: int | None = None
    timezone: str = BRT
    priority: int = 5
    payload: dict[str, Any] | None = None
    key_for: Callable[[datetime], str] | None = None

    def __post_init__(self) -> None:
        if (self.every_seconds is None) == (self.daily_at is None):
            raise ValueError("set exactly one of every_seconds or daily_at")
        if self.weekday is not None:
            if self.daily_at is None:
                raise ValueError("weekday needs daily_at")
            if not 0 <= self.weekday <= 6:
                raise ValueError("weekday is 0 (Monday) to 6 (Sunday)")

    def next_due(self, after: datetime) -> datetime:
        """First due instant strictly after ``after`` (an aware UTC datetime)."""
        if self.every_seconds is not None:
            step = timedelta(seconds=self.every_seconds)
            epoch = datetime(1970, 1, 1, tzinfo=ZoneInfo("UTC"))
            elapsed = (after - epoch) / step
            return epoch + step * (int(elapsed) + 1)
        tz = ZoneInfo(self.timezone)
        hour, minute = (int(part) for part in str(self.daily_at).split(":"))
        local = after.astimezone(tz)
        due = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if due <= local:
            due += timedelta(days=1)
        if self.weekday is not None:
            # Advance to the next matching weekday. Recomputed from the local
            # date rather than added in UTC, so a shifted offset cannot walk
            # the wall-clock hour off 07:00.
            due += timedelta(days=(self.weekday - due.weekday()) % 7)
        return due.astimezone(ZoneInfo("UTC"))

    def key(self, due: datetime) -> str:
        if self.key_for is not None:
            return self.key_for(due)
        return due.astimezone(ZoneInfo(self.timezone)).strftime("%Y-%m-%dT%H:%M")


#: §7.1. `sync_open_tenders` every 30 minutes; the daily and weekly entries
#: arrive with the jobs that need them.
#:
#: It carries no payload. The window comes from the watermark the previous
#: cycle wrote (:mod:`licitaqui.sync_tenders`), so a tick is just "sweep
#: whatever has changed since the last completed cycle" and two ticks 30
#: minutes apart never re-do each other's work. The default key — the due
#: instant in BRT — means a duplicated tick during a deploy dedupes to one job.
#: `sync_awards` is §7.1's "daily, overnight". 03:00 BRT is off-peak, which
#: §7.2 asks for heavy jobs, and the sweep itself is cheap — it makes no HTTP
#: call, it only queues the per-tender jobs that do (priority 9, so they sit
#: behind anything a user is waiting for).
#:
#: `weekly_digest` is §7.1's `weekly_alerts`: **Monday 07:00 BRT**, the free
#: plan's one message of the week. It is a sweep like `sync_awards` — it sends
#: nothing, it enqueues one `send_telegram` per eligible account — so it sits
#: at priority 9 behind anything a user is waiting for, and the per-user jobs
#: it creates do too. A duplicated tick dedupes twice over: once on this
#: entry's own key, and again on the per-user key, which carries the ISO week
#: (`licitaqui.telegram_alerts.digest_job_key`). The weekday here and
#: `telegram_alerts.DIGEST_WEEKDAY` are the same fact — `start-linked.md`
#: promises the person a day of the week — and `test_telegram.py` pins them
#: together so this entry cannot move without the copy moving with it.
DEFAULT_SCHEDULE: tuple[ScheduleEntry, ...] = (
    # **Hourly since 2026-09-30, was half-hourly.** Sci: *"we need to kept the
    # cost tiny - its a new application without paid user yet"*. Neon suspends
    # after five minutes with no connections, so every wake costs a five-minute
    # tail whether or not there is work in it: measured 5.5 h/day of compute
    # against roughly 1.5 h of actual work. Halving the wakes takes about a
    # third off the compute line.
    #
    # What it costs: an edital appears up to an hour after PNCP publishes the
    # change rather than up to half an hour. Deadlines here are measured in
    # days — the closest thing to a real constraint is the "48 h antes" alert,
    # which this does not feed — so an hour is inside every promise the product
    # makes. Revisit on the evening of 08/10, when `WORKER_POLL_INTERVAL_SECONDS`
    # is meant to be shortened anyway.
    ScheduleEntry(kind="sync_open_tenders", every_seconds=60 * 60, priority=5),
    # **The catalogue vocabulary and the item→code map (B36).** Carded and
    # scheduled in the same change as the handlers, because B32 is what happens
    # otherwise: a handler that works, no enqueuer, and a feed that "stopped
    # growing on 2026-09-29 and nobody noticed for two days". A registered
    # handler nothing enqueues can never be claimed.
    #
    # Weekly, not daily: `statusPdm` flips on the scale of months and the walk
    # is ~48 pages, so a daily pass would spend the API budget B35's price
    # refresh needs. Sunday, before the map that depends on it.
    #
    # The map runs daily because new editais arrive daily and an unmapped item
    # shows no price at all. It makes **no API call** -- measured, the whole open
    # corpus resolves in ~2-4 minutes of CPU -- so its only cost is the job slot.
    #
    # Alarm on "0 codes refreshed in N days", **never on "0 queued"**: B32's
    # lesson is that a feed which never enqueues also never fails, which is
    # precisely why it was invisible.
    ScheduleEntry(kind="sync_catalog_vocabulary", daily_at="03:20", weekday=6, priority=9),
    ScheduleEntry(kind="map_item_codes", daily_at="04:10", priority=9),
    # **B35's price refresh, and it is a sweep that only enqueues.** 04:40 BRT
    # is half an hour behind `map_item_codes` on purpose: the sweep orders codes
    # by how many open items point at them, reading `tender_item_codes`, so it
    # must run after the map that writes them or the first sweep of a new
    # edital's codes is a day late.
    #
    # **Daily, not weekly, although a code only falls due weekly.** The cadence
    # that matters is per code and lives in `catalog_prices` — thin codes
    # weekly, deep ones monthly, codes no open item references never. A weekly
    # sweep would put the whole ~2 000-call pass in one burst; a daily one
    # spreads it over seven, which at the only throughput measured clean
    # (0.55 calls/s over 2 668 calls, zero 429) is about an hour of calling a
    # day in ~1 000 short jobs rather than six hours in one.
    #
    # Priority 9, and the per-code jobs it creates inherit it: each one is a
    # couple of API pages, so `sync_open_tenders` waits behind at most one of
    # them. A single long job on a concurrency-2 worker is what B32 cost, and
    # it is the shape this entry exists to avoid.
    #
    # The alarm is "0 codes refreshed in N days" — the `events` row this run
    # writes — and **never** "0 queued": a feed that never enqueues also never
    # fails, which is exactly why B32 was invisible for two days.
    ScheduleEntry(kind="refresh_catalog_prices", daily_at="04:40", priority=9),
    ScheduleEntry(kind="sync_awards", daily_at="03:00", priority=9),
    # B17, and the reason it is daily rather than half-hourly like the change
    # feed above: this is an **inventory**, not a feed. It asks PNCP what is
    # open, partition by partition, and walks each one to its end with no
    # `stop_at` — roughly 26,000 records over ~80 requests. Running it every 30
    # minutes would spend that to discover almost nothing had changed. (The
    # endpoint itself is not the constraint: ADR-0001 measured `/api/search/`
    # at 0% failure across 52 requests, healthy through two consulta outages.)
    #
    # 04:00 BRT is §7.2's off-peak slot for heavy jobs, an hour after
    # `sync_awards` so the two do not contend. The cost of the cadence is
    # bounded staleness: an edital published today and never updated is
    # invisible to `/atualizacao` and appears here within 24 hours. That is
    # inside the deadline for the misses B17 measured — 37 of the 72 closed
    # within three days, none was already past due — but it **is** the number
    # to revisit once the coverage figure is being measured rather than
    # estimated.
    ScheduleEntry(kind="reconcile_open_tenders", daily_at="04:00", priority=9),
    # **Deliberately the same 04:00 as `reconcile_open_tenders`.** It reads
    # Neon's API, not the database, so its own cost is one wake — and sharing
    # the reconcile's means it is not even that. A job about the compute bill
    # that opened a wake of its own to report on wakes would be funny once.
    # Daily: awake time is a trend, and the figure it reads moves slowly.
    ScheduleEntry(kind="neon_usage", daily_at="04:00", priority=9),
    # Hourly, and off the collectors' priority. A missing title degrades a
    # card; a missing tender loses it, so this never competes with B2/B3. An
    # hour is well inside `sync_open_tenders`' own 30 min cycle, so a tender
    # published today is titled the same day without the sweep running hot —
    # and the sweep is cheap when there is nothing to do, which after the
    # backfill is the normal case.
    ScheduleEntry(kind="sweep_titles", every_seconds=60 * 60, priority=8),
    # **B17's closure test, now standing rather than asked once.** Measured
    # 2026-10-05, `coverage_check` had run three times ever — all on
    # 2026-09-30, all on one keyword — and nothing read the result. Its last
    # row said the gap was closed (`ratio: 1.0` against a 0.416 baseline), so
    # the only thing missing was anybody noticing if it came back. That is
    # B32's shape, and `docs/CLAIMS.md` dates the sentence it measures 17/10.
    #
    # **05:10 BRT, and the hour is three decisions.**
    #
    # *After the inventory.* `reconcile_open_tenders` starts at 04:00 and is
    # the sweep that closes this gap, so measuring before it would conflate
    # staleness with the keying defect B17 is about. How long to wait is
    # **inferred, not measured**: the one recorded cycle finished at 07:37 UTC
    # = 04:37 BRT (B17's card: `complete: True, coverage: 1.0, records: 25817`)
    # and the entry that started it is this file's 04:00, which makes it about
    # 37 minutes — a single run, read off two facts rather than timed. 70
    # minutes is roughly two of those. If a cycle ever runs long enough to
    # overlap, the symptom is visible rather than silent: the reading comes
    # back short while the sweep is still filling the table, and `/admin` says
    # so.
    #
    # *Inside somebody else's wake.* `refresh_catalog_prices` queues its
    # per-code jobs at 04:40 and they are "about an hour of calling a day", so
    # at 05:10 the worker and the Neon compute are already awake. This entry
    # therefore costs a job slot rather than a five-minute suspend tail — the
    # same reasoning that keeps `neon_usage` on `reconcile_open_tenders`' 04:00.
    #
    # *Priority 8, not 9, and that is the point of the hour.* At 9 it would
    # queue behind up to a thousand per-code price jobs and be measured at an
    # unpredictable time hours later; at 8 it overtakes them and takes about a
    # minute (seven queries, at most 84 requests). Still behind every collector
    # at 5 — a missing coverage reading degrades a watchdog, it does not lose a
    # tender — which is exactly where `sweep_titles` sits for the same reason.
    #
    # No payload: the absence of `q` is what makes the job the standing set
    # (`coverage_check.DEFAULT_QUERIES`) rather than one ad-hoc keyword. The
    # hour is BRT; the `events` row it writes is UTC (08:10), per CLAUDE.md.
    #
    # The alarm on it is "no successful measurement in N days, or a measured
    # ratio under target" — read by `apps/web/lib/admin/coverage.ts` — and
    # **never** "0 queued", for B32's reason.
    ScheduleEntry(kind="coverage_check", daily_at="05:10", priority=8),
    ScheduleEntry(kind="weekly_digest", daily_at="07:00", priority=9, weekday=0),
    # **F4's reminder, three days before each charge** (spec §10, terms §7).
    #
    # 07:05 BRT, five minutes behind the digest, and the hour is two decisions.
    #
    # *A civil hour, because it is a message about money.* The cheap slot would
    # be inside the 03:00–05:10 cluster, where the worker and the Neon compute
    # are awake anyway; an e-mail stamped 04:00 about a charge is not what
    # somebody wants to find. Daily, so one extra wake a day — a five-minute
    # suspend tail — is what the civility costs, and on Mondays it is free
    # because `weekly_digest` has already opened the wake.
    #
    # *Priority 9*, behind every collector: a late reminder degrades a promise
    # by minutes, a late `sync_open_tenders` loses an edital. The sweep itself
    # makes no HTTP call — it claims a `billing_reminders` row per charge and
    # enqueues one `send_billing_email` (priority 4, so it overtakes the
    # backlog but not a user on screen).
    #
    # **The alarm on it is not "0 queued".** Three days before a charge there
    # is usually nothing due, so zero is the normal answer; B32's lesson is
    # that a feed which never enqueues also never fails. The signal that
    # matters is the `billing.reminder_blocked` event this writes while
    # `worker/templates/email/charge-reminder.md` is still a draft — which is
    # today, and is deliberate: the copy is Sci's.
    ScheduleEntry(kind="charge_reminder", daily_at="07:05", priority=9),
    # **The other half of a one-click cancel (D8).** Terms §8: cancelling
    # switches off auto-renewal and paid access runs to the last day already
    # paid for. `subscriptions.ends_on` is that day;
    # `0004_subscription_refunds.sql` added it with the sentence *"the
    # downgrade job reads this every day"* and no such job existed, so the
    # column was read by nothing.
    #
    # 03:50 BRT: inside the existing overnight cluster, because this is pure
    # SQL and costs a job slot rather than a wake — and the boundary it acts on
    # is a date, so any hour of the day after `ends_on` is the same answer. One
    # statement, scoped to accounts with no *other* live subscription, so
    # somebody who cancelled and subscribed again is not dropped by the expiry
    # of the row they replaced.
    ScheduleEntry(kind="expire_subscriptions", daily_at="03:50", priority=9),
    # The safety net under ADR-0001's fallback. Every tender the search sweep
    # ingests arrives with no `estimated_value` — the index does not publish one
    # — and the fallback's own follow-up is queued at the moment
    # `/api/consulta` is known to be down, so it frequently fails. This comes
    # back for whatever is still unvalued, capped per cycle
    # (`tender_value.SWEEP_BATCH`) and backed off per tender via
    # `tenders.next_refresh_at`, so it drains a backlog over consecutive cycles
    # instead of queueing thousands of jobs in one tick.
    #
    # Hourly, **matching `sync_open_tenders`** — that is the point, not a
    # coincidence. A tender is worth showing a value for in the same cycle it
    # is worth showing at all, and sharing the cycle means sharing the wake:
    # two entries due at the same instant are one connection and one
    # five-minute tail, not two. If this ever drifts off `sync_open_tenders`'
    # cadence the compute saving of 2026-09-30 quietly halves, which is why
    # `test_scheduler.py` pins the two together. Priority 9 keeps it behind
    # every collector — a missing value degrades a card, it does not lose a
    # tender.
    ScheduleEntry(kind="sweep_tender_values", every_seconds=60 * 60, priority=9),
)


@dataclass
class Scheduler:
    """Enqueues due entries; sleeps in short ticks so it can be stopped."""

    connect: ConnectionFactory
    entries: tuple[ScheduleEntry, ...] = DEFAULT_SCHEDULE
    stop: threading.Event = field(default_factory=threading.Event)
    tick_seconds: float = DEFAULT_TICK_SECONDS
    now: Callable[[], datetime] = field(default=lambda: datetime.now(ZoneInfo("UTC")))
    #: Called after a tick that actually enqueued something, so the consumers
    #: pick it up **in the same wake window** instead of on their next poll.
    #:
    #: Without this the scheduler and the consumers are two independent reasons
    #: to open a connection, and Neon suspends after five minutes of having
    #: none: every wake costs a five-minute tail whether or not there is work
    #: in it. Measured 2026-09-30 — 5.5 h/day of compute, of which roughly 4 h
    #: was tail. Two unsynchronised half-hourly wake sources is the worst of
    #: both: you pay two tails an hour and still wait up to a poll interval for
    #: the work to start.
    #:
    #: It is also what makes a long `poll_interval` safe. The poll stops being
    #: how scheduled work is discovered and becomes a safety net under a lost
    #: notify, so it can be lengthened without a scheduled sync silently
    #: becoming a two-cycle one — which is the degradation `config.py` warns
    #: about, and the reason the interval could not simply be raised before.
    on_enqueue: Callable[[], None] | None = None
    _due: dict[str, datetime] = field(default_factory=dict, init=False)

    def __post_init__(self) -> None:
        start = self.now()
        self._due = {entry.kind: entry.next_due(start) for entry in self.entries}

    def run(self) -> None:
        _log.info("scheduler started", extra={"entries": [e.kind for e in self.entries]})
        while not self.stop.is_set():
            try:
                self.tick()
            except Exception as exc:
                capture_exception(exc)
                _log.error("scheduler tick failed", exc_info=True)
            self.stop.wait(self.tick_seconds)
        _log.info("scheduler stopped")

    def tick(self) -> int:
        """Enqueue everything that has come due. Returns how many were created."""
        now = self.now()
        ready = [entry for entry in self.entries if self._due.get(entry.kind, now) <= now]
        if not ready:
            return 0
        created = 0
        # Only now is a connection worth opening.
        with self.connect() as conn:
            for entry in ready:
                due = self._due[entry.kind]
                job_id = queue.enqueue(
                    conn,
                    entry.kind,
                    entry.key(due),
                    priority=entry.priority,
                    payload=entry.payload,
                )
                self._due[entry.kind] = entry.next_due(now)
                if job_id is None:
                    _log.info("schedule deduped", extra={"kind": entry.kind})
                else:
                    created += 1
                    _log.info("scheduled", extra={"kind": entry.kind, "job_id": job_id})
        # Outside the `with`: the connection this tick opened is already closed,
        # so the consumer's own connection reuses a compute that is certainly
        # still awake. Notifying inside would work too; doing it here keeps the
        # scheduler's connection as short as it has always been.
        if created and self.on_enqueue is not None:
            self.on_enqueue()
        return created
