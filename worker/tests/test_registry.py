"""Job dispatch: kind → handler."""

from __future__ import annotations

import pytest

from licitaqui.jobs import noop  # noqa: F401 - imported so `noop` is registered
from licitaqui.registry import REGISTRY, JobRegistry, UnknownJobKind


def test_the_builtin_noop_kind_is_registered():
    assert "noop" in REGISTRY.kinds()


def test_an_unknown_kind_raises_rather_than_silently_succeeding():
    registry = JobRegistry()
    with pytest.raises(UnknownJobKind, match="sync_open_tenders"):
        registry.get("sync_open_tenders")


def test_registering_the_same_kind_twice_is_an_error():
    registry = JobRegistry()
    registry.register("demo", lambda ctx: None)
    with pytest.raises(ValueError, match="already registered"):
        registry.register("demo", lambda ctx: None)
    registry.register("demo", lambda ctx: None, replace=True)


def test_the_decorator_registers_and_returns_the_handler():
    registry = JobRegistry()

    @registry.job("demo")
    def handler(ctx):
        return "ran"

    assert registry.get("demo") is handler
    assert registry.kinds() == ["demo"]
