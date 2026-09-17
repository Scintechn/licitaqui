"""The consumer loop.

One consumer repeats: open a connection, drain every due job, close the
connection, then wait — either for the 2-minute poll interval to elapse or for
`POST /wake` to signal that a priority-1 job is waiting (§5.1, §7.3).

The connection is deliberately scoped to the drain. While the loop is idle the
process holds no connection and issues no query, which is what lets the Neon
compute suspend; a consumer that kept a session open (or polled every few
seconds) would keep the compute awake and eat the Free plan's 100 CU-hours.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Sequence
from dataclasses import dataclass, field

import psycopg

from . import config, queue
from .db import ConnectionFactory
from .observability import capture_exception, get_logger
from .queue import Job
from .registry import REGISTRY, JobContext, JobRegistry

_log = get_logger("consumer")


class WakeSignal:
    """A poll interval that `POST /wake` can cut short."""

    def __init__(self) -> None:
        self._event = threading.Event()

    def notify(self) -> None:
        self._event.set()

    def wait(self, timeout: float) -> bool:
        """Block up to ``timeout`` seconds. ``True`` when a wake arrived."""
        woken = self._event.wait(timeout)
        self._event.clear()
        return woken


@dataclass
class Metrics:
    """Counters for the health endpoint."""

    processed: int = 0
    failed: int = 0
    retried: int = 0
    drains: int = 0
    last_finished_at: float | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def record_drain(self) -> None:
        """One completed pass over the queue; the loop is now idle again."""
        with self._lock:
            self.drains += 1

    def record(self, outcome: str) -> None:
        with self._lock:
            self.processed += 1
            if outcome == "failed":
                self.failed += 1
            elif outcome == "queued":
                self.retried += 1
            self.last_finished_at = time.time()

    def snapshot(self) -> dict[str, float | int | None]:
        with self._lock:
            return {
                "processed": self.processed,
                "failed": self.failed,
                "retried": self.retried,
                "drains": self.drains,
                "last_finished_at": self.last_finished_at,
            }


class Consumer:
    """Claims and runs jobs until it is told to stop."""

    def __init__(
        self,
        connect: ConnectionFactory,
        *,
        name: str = "consumer",
        registry: JobRegistry = REGISTRY,
        wake: WakeSignal | None = None,
        stop: threading.Event | None = None,
        metrics: Metrics | None = None,
        poll_interval: float = config.DEFAULT_POLL_INTERVAL_SECONDS,
        error_pause: float = config.DEFAULT_ERROR_PAUSE_SECONDS,
        stale_after: int = config.STALE_RUNNING_SECONDS,
        max_attempts: int = config.MAX_ATTEMPTS,
        backoff: tuple[int, ...] = config.BACKOFF_SECONDS,
        kinds: Sequence[str] | None = None,
    ) -> None:
        self.name = name
        self.connect = connect
        self.registry = registry
        self.wake = wake or WakeSignal()
        self.stop = stop or threading.Event()
        self.metrics = metrics or Metrics()
        self.poll_interval = poll_interval
        self.error_pause = error_pause
        self.stale_after = stale_after
        self.max_attempts = max_attempts
        self.backoff = backoff
        self.kinds = None if kinds is None else tuple(kinds)
        self._last_stale_check = 0.0

    # -- the loop ---------------------------------------------------------

    def run(self) -> None:
        _log.info(
            "consumer started",
            extra={"consumer": self.name, "poll_interval_s": self.poll_interval},
        )
        while not self.stop.is_set():
            pause = self.poll_interval
            try:
                self.drain()
                self.metrics.record_drain()
            except Exception as exc:  # the database, not a job: back off and retry
                capture_exception(exc)
                _log.error("drain failed", exc_info=True, extra={"consumer": self.name})
                pause = min(self.error_pause, self.poll_interval)
            if self.stop.is_set():
                break
            # No connection is open here: this is where Neon is allowed to suspend.
            self.wake.wait(pause)
        _log.info("consumer stopped", extra={"consumer": self.name})

    def drain(self) -> int:
        """Run every due job, then close the connection. Returns the count."""
        processed = 0
        with self.connect() as conn:
            self._requeue_stale(conn)
            while not self.stop.is_set():
                job = queue.claim(conn, kinds=self.kinds)
                if job is None:
                    break
                self.execute(conn, job)
                processed += 1
        return processed

    # -- one job ----------------------------------------------------------

    def execute(self, conn: psycopg.Connection, job: Job) -> str:
        """Run one claimed job and record its outcome. Returns the status."""
        started = time.monotonic()
        base = {
            "consumer": self.name,
            "job_id": job.id,
            "kind": job.kind,
            "key": job.key,
            "priority": job.priority,
            "attempt": job.attempts,
        }
        try:
            handler = self.registry.get(job.kind)
            handler(JobContext(job=job, conn=conn, connect=self.connect, log=_log))
        except Exception as exc:
            status = queue.mark_failed(
                conn,
                job,
                f"{type(exc).__name__}: {exc}",
                max_attempts=self.max_attempts,
                backoff=self.backoff,
            )
            capture_exception(exc)
            _log.warning(
                "job failed",
                exc_info=True,
                extra={**base, "status": status, "duration_ms": _ms(started)},
            )
        else:
            queue.mark_done(conn, job.id)
            status = "done"
            _log.info("job done", extra={**base, "duration_ms": _ms(started)})
        self.metrics.record(status)
        return status

    # -- housekeeping -----------------------------------------------------

    def _requeue_stale(self, conn: psycopg.Connection) -> None:
        """Reclaim jobs abandoned by a consumer that died, at most hourly."""
        now = time.monotonic()
        if now - self._last_stale_check < self.stale_after:
            return
        self._last_stale_check = now
        count = queue.requeue_stale(conn, older_than_seconds=self.stale_after, kinds=self.kinds)
        if count:
            _log.warning("requeued stale jobs", extra={"consumer": self.name, "count": count})


def _ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)
