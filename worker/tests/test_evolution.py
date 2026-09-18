"""The Evolution API client: the kill switch, the Cloudflare header, the errors.

**No test in this file — or anywhere in this suite — reaches the network.**
Responses are replayed from `tests/fixtures/evolution/` through an
`httpx.MockTransport`, and the tests that matter most go further and make the
socket layer itself raise, so "nothing left the process" is asserted rather
than assumed.
"""

from __future__ import annotations

import json
import socket
from pathlib import Path
from typing import Any

import httpx
import pytest

from licitaqui import breaker, evolution
from licitaqui.evolution import (
    DELIVERY_SEND,
    DELIVERY_VAR,
    USER_AGENT,
    EvolutionClient,
    EvolutionError,
    SendingDisabled,
)

FIXTURES = Path(__file__).parent / "fixtures" / "evolution"
RECORDED_200 = json.loads((FIXTURES / "send_text_200.json").read_text())
RECORDED_CLOUDFLARE = (FIXTURES / "cloudflare_1010.html").read_text()

NUMBER = "+55 11 99999-0000"
TEXT = "Oi, Maria! Aqui é a LicitaQui."


@pytest.fixture(autouse=True)
def _fresh_breaker() -> None:
    """The breaker registry is process-wide; a failure here must not leak."""
    breaker.reset_all()


@pytest.fixture
def switch_on(monkeypatch: pytest.MonkeyPatch) -> None:
    """Turn the kill switch on for the tests that exercise the request itself.

    Safe only because every one of them is bolted to an `httpx.MockTransport`:
    the switch lets the code build a request, and the transport is where it
    stops.
    """
    monkeypatch.setenv(DELIVERY_VAR, DELIVERY_SEND)


def recorder(status: int = 200, body: Any = RECORDED_200, text: str | None = None):
    """A MockTransport that records the request it was handed."""
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if text is not None:
            return httpx.Response(status, text=text)
        return httpx.Response(status, json=body)

    return httpx.MockTransport(handle), seen


def client(transport: httpx.BaseTransport) -> EvolutionClient:
    return EvolutionClient(
        base_url="https://evolutiondev.example.invalid",
        api_key="not-a-real-key",
        instance="licitaqui-test",
        transport=transport,
    )


# -- the kill switch -------------------------------------------------------


def test_the_switch_is_off_by_default() -> None:
    """Unset is the state of CI, a laptop and a fresh container."""
    assert evolution.delivery_mode() == "dry_run"
    assert not evolution.sending_enabled()


@pytest.mark.parametrize(
    "value", ["", "0", "1", "true", "yes", "on", "SEND", "Send", "sendd", "send now", "enabled"]
)
def test_only_the_exact_word_send_enables_delivery(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    """`=1` is the value that arrives by accident. It must not be enough.

    Every truthy spelling a feature flag usually accepts is here, because those
    are exactly what a copy-pasted env block or a "turn everything on" compose
    file contains. None of them may reach a stranger's phone.
    """
    monkeypatch.setenv(DELIVERY_VAR, value)

    assert not evolution.sending_enabled(), f"{value!r} enabled real delivery"


@pytest.mark.parametrize("value", ["send", " send", "send "])
def test_send_is_the_one_value_that_enables_delivery(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    """Surrounding whitespace is forgiven; nothing else is.

    A trailing space in an env file is a typo in the *file*, not in the intent —
    somebody still typed the word. Anything that changes the word does not.
    """
    monkeypatch.setenv(DELIVERY_VAR, value)

    assert evolution.sending_enabled()


def test_with_the_switch_off_no_socket_is_opened(monkeypatch: pytest.MonkeyPatch) -> None:
    """The guarantee, asserted at the lowest layer there is.

    Not "httpx was not called" — *no connection was attempted at all*, by httpx
    or by anything else. If a future edit routes around the client entirely and
    opens a socket, this fails.
    """
    attempts: list[Any] = []

    def forbidden(*args: Any, **kwargs: Any) -> Any:
        attempts.append(args)
        raise AssertionError("a connection was attempted with the kill switch off")

    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(httpx.Client, "send", forbidden)

    result = EvolutionClient().send_text(NUMBER, TEXT)

    assert result.status == "dry_run"
    assert not result.delivered
    assert attempts == []


def test_dry_run_needs_no_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    """A worker that never sends must not need Evolution configured at all."""
    for var in (evolution.API_URL_VAR, evolution.API_KEY_VAR, evolution.INSTANCE_VAR):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(evolution.config, "resolve_secret", lambda *a, **k: None)

    assert EvolutionClient().send_text(NUMBER, TEXT).status == "dry_run"


def test_the_transport_refuses_to_be_called_behind_the_switch() -> None:
    """Second gate: reaching `post_text` with the switch off is a loud bug."""
    transport, seen = recorder()

    with pytest.raises(SendingDisabled):
        client(transport).post_text("5511999990000", TEXT)

    assert seen == []


# -- the request -----------------------------------------------------------


def test_the_request_carries_a_browser_user_agent(switch_on: None) -> None:
    """Cloudflare answers 1010 to a default Python client. Verified fact, §E2."""
    transport, seen = recorder()

    client(transport).send_text(NUMBER, TEXT)

    assert len(seen) == 1
    assert seen[0].headers["user-agent"] == USER_AGENT
    assert USER_AGENT.startswith("Mozilla/5.0") and "Chrome/" in USER_AGENT
    assert "python-httpx" not in seen[0].headers["user-agent"]


def test_the_request_shape(switch_on: None) -> None:
    transport, seen = recorder()

    result = client(transport).send_text(NUMBER, TEXT)

    request = seen[0]
    assert request.method == "POST"
    assert str(request.url) == (
        "https://evolutiondev.example.invalid/message/sendText/licitaqui-test"
    )
    assert request.headers["apikey"] == "not-a-real-key"
    assert json.loads(request.content) == {"number": "5511999990000", "text": TEXT}
    assert result.status == "sent"
    assert result.message_id == "3EB0F3C9A1B2C3D4E5F6"
    assert result.status_code == 200


def test_a_cloudflare_block_is_named_rather_than_guessed_at(switch_on: None) -> None:
    """A bare 403 sends someone hunting for an auth problem that is not there."""
    transport, _ = recorder(403, text=RECORDED_CLOUDFLARE)

    with pytest.raises(EvolutionError) as caught:
        client(transport).send_text(NUMBER, TEXT)

    assert caught.value.reason == "cloudflare_1010_client_fingerprint"
    assert not caught.value.retryable


@pytest.mark.parametrize(
    ("status", "reason", "retryable"),
    [
        (401, "unauthorised", False),
        (404, "instance_or_route_not_found", False),
        (429, "rate_limited", True),
        (500, "http_error", True),
        (502, "http_error", True),
    ],
)
def test_failures_are_classified(
    switch_on: None, status: int, reason: str, retryable: bool
) -> None:
    transport, _ = recorder(status, body={"message": "5511999990000 is not on WhatsApp"})

    with pytest.raises(EvolutionError) as caught:
        client(transport).send_text(NUMBER, TEXT)

    assert caught.value.reason == reason
    assert caught.value.retryable is retryable
    # §12: the response body quotes the number back. It must not travel.
    assert "5511999990000" not in str(caught.value)


def test_a_timeout_does_not_leak_the_request(switch_on: None) -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out", request=request)

    with pytest.raises(EvolutionError) as caught:
        client(httpx.MockTransport(handle)).send_text(NUMBER, TEXT)

    assert caught.value.reason == "timeout"
    assert caught.value.__cause__ is None
    assert "5511999990000" not in str(caught.value)


def test_two_failures_open_the_circuit(switch_on: None) -> None:
    """Spec §7.2, through the breaker the rest of the worker already uses."""
    transport, seen = recorder(500)
    evolution_client = client(transport)

    for _ in range(2):
        with pytest.raises(EvolutionError):
            evolution_client.send_text(NUMBER, TEXT)

    with pytest.raises(Exception) as caught:
        evolution_client.send_text(NUMBER, TEXT)

    assert type(caught.value).__name__ == "CircuitOpen"
    assert len(seen) == 2, "the third call should never have reached the transport"


# -- numbers ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("+5511999990000", "5511999990000"),
        ("+55 (11) 99999-0000", "5511999990000"),
        ("11999990000", "5511999990000"),
        ("5511999990000", "5511999990000"),
        ("+551133330000", "551133330000"),
    ],
)
def test_normalise_number(raw: str, expected: str) -> None:
    assert evolution.normalise_number(raw) == expected


@pytest.mark.parametrize("raw", ["", "123", "0099999990000", "119999900001234"])
def test_a_number_that_is_not_dialable_raises_without_quoting_itself(raw: str) -> None:
    with pytest.raises(ValueError) as caught:
        evolution.normalise_number(raw)

    assert raw.strip() not in str(caught.value) or not raw.strip()


@pytest.mark.parametrize("raw", ["+1 415 555 0000", "+14155550000", "+351 912 345 678"])
def test_a_foreign_number_is_refused_rather_than_reinterpreted(raw: str) -> None:
    """`+1 415 555 0000` stripped of its `+` is a valid-looking São Paulo mobile.

    Without this it would be dialled as `5514155550000` — LicitaQui's founders
    welcome, to a stranger in California.
    """
    with pytest.raises(ValueError, match="Brazilian"):
        evolution.normalise_number(raw)
