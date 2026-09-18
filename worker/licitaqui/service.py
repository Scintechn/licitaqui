"""Wires the worker process together: HTTP surface, consumers, scheduler.

One container runs one of these. Scaling out means running more containers (or
raising ``WORKER_CONCURRENCY``); the claim statement is what makes that safe,
not any coordination here.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from typing import Any

from . import ai_screening as _ai_screening  # noqa: F401 - registers ai_screening
from . import breaker, config, db
from . import handlers as _handlers  # noqa: F401 - imports every handler module
from .consumer import Consumer, Metrics, WakeSignal
from .observability import get_logger
from .registry import REGISTRY, JobRegistry
from .scheduler import DEFAULT_SCHEDULE, ScheduleEntry, Scheduler
from .server import WorkerHTTPServer

_log = get_logger("service")


@dataclass
class WorkerService:
    dsn: str
    wake_token: str | None = None
    host: str = "0.0.0.0"  # noqa: S104 - the container publishes this port
    port: int = config.DEFAULT_PORT
    concurrency: int = config.DEFAULT_CONCURRENCY
    poll_interval: float = config.DEFAULT_POLL_INTERVAL_SECONDS
    schedule: tuple[ScheduleEntry, ...] = DEFAULT_SCHEDULE
    scheduler_enabled: bool = True
    registry: JobRegistry = REGISTRY
    #: Restrict this container to part of the queue; None means all kinds.
    kinds: tuple[str, ...] | None = None

    def __post_init__(self) -> None:
        self.stop = threading.Event()
        self.wake = WakeSignal()
        self.metrics = Metrics()
        self.started_at = time.time()
        self.connect = db.factory(self.dsn)
        self._threads: list[threading.Thread] = []
        self._consumers: list[Consumer] = []
        self._scheduler: Scheduler | None = None
        self._http: WorkerHTTPServer | None = None

    # -- lifecycle --------------------------------------------------------

    @classmethod
    def from_env(cls) -> WorkerService:
        return cls(
            dsn=config.worker_dsn(),
            wake_token=config.wake_token(),
            port=config.env_int("WORKER_PORT", config.DEFAULT_PORT),
            concurrency=config.env_int("WORKER_CONCURRENCY", config.DEFAULT_CONCURRENCY),
            poll_interval=config.env_float(
                "WORKER_POLL_INTERVAL_SECONDS", config.DEFAULT_POLL_INTERVAL_SECONDS
            ),
            scheduler_enabled=config.env_bool("WORKER_SCHEDULER", True),
            kinds=config.env_list("WORKER_JOB_KINDS"),
        )

    def start(self) -> None:
        self._http = WorkerHTTPServer(
            (self.host, self.port),
            wake_token=self.wake_token,
            on_wake=self.wake.notify,
            health=self.health,
        )
        self._spawn("http", self._http.serve_forever)

        for index in range(self.concurrency):
            consumer = Consumer(
                self.connect,
                name=f"consumer-{index + 1}",
                registry=self.registry,
                wake=self.wake,
                stop=self.stop,
                metrics=self.metrics,
                poll_interval=self.poll_interval,
                kinds=self.kinds,
            )
            self._consumers.append(consumer)
            self._spawn(consumer.name, consumer.run)

        if self.scheduler_enabled:
            self._scheduler = Scheduler(self.connect, entries=self.schedule, stop=self.stop)
            self._spawn("scheduler", self._scheduler.run)

        if not self.wake_token:
            _log.warning("WORKER_WAKE_TOKEN is unset: POST /wake will refuse every call")
        _log.info(
            "worker started",
            extra={
                "port": self.port,
                "concurrency": self.concurrency,
                "poll_interval_s": self.poll_interval,
                "registered_kinds": self.registry.kinds(),
                "claiming_kinds": list(self.kinds) if self.kinds else "all",
                "scheduler": self.scheduler_enabled,
            },
        )

    def shutdown(self, timeout: float = 30.0) -> None:
        """Stop accepting work and let the running job finish."""
        _log.info("worker stopping")
        self.stop.set()
        self.wake.notify()
        if self._http is not None:
            self._http.shutdown()
            self._http.server_close()
        deadline = time.monotonic() + timeout
        for thread in self._threads:
            thread.join(max(0.0, deadline - time.monotonic()))
        _log.info("worker stopped")

    def run(self) -> None:  # pragma: no cover - exercised by `python -m licitaqui`
        self.start()
        try:
            while not self.stop.wait(1.0):
                pass
        finally:
            self.shutdown()

    def _spawn(self, name: str, target: Any) -> None:
        thread = threading.Thread(target=target, name=name, daemon=True)
        thread.start()
        self._threads.append(thread)

    # -- health -----------------------------------------------------------

    def health(self) -> dict[str, Any]:
        """Process state only: no query, so a monitor cannot wake Neon."""
        alive = [t.name for t in self._threads if t.is_alive()]
        expected_consumers = self.concurrency
        live_consumers = sum(1 for c in self._consumers if c.name in alive)
        healthy = live_consumers == expected_consumers and not self.stop.is_set()
        return {
            "status": "ok" if healthy else "degraded",
            "uptime_seconds": round(time.time() - self.started_at, 1),
            "consumers": {"configured": expected_consumers, "alive": live_consumers},
            "scheduler": {
                "enabled": self.scheduler_enabled,
                "alive": "scheduler" in alive,
            },
            "jobs": self.metrics.snapshot(),
            "poll_interval_seconds": self.poll_interval,
            "wake_configured": bool(self.wake_token),
            "breakers": breaker.snapshots(),
        }
