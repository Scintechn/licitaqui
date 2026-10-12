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


# -- the url button, and the fallback that must carry the URL (F24) --------
#
# One `type: "url"` button was measured against our own instance on
# 2026-10-12 — `LicitaQuiapp`, Evolution 2.3.7, `state: open` — as
# `POST /message/sendButtons/{instance}`, answered **201**, and rendered by
# WhatsApp as a `nativeFlowMessage` `cta_url`. The **status code** below is that
# measurement; the response **body** is the recorded `sendText` envelope,
# because no `sendButtons` body was captured and inventing one would be dressing
# a guess up as a fixture. Nothing here asserts anything about the body beyond
# the message id the envelope carries, which is the same shape on both routes.

BUTTON = {
    "title": "Sua cobrança do LicitaQui é dia 17/11/2026",
    "description": "Olá, Maria!\n\n*Valor:* R$ 57,00",
    "footer": "LicitaQui",
    "button_text": "💳 Pagar agora",
    "url": "https://sandbox.asaas.com/i/abc",
}


def test_the_button_request_shape(switch_on: None) -> None:
    transport, seen = recorder(201)

    result = client(transport).send_url_button(NUMBER, **BUTTON)

    request = seen[0]
    assert request.method == "POST"
    assert str(request.url) == (
        "https://evolutiondev.example.invalid/message/sendButtons/licitaqui-test"
    )
    assert request.headers["user-agent"] == USER_AGENT
    assert json.loads(request.content) == {
        "number": "5511999990000",
        "title": BUTTON["title"],
        "description": BUTTON["description"],
        "footer": BUTTON["footer"],
        "buttons": [
            {"type": "url", "displayText": BUTTON["button_text"], "url": BUTTON["url"]}
        ],
    }
    assert result.status == "sent"
    assert result.status_code == 201
    assert result.fallback is False


def test_there_is_exactly_one_button_and_it_is_a_url(switch_on: None) -> None:
    """Sci chose one button on 2026-10-12, having seen both on the handset.

    And `type: "pix"` must never appear: it takes a **static** key, so the money
    would arrive with no txid, Asaas would never mark the charge `RECEIVED`, no
    `PAYMENT_RECEIVED` would fire and entitlement would never be granted — it
    breaks the whole webhook chain F2 exists for.
    """
    transport, seen = recorder(201)

    client(transport).send_url_button(NUMBER, **BUTTON)

    buttons = json.loads(seen[0].content)["buttons"]
    assert len(buttons) == 1
    assert buttons[0]["type"] == evolution.BUTTON_TYPE_URL == "url"
    assert "pix" not in seen[0].content.decode().casefold()


def test_with_the_switch_off_a_button_opens_no_socket(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(DELIVERY_VAR, raising=False)

    def explode(*_: Any, **__: Any) -> None:
        raise AssertionError("a socket was opened with the kill switch off")

    monkeypatch.setattr(socket, "socket", explode)
    monkeypatch.setattr(httpx.HTTPTransport, "handle_request", explode)

    result = EvolutionClient(base_url="https://unused.invalid").send_url_button(NUMBER, **BUTTON)

    assert result.status == "dry_run"
    assert result.fallback is False


def test_the_button_transport_refuses_to_be_called_behind_the_switch() -> None:
    """`post_buttons` re-checks the switch, exactly as `post_text` does: no new
    route may route around the kill switch."""
    transport, seen = recorder(201)

    with pytest.raises(SendingDisabled):
        client(transport).post_buttons(
            "5511999990000", title="t", description="d", footer="f", buttons=[]
        )

    assert seen == []


@pytest.mark.parametrize("status", [400, 422])
def test_a_refused_button_falls_back_to_text_that_carries_the_url(
    switch_on: None, status: int
) -> None:
    """**`rpatinacao`'s 2026-06-09 incident, which this is written from.**

    Evolution began rejecting their button payload in production; their fallback
    sent the description as plain text and **dropped the URL**, while the caller
    still recorded `status: "sent"`. A customer received *"Toque no botão abaixo
    para pagar"* with no button and no link.

    So the fallback carries the URL — WhatsApp auto-links a bare one — and says
    `fallback=True` so the degradation is countable rather than invisible.
    """
    calls: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if "sendButtons" in str(request.url):
            return httpx.Response(status, json={"message": "buttons are not supported"})
        return httpx.Response(200, json=RECORDED_200)

    result = client(httpx.MockTransport(handle)).send_url_button(NUMBER, **BUTTON)

    assert [("sendButtons" in str(c.url)) for c in calls] == [True, False]
    text = json.loads(calls[1].content)["text"]
    assert BUTTON["url"] in text, "the fallback dropped the URL — the 06-09 defect"
    assert BUTTON["description"] in text
    assert "toque no bot" not in text.casefold()
    assert result.status == "sent"
    assert result.fallback is True
    assert result.fallback_reason == "http_error"


def test_the_fallback_text_is_the_message_plus_the_bare_url() -> None:
    """Asserted without a transport, because the one property that matters is
    that the URL survives — and a bare URL on its own line is what WhatsApp
    auto-links."""
    text = evolution.button_fallback_text("Olá, Maria!", "https://sandbox.asaas.com/i/abc")
    assert text.endswith("\n\nhttps://sandbox.asaas.com/i/abc")
    assert text.startswith("Olá, Maria!")


def test_a_rejected_button_does_not_open_the_circuit(switch_on: None) -> None:
    """**The reason the rejection is classified rather than simply raised.**

    A refused payload is systematic: it refuses *every* message. Counted as a
    breaker failure, two of them would open the `evolution` circuit for 15
    minutes and make the plain-text fallback raise `CircuitOpen` exactly when it
    is needed — the fallback would exist and never run. The endpoint answered,
    which is what the breaker measures, so the rejection is not a failure of it.
    """
    calls: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if "sendButtons" in str(request.url):
            return httpx.Response(400, json={"message": "buttons are not supported"})
        return httpx.Response(200, json=RECORDED_200)

    evolution_client = client(httpx.MockTransport(handle))
    for _ in range(3):
        result = evolution_client.send_url_button(NUMBER, **BUTTON)
        assert result.fallback is True

    assert breaker.get_breaker(evolution.BREAKER_NAME).state == "closed"
    assert len(calls) == 6, "every attempt reached the transport, twice over"


@pytest.mark.parametrize(
    ("status", "text", "reason"),
    [
        (403, RECORDED_CLOUDFLARE, "cloudflare_1010_client_fingerprint"),
        (401, None, "unauthorised"),
        (404, None, "instance_or_route_not_found"),
    ],
)
def test_a_block_or_a_bad_key_opens_the_circuit_and_does_not_fall_back(
    switch_on: None, status: int, text: str | None, reason: str
) -> None:
    """**The hole review measured, and the reason `REJECTION_STATUSES` is narrow.**

    The first version fell back on anything non-retryable, which includes a
    Cloudflare **403 `1010`** — the total client-fingerprint block this module's
    docstring exists for. Swallowing it recorded a breaker *success*, the text
    fallback then failed under its own guard, and success/failure alternated, so
    two consecutive failures never accumulated: **5 attempts, 10 requests,
    circuit still closed** through a block where nothing could get through, on a
    breaker shared with the founders sender.

    These statuses mean the endpoint or the credential is the problem, so there
    is nothing to fall back to. They raise, they count, and the circuit opens.
    """
    calls: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        if text is not None:
            return httpx.Response(status, text=text)
        return httpx.Response(status, json={"message": "no"})

    evolution_client = client(httpx.MockTransport(handle))

    for _ in range(2):
        with pytest.raises(EvolutionError) as caught:
            evolution_client.send_url_button(NUMBER, **BUTTON)
        assert caught.value.reason == reason

    # No fallback was attempted: two attempts, two requests, both to sendButtons.
    assert len(calls) == 2
    assert all("sendButtons" in str(c.url) for c in calls)

    # And the breaker did its job, which is the whole finding.
    assert breaker.get_breaker(evolution.BREAKER_NAME).state == "open"
    with pytest.raises(Exception) as third:
        evolution_client.send_url_button(NUMBER, **BUTTON)
    assert type(third.value).__name__ == "CircuitOpen"
    assert len(calls) == 2, "the third attempt should never have reached the transport"


def test_only_a_payload_rejection_is_swallowed_by_the_breaker() -> None:
    """The allow-list, read directly, so widening it is a visible change.

    `PERMANENT_STATUSES` is *"do not retry"*; `REJECTION_STATUSES` is *"Evolution
    answered and refused this payload"*. The second must stay a strict subset,
    and must not contain the auth or routing statuses.
    """
    assert set(evolution.REJECTION_STATUSES) == {400, 422}
    assert evolution.REJECTION_STATUSES < evolution.PERMANENT_STATUSES
    for status in (401, 402, 403, 404):
        assert status not in evolution.REJECTION_STATUSES


def test_a_transport_fault_does_not_fall_back(switch_on: None) -> None:
    """A timeout or a 5xx means the endpoint is not answering, so the plain-text
    attempt would fail the same way. Only a *rejection* — Evolution answering
    that it will not take this payload — is the 06-09 case. This one raises and
    lets the job retry."""
    transport, seen = recorder(500)

    with pytest.raises(EvolutionError) as caught:
        client(transport).send_url_button(NUMBER, **BUTTON)

    assert caught.value.retryable is True
    assert len(seen) == 1, "it tried the text fallback against a dead endpoint"


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
