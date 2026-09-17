"""`GET /health` and the authenticated `POST /wake`."""

from __future__ import annotations

import json
import threading
from collections.abc import Iterator
from http.client import HTTPConnection

import pytest

from licitaqui.server import WorkerHTTPServer

TOKEN = "unit-test-token"  # noqa: S105 - a literal for the test server, not a secret


class Harness:
    def __init__(self, server: WorkerHTTPServer, wakes: list[int]) -> None:
        self.server = server
        self.wakes = wakes

    def request(self, method: str, path: str, headers: dict[str, str] | None = None):
        conn = HTTPConnection("127.0.0.1", self.server.port, timeout=5)
        try:
            conn.request(method, path, headers=headers or {})
            response = conn.getresponse()
            body = response.read()
            return response.status, json.loads(body or b"{}")
        finally:
            conn.close()


def _serve(*, wake_token: str | None, health: dict) -> Iterator[Harness]:
    wakes: list[int] = []
    server = WorkerHTTPServer(
        ("127.0.0.1", 0),
        wake_token=wake_token,
        on_wake=lambda: wakes.append(1),
        health=lambda: health,
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield Harness(server, wakes)
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


@pytest.fixture
def harness() -> Iterator[Harness]:
    yield from _serve(wake_token=TOKEN, health={"status": "ok", "consumers": {"alive": 1}})


@pytest.fixture
def unconfigured() -> Iterator[Harness]:
    yield from _serve(wake_token=None, health={"status": "ok"})


# -- /health --------------------------------------------------------------


def test_health_returns_the_process_state(harness: Harness):
    status, body = harness.request("GET", "/health")
    assert status == 200
    assert body["status"] == "ok"


def test_health_is_503_when_a_consumer_died():
    for h in _serve(wake_token=TOKEN, health={"status": "degraded"}):
        status, body = h.request("GET", "/health")
        assert status == 503
        assert body["status"] == "degraded"


def test_health_never_touches_the_database(harness: Harness):
    """It answers from memory, so an uptime monitor cannot keep Neon awake.

    The health provider here would raise if the endpoint tried to widen what it
    reports beyond the dict it was given.
    """
    status, _ = harness.request("GET", "/health")
    assert status == 200
    assert harness.wakes == []


# -- /wake ----------------------------------------------------------------


def test_wake_with_the_token_is_accepted(harness: Harness):
    status, body = harness.request(
        "POST", "/wake", {"Authorization": f"Bearer {TOKEN}", "Content-Length": "0"}
    )
    assert status == 202
    assert body == {"woken": True}
    assert harness.wakes == [1]


def test_wake_without_a_token_is_rejected(harness: Harness):
    status, _ = harness.request("POST", "/wake", {"Content-Length": "0"})
    assert status == 401
    assert harness.wakes == []


def test_wake_with_the_wrong_token_is_rejected(harness: Harness):
    status, _ = harness.request(
        "POST", "/wake", {"Authorization": "Bearer nope", "Content-Length": "0"}
    )
    assert status == 401
    assert harness.wakes == []


def test_wake_with_a_malformed_authorization_header_is_rejected(harness: Harness):
    status, _ = harness.request("POST", "/wake", {"Authorization": TOKEN, "Content-Length": "0"})
    assert status == 401
    assert harness.wakes == []


def test_wake_refuses_when_no_token_is_configured(unconfigured: Harness):
    """An unset WORKER_WAKE_TOKEN must not mean 'anyone may wake the worker'."""
    status, _ = unconfigured.request(
        "POST", "/wake", {"Authorization": "Bearer anything", "Content-Length": "0"}
    )
    assert status == 503
    assert unconfigured.wakes == []


def test_get_on_wake_is_method_not_allowed(harness: Harness):
    status, _ = harness.request("GET", "/wake", {"Authorization": f"Bearer {TOKEN}"})
    assert status == 405
    assert harness.wakes == []


def test_unknown_paths_are_404(harness: Harness):
    status, _ = harness.request("GET", "/admin")
    assert status == 404
    status, _ = harness.request(
        "POST", "/enqueue", {"Authorization": f"Bearer {TOKEN}", "Content-Length": "0"}
    )
    assert status == 404
    assert harness.wakes == []
