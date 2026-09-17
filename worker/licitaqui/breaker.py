"""Circuit breaker for external endpoints.

Spec §7.2: two consecutive failures against an endpoint (the PNCP detail
endpoint was measured timing out at 4 × 30 s, and one download hung for 929 s)
open the circuit for 15 minutes. While it is open, calls fail immediately with
:class:`CircuitOpen` instead of spending a job's whole timeout budget; after
the cooldown one probe is allowed through, and its result closes or reopens
the circuit.

This module owns the breaker only. The PNCP calls it will protect are B2's.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any, Literal

from . import config
from .observability import get_logger

State = Literal["closed", "open", "half_open"]

_log = get_logger("breaker")


class CircuitOpen(RuntimeError):
    """Raised instead of calling an endpoint whose circuit is open."""

    def __init__(self, name: str, retry_in: float) -> None:
        super().__init__(f"circuit '{name}' is open; retry in {retry_in:.0f}s")
        self.name = name
        self.retry_in = retry_in


class CircuitBreaker:
    """Consecutive-failure breaker. Safe to share between consumer threads."""

    def __init__(
        self,
        name: str,
        *,
        failure_threshold: int = config.BREAKER_FAILURE_THRESHOLD,
        reset_after: float = config.BREAKER_RESET_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.name = name
        self.failure_threshold = failure_threshold
        self.reset_after = reset_after
        self._clock = clock
        self._lock = threading.Lock()
        self._failures = 0
        self._opened_at: float | None = None
        self._probing = False

    @property
    def state(self) -> State:
        with self._lock:
            return self._state_locked()

    def _state_locked(self) -> State:
        if self._opened_at is None:
            return "closed"
        if self._clock() - self._opened_at >= self.reset_after:
            return "half_open"
        return "open"

    def _retry_in_locked(self) -> float:
        if self._opened_at is None:
            return 0.0
        return max(0.0, self.reset_after - (self._clock() - self._opened_at))

    def allow(self) -> bool:
        """Reserve a call slot. ``False`` means the circuit is open."""
        with self._lock:
            state = self._state_locked()
            if state == "closed":
                return True
            if state == "half_open" and not self._probing:
                self._probing = True
                return True
            return False

    def record_success(self) -> None:
        with self._lock:
            was_open = self._opened_at is not None
            self._failures = 0
            self._opened_at = None
            self._probing = False
        if was_open:
            _log.info("circuit closed", extra={"breaker": self.name})

    def record_failure(self) -> None:
        with self._lock:
            self._probing = False
            self._failures += 1
            if self._failures >= self.failure_threshold:
                self._opened_at = self._clock()
                opened = True
            else:
                opened = False
        if opened:
            _log.warning(
                "circuit opened",
                extra={
                    "breaker": self.name,
                    "failures": self._failures,
                    "reset_after_s": self.reset_after,
                },
            )

    @contextmanager
    def guard(self) -> Iterator[None]:
        """Run a block under the breaker, recording its outcome."""
        if not self.allow():
            with self._lock:
                retry_in = self._retry_in_locked()
            raise CircuitOpen(self.name, retry_in)
        try:
            yield
        except Exception:
            self.record_failure()
            raise
        else:
            self.record_success()

    def call(self, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        with self.guard():
            return fn(*args, **kwargs)

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "name": self.name,
                "state": self._state_locked(),
                "failures": self._failures,
                "retry_in_s": round(self._retry_in_locked(), 1),
            }


_registry: dict[str, CircuitBreaker] = {}
_registry_lock = threading.Lock()


def get_breaker(name: str, **kwargs: Any) -> CircuitBreaker:
    """Process-wide breaker for ``name``, created on first use."""
    with _registry_lock:
        breaker = _registry.get(name)
        if breaker is None:
            breaker = CircuitBreaker(name, **kwargs)
            _registry[name] = breaker
        return breaker


def snapshots() -> list[dict[str, Any]]:
    with _registry_lock:
        breakers = list(_registry.values())
    return [b.snapshot() for b in breakers]


def reset_all() -> None:
    """Drop every registered breaker. For tests."""
    with _registry_lock:
        _registry.clear()
