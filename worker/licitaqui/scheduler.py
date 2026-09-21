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
    ScheduleEntry(kind="sync_open_tenders", every_seconds=30 * 60, priority=5),
    ScheduleEntry(kind="sync_awards", daily_at="03:00", priority=9),
    ScheduleEntry(kind="weekly_digest", daily_at="07:00", priority=9, weekday=0),
)


@dataclass
class Scheduler:
    """Enqueues due entries; sleeps in short ticks so it can be stopped."""

    connect: ConnectionFactory
    entries: tuple[ScheduleEntry, ...] = DEFAULT_SCHEDULE
    stop: threading.Event = field(default_factory=threading.Event)
    tick_seconds: float = DEFAULT_TICK_SECONDS
    now: Callable[[], datetime] = field(default=lambda: datetime.now(ZoneInfo("UTC")))
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
        return created
