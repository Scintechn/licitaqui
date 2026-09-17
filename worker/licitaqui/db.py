"""Short-lived psycopg 3 connections.

Every connection here is opened for a unit of work and closed again. The worker
must hold no connection while it is idle, otherwise the Neon compute never
suspends and the Free plan's 100 CU-hours are spent on an empty queue (§5.1).

Connections are autocommit: the claim statement in :mod:`licitaqui.queue` is a
single statement that must commit as soon as it returns, so a second consumer
sees the row as `running` instead of blocking on it.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager

import psycopg

from . import config

#: Called with no arguments, returns a context manager yielding a connection.
ConnectionFactory = Callable[[], AbstractContextManager[psycopg.Connection]]


@contextmanager
def connect(
    dsn: str | None = None,
    *,
    application_name: str = config.APPLICATION_NAME,
    connect_timeout: int = config.DEFAULT_CONNECT_TIMEOUT_SECONDS,
    statement_timeout: int = config.DEFAULT_STATEMENT_TIMEOUT_SECONDS,
) -> Iterator[psycopg.Connection]:
    """Open one autocommit connection and close it when the block exits."""
    conn = psycopg.connect(
        dsn or config.worker_dsn(),
        autocommit=True,
        connect_timeout=connect_timeout,
        application_name=application_name,
        options=f"-c statement_timeout={int(statement_timeout * 1000)}",
    )
    try:
        yield conn
    finally:
        conn.close()


def factory(
    dsn: str | None = None,
    *,
    application_name: str = config.APPLICATION_NAME,
    connect_timeout: int = config.DEFAULT_CONNECT_TIMEOUT_SECONDS,
    statement_timeout: int = config.DEFAULT_STATEMENT_TIMEOUT_SECONDS,
) -> ConnectionFactory:
    """Bind :func:`connect` to a DSN so callers never have to hold one."""

    def _open() -> AbstractContextManager[psycopg.Connection]:
        return connect(
            dsn,
            application_name=application_name,
            connect_timeout=connect_timeout,
            statement_timeout=statement_timeout,
        )

    return _open
