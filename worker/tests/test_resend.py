"""The Resend client: the kill switch, the request shape, the errors.

Mirrors `tests/test_evolution.py` — read that file's docstring first. **No test
in this file — or anywhere in this suite — reaches the network.** Responses are
replayed from `tests/fixtures/resend/` through an `httpx.MockTransport`, and
the tests that matter most go further and make the socket layer itself raise,
so "nothing left the process" is asserted rather than assumed.
"""

from __future__ import annotations

import json
import socket
from pathlib import Path
from typing import Any

import httpx
import pytest

from licitaqui import breaker, resend
from licitaqui.resend import (
    DELIVERY_SEND,
    DELIVERY_VAR,
    ResendClient,
    ResendError,
    SendingDisabled,
)

FIXTURES = Path(__file__).parent / "fixtures" / "resend"
RECORDED_200 = json.loads((FIXTURES / "send_200.json").read_text())

TO = "maria@example.com"
SUBJECT = "Sua vaga de fundador na LicitaQui é a número 7"
TEXT = "Oi, Maria."


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


def client(transport: httpx.BaseTransport) -> ResendClient:
    return ResendClient(
        api_key="not-a-real-key",
        from_address="LicitaQui <founders@licitaquiapp.com.br>",
        transport=transport,
    )


# -- the kill switch ---------------------------------------------------------


def test_the_switch_is_off_by_default() -> None:
    """Unset is the state of CI, a laptop and a fresh container."""
    assert resend.delivery_mode() == "dry_run"
    assert not resend.sending_enabled()


@pytest.mark.parametrize(
    "value", ["", "0", "1", "true", "yes", "on", "SEND", "Send", "sendd", "send now", "enabled"]
)
def test_only_the_exact_word_send_enables_delivery(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    """Every truthy spelling a feature flag usually accepts, and none of them
    may reach a stranger's inbox — the same property `evolution.py` pins."""
    monkeypatch.setenv(DELIVERY_VAR, value)

    assert not resend.sending_enabled(), f"{value!r} enabled real delivery"


@pytest.mark.parametrize("value", ["send", " send", "send "])
def test_send_is_the_one_value_that_enables_delivery(
    monkeypatch: pytest.MonkeyPatch, value: str
) -> None:
    monkeypatch.setenv(DELIVERY_VAR, value)

    assert resend.sending_enabled()


def test_the_switch_is_independent_of_whatsapp_delivery(monkeypatch: pytest.MonkeyPatch) -> None:
    """A mistake flipping one channel on must not silently flip the other."""
    monkeypatch.setenv("WHATSAPP_DELIVERY", "send")
    monkeypatch.delenv(DELIVERY_VAR, raising=False)

    assert not resend.sending_enabled()


def test_with_the_switch_off_no_socket_is_opened(monkeypatch: pytest.MonkeyPatch) -> None:
    """The guarantee, asserted at the lowest layer there is."""
    attempts: list[Any] = []

    def forbidden(*args: Any, **kwargs: Any) -> Any:
        attempts.append(args)
        raise AssertionError("a connection was attempted with the kill switch off")

    monkeypatch.setattr(socket.socket, "connect", forbidden)
    monkeypatch.setattr(socket.socket, "connect_ex", forbidden)
    monkeypatch.setattr(socket, "create_connection", forbidden)
    monkeypatch.setattr(httpx.Client, "send", forbidden)

    result = ResendClient().send(to=TO, subject=SUBJECT, text=TEXT)

    assert result.status == "dry_run"
    assert not result.delivered
    assert attempts == []


def test_dry_run_needs_no_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    """A worker that never sends must not need Resend configured at all."""
    for var in (*resend.API_KEY_VARS, resend.FROM_VAR):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(resend.config, "resolve_secret", lambda *a, **k: None)

    assert ResendClient().send(to=TO, subject=SUBJECT, text=TEXT).status == "dry_run"


def test_the_transport_refuses_to_be_called_behind_the_switch() -> None:
    """Second gate: reaching `post_email` with the switch off is a loud bug."""
    transport, seen = recorder()

    with pytest.raises(SendingDisabled):
        client(transport).post_email(to=TO, subject=SUBJECT, text=TEXT)

    assert seen == []


# -- the request ---------------------------------------------------------------


def test_the_request_shape(switch_on: None) -> None:
    transport, seen = recorder()

    result = client(transport).send(to=TO, subject=SUBJECT, text=TEXT)

    request = seen[0]
    assert request.method == "POST"
    assert str(request.url) == "https://api.resend.com/emails"
    assert request.headers["authorization"] == "Bearer not-a-real-key"
    body = json.loads(request.content)
    assert body == {
        "from": "LicitaQui <founders@licitaquiapp.com.br>",
        "to": [TO],
        "subject": SUBJECT,
        "text": TEXT,
    }
    assert result.status == "sent"
    assert result.message_id == "re_1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d"
    assert result.status_code == 200


def test_html_and_reply_to_are_optional_and_additive(switch_on: None) -> None:
    transport, seen = recorder()

    client(transport).send(
        to=TO, subject=SUBJECT, text=TEXT, html="<p>Oi</p>", reply_to="contato@licitaquiapp.com.br"
    )

    body = json.loads(seen[0].content)
    assert body["html"] == "<p>Oi</p>"
    assert body["reply_to"] == "contato@licitaquiapp.com.br"


@pytest.mark.parametrize(
    ("status", "reason", "retryable"),
    [
        (401, "unauthorised", False),
        (403, "unauthorised", False),
        (404, "not_found", False),
        (422, "invalid_request", False),
        (429, "rate_limited", True),
        (500, "http_error", True),
        (502, "http_error", True),
    ],
)
def test_failures_are_classified(
    switch_on: None, status: int, reason: str, retryable: bool
) -> None:
    transport, _ = recorder(status, body={"message": f"{TO} is not a valid address"})

    with pytest.raises(ResendError) as caught:
        client(transport).send(to=TO, subject=SUBJECT, text=TEXT)

    assert caught.value.reason == reason
    assert caught.value.retryable is retryable
    # §12: the response body can quote the address back. It must not travel.
    assert TO not in str(caught.value)


def test_a_timeout_does_not_leak_the_request(switch_on: None) -> None:
    def handle(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectTimeout("timed out", request=request)

    with pytest.raises(ResendError) as caught:
        client(httpx.MockTransport(handle)).send(to=TO, subject=SUBJECT, text=TEXT)

    assert caught.value.reason == "timeout"
    assert caught.value.__cause__ is None
    assert TO not in str(caught.value)


def test_two_failures_open_the_circuit(switch_on: None) -> None:
    """Spec §7.2, through the breaker the rest of the worker already uses."""
    transport, seen = recorder(500)
    resend_client = client(transport)

    for _ in range(2):
        with pytest.raises(ResendError):
            resend_client.send(to=TO, subject=SUBJECT, text=TEXT)

    with pytest.raises(Exception) as caught:
        resend_client.send(to=TO, subject=SUBJECT, text=TEXT)

    assert type(caught.value).__name__ == "CircuitOpen"
    assert len(seen) == 2, "the third call should never have reached the transport"


def test_a_non_json_200_is_a_failure(switch_on: None) -> None:
    """A 200 that is not JSON is a proxy or a gateway, not Resend."""
    transport, _ = recorder(200, text="<html>not json</html>")

    with pytest.raises(ResendError) as caught:
        client(transport).send(to=TO, subject=SUBJECT, text=TEXT)

    assert caught.value.reason == "non_json_response"
