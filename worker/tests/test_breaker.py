"""Circuit breaker: 2 consecutive failures open it for 15 minutes (§7.2)."""

from __future__ import annotations

import pytest

from licitaqui import breaker as breaker_module
from licitaqui.breaker import CircuitBreaker, CircuitOpen


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def cb(clock: FakeClock) -> CircuitBreaker:
    return CircuitBreaker("pncp-detail", failure_threshold=2, reset_after=900.0, clock=clock)


def boom() -> None:
    raise TimeoutError("read timed out after 30s")


def test_defaults_match_the_spec():
    from licitaqui import config

    assert config.BREAKER_FAILURE_THRESHOLD == 2
    assert config.BREAKER_RESET_SECONDS == 900.0


def test_one_failure_keeps_the_circuit_closed(cb: CircuitBreaker):
    with pytest.raises(TimeoutError):
        cb.call(boom)
    assert cb.state == "closed"


def test_two_consecutive_failures_open_it(cb: CircuitBreaker):
    for _ in range(2):
        with pytest.raises(TimeoutError):
            cb.call(boom)
    assert cb.state == "open"


def test_an_open_circuit_fails_fast_without_calling(cb: CircuitBreaker):
    calls = []
    for _ in range(2):
        with pytest.raises(TimeoutError):
            cb.call(boom)
    with pytest.raises(CircuitOpen):
        cb.call(lambda: calls.append(1))
    assert calls == [], "the endpoint must not be called while the circuit is open"


def test_a_success_in_between_resets_the_counter(cb: CircuitBreaker):
    with pytest.raises(TimeoutError):
        cb.call(boom)
    cb.call(lambda: "ok")
    with pytest.raises(TimeoutError):
        cb.call(boom)
    assert cb.state == "closed"


def test_after_the_cooldown_one_probe_is_allowed(cb: CircuitBreaker, clock: FakeClock):
    for _ in range(2):
        with pytest.raises(TimeoutError):
            cb.call(boom)
    clock.advance(899)
    with pytest.raises(CircuitOpen):
        cb.call(lambda: "ok")
    clock.advance(2)
    assert cb.state == "half_open"
    assert cb.call(lambda: "ok") == "ok"
    assert cb.state == "closed"


def test_a_failed_probe_reopens_the_circuit(cb: CircuitBreaker, clock: FakeClock):
    for _ in range(2):
        with pytest.raises(TimeoutError):
            cb.call(boom)
    clock.advance(901)
    with pytest.raises(TimeoutError):
        cb.call(boom)
    assert cb.state == "open"
    with pytest.raises(CircuitOpen):
        cb.call(lambda: "ok")


def test_only_one_probe_gets_through_at_a_time(cb: CircuitBreaker, clock: FakeClock):
    for _ in range(2):
        with pytest.raises(TimeoutError):
            cb.call(boom)
    clock.advance(901)
    assert cb.allow() is True
    assert cb.allow() is False


def test_open_error_reports_the_remaining_cooldown(cb: CircuitBreaker, clock: FakeClock):
    for _ in range(2):
        with pytest.raises(TimeoutError):
            cb.call(boom)
    clock.advance(300)
    with pytest.raises(CircuitOpen) as excinfo:
        cb.call(lambda: "ok")
    assert excinfo.value.retry_in == pytest.approx(600, abs=1)


def test_the_registry_returns_one_breaker_per_name():
    breaker_module.reset_all()
    try:
        first = breaker_module.get_breaker("pncp-search")
        assert breaker_module.get_breaker("pncp-search") is first
        assert breaker_module.get_breaker("brasilapi") is not first
        assert {b["name"] for b in breaker_module.snapshots()} == {"pncp-search", "brasilapi"}
    finally:
        breaker_module.reset_all()
