"""Job-kind registry and the context a handler receives.

A handler is ``Callable[[JobContext], None]``. Returning means the job is
`done`; raising means the attempt failed and the consumer applies the backoff
in :mod:`licitaqui.queue`. Handlers must be idempotent: a job can run twice
(§7.2), for instance when a consumer dies after doing the work but before
marking the row.

B1 ships only the ``noop`` kind (see :mod:`licitaqui.jobs`). The real kinds —
``sync_open_tenders``, ``sync_items``, ``sync_files`` — are B2 to B4 and
register themselves the same way.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass
from logging import Logger
from typing import Any

import psycopg

from .db import ConnectionFactory
from .queue import Job


class UnknownJobKind(RuntimeError):
    """No handler is registered for the kind stored on the row."""

    def __init__(self, kind: str) -> None:
        super().__init__(f"no handler registered for job kind '{kind}'")
        self.kind = kind


@dataclass(frozen=True, slots=True)
class JobContext:
    """What a handler gets: the row, a connection, and a bound logger.

    ``conn`` is the consumer's own autocommit connection, already open and
    reused for the claim. Use ``connect()`` instead when a handler needs a
    second, independent connection (a long transaction, a different timeout).
    """

    job: Job
    conn: psycopg.Connection
    connect: ConnectionFactory
    log: Logger

    @property
    def payload(self) -> dict[str, Any]:
        return self.job.payload or {}


JobHandler = Callable[[JobContext], None]


class JobRegistry:
    """Kind → handler. Registration happens at import time, so it is locked."""

    def __init__(self) -> None:
        self._handlers: dict[str, JobHandler] = {}
        self._lock = threading.Lock()

    def register(self, kind: str, handler: JobHandler, *, replace: bool = False) -> None:
        with self._lock:
            if kind in self._handlers and not replace:
                raise ValueError(f"job kind '{kind}' is already registered")
            self._handlers[kind] = handler

    def unregister(self, kind: str) -> None:
        with self._lock:
            self._handlers.pop(kind, None)

    def job(self, kind: str, *, replace: bool = False) -> Callable[[JobHandler], JobHandler]:
        """Decorator form: ``@REGISTRY.job("sync_items")``."""

        def decorate(handler: JobHandler) -> JobHandler:
            self.register(kind, handler, replace=replace)
            return handler

        return decorate

    def get(self, kind: str) -> JobHandler:
        with self._lock:
            handler = self._handlers.get(kind)
        if handler is None:
            raise UnknownJobKind(kind)
        return handler

    def kinds(self) -> list[str]:
        with self._lock:
            return sorted(self._handlers)


#: The registry the worker process runs from.
REGISTRY = JobRegistry()
