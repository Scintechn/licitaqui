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
    """

    kind: str
    every_seconds: float | None = None
    daily_at: str | None = None
    timezone: str = BRT
    priority: int = 5
    payload: dict[str, Any] | None = None
    key_for: Callable[[datetime], str] | None = None

    def __post_init__(self) -> None:
        if (self.every_seconds is None) == (self.daily_at is None):
            raise ValueError("set exactly one of every_seconds or daily_at")

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
        return due.astimezone(ZoneInfo("UTC"))

    def key(self, due: datetime) -> str:
        if self.key_for is not None:
            return self.key_for(due)
        return due.astimezone(ZoneInfo(self.timezone)).strftime("%Y-%m-%dT%H:%M")


#: Nothing to schedule yet: the collector jobs arrive with B2 to B4.
DEFAULT_SCHEDULE: tuple[ScheduleEntry, ...] = ()


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
