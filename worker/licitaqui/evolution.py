"""Evolution API client (WhatsApp), with the kill switch that keeps it quiet.

Spec §9: Evolution API on Easypanel, *unofficial*, so a misuse risks the number
being banned — dedicated number, opt-in only, roughly one message every 20–30 s,
no bulk blasts, honour ``SAIR``. The pacing and the consent checks live in
:mod:`licitaqui.whatsapp`; this module is the transport alone.

## The kill switch: ``WHATSAPP_DELIVERY``

**Nothing here talks to WhatsApp unless ``WHATSAPP_DELIVERY=send``.** Unset —
the default everywhere: CI, a laptop, a fresh container — means `dry_run`: the
message is rendered, the delivery is logged, and no socket is opened.

It is a *word*, not a boolean, on purpose. ``=1`` is the kind of value that
arrives by accident in a copy-pasted env block or a "turn everything on"
compose file; ``send`` has to be typed by someone who meant it. Anything else,
including a typo, is dry run — the switch fails safe in every direction, and
:func:`delivery_mode` says which mode is in force for the log line.

The gate is checked here, in the transport, rather than in the job: it is the
last statement before the request, so no caller — a new job kind, a script, an
operator REPL — can route around it. :func:`post_text` raises
:class:`SendingDisabled` if it is ever reached with the switch off, and the
``httpx`` client is not even constructed until after the check.

**Why this switch exists right now (2026-09-18).** The only Evolution instance
on the server belongs to another product, `flowdeski-scn-real-estate`. Sending
LicitaQui's founders welcome from it would deliver it from another product's
WhatsApp number. Until a LicitaQui instance exists, `send` must stay unset.

## Cloudflare

``evolutiondev.scintechn.com`` sits behind Cloudflare, which answers
``403 error code: 1010`` to a default Python HTTP client — to ``python-httpx``
and ``urllib`` alike, **including on ``GET /``**. That is a client-fingerprint
block, not an auth failure: no API key changes it, and the same request with a
Chrome ``User-Agent`` returns 200 (verified). So :data:`USER_AGENT` is not
decoration, it is a functional requirement, and :func:`_headers` is the one
place that sets it.

## LGPD (§12)

The recipient's number is in the request body and in the URL of nothing. It is
never logged, never put in an exception message, and never stored in an `error`
column: an ``httpx`` exception stringifies its request, and an Evolution error
body quotes the number back, so neither is propagated or chained.
:class:`EvolutionError` carries a short reason code and a status, nothing else.
"""

from __future__ import annotations

import logging
import os
import time
from dataclasses import dataclass
from typing import Any

import httpx

from . import config
from .breaker import get_breaker

#: Credentials. Names only; the values live in Easypanel and the gitignored env
#: files, and are resolved the way ``db/migrate.py`` resolves its own (§12).
API_URL_VAR = "EVOLUTION_API_URL"
API_KEY_VAR = "EVOLUTION_API_KEY"
INSTANCE_VAR = "EVOLUTION_INSTANCE"

#: The kill switch. See the module docstring.
DELIVERY_VAR = "WHATSAPP_DELIVERY"
#: The one value that lets a request leave the process.
DELIVERY_SEND = "send"
#: What every other value — including unset — means.
DELIVERY_DRY_RUN = "dry_run"

#: Cloudflare rejects the default client fingerprint. See the module docstring.
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)

#: Spec §7.2: connect 15 s, query 30 s.
CONNECT_TIMEOUT_SECONDS = 15.0
READ_TIMEOUT_SECONDS = 30.0

#: Circuit breaker name (§7.2): two consecutive failures open it for 15 min.
BREAKER_NAME = "evolution"

#: Statuses that mean "do not try again": the instance, key or number is wrong,
#: and four retries over forty minutes will be wrong in the same way (§7.2,
#: "stop on 401/402/404").
PERMANENT_STATUSES = frozenset({400, 401, 402, 403, 404, 422})

# httpx logs 'HTTP Request: POST <url> "HTTP/1.1 200 OK"' at INFO. The URL
# carries the instance name, and a redirect could carry more, so keep it below
# WARNING: raising the root log level must not start leaking it.
logging.getLogger("httpx").setLevel(logging.WARNING)


class EvolutionError(RuntimeError):
    """A send that did not happen. The message is a reason code, never a body."""

    def __init__(self, reason: str, *, status: int | None = None) -> None:
        super().__init__(reason if status is None else f"{reason} (http {status})")
        self.reason = reason
        self.status = status

    @property
    def retryable(self) -> bool:
        return self.status not in PERMANENT_STATUSES if self.status is not None else True


class SendingDisabled(RuntimeError):
    """The transport was reached with the kill switch off. A bug, loudly."""

    def __init__(self) -> None:
        super().__init__(
            f"refusing to call Evolution: {DELIVERY_VAR} is not '{DELIVERY_SEND}'. "
            "This is the kill switch; it is off by default and on purpose."
        )


@dataclass(frozen=True, slots=True)
class SendResult:
    """What one call to :meth:`EvolutionClient.send_text` did.

    ``status`` is ``sent`` or ``dry_run``. Nothing here identifies the
    recipient: it is written straight into the delivery log (§12).
    """

    status: str
    message_id: str | None = None
    status_code: int | None = None
    duration_ms: int | None = None

    @property
    def delivered(self) -> bool:
        return self.status == "sent"


def delivery_mode() -> str:
    """:data:`DELIVERY_SEND` or :data:`DELIVERY_DRY_RUN`. Never raises."""
    raw = (os.environ.get(DELIVERY_VAR) or "").strip()
    return DELIVERY_SEND if raw == DELIVERY_SEND else DELIVERY_DRY_RUN


def sending_enabled() -> bool:
    """Whether a real request may leave this process. Off unless deliberately on."""
    return delivery_mode() == DELIVERY_SEND


def normalise_number(raw: str) -> str:
    """``+55 (11) 99999-9999`` → ``5511999999999``.

    F1 already stores ``founders_list.whatsapp`` as ``+55`` + 10 or 11 digits
    (`apps/web/lib/founders/input.ts`), so this mostly strips the punctuation —
    but it is the last thing between a hand-edited row and a message to a
    stranger, so the shape is checked rather than assumed. The number itself
    never appears in the ``ValueError``.

    An explicit foreign country code is rejected rather than reinterpreted:
    ``+1 415 555 0000`` is eleven digits whose first two are a valid Brazilian
    area code, so stripping the ``+`` silently turns a US number into a
    plausible São Paulo one and messages a stranger. A leading ``+`` is the
    only signal that the country code was stated, so it is honoured.
    """
    text = str(raw).strip()
    if text.startswith("+") and not text.lstrip("+").replace(" ", "").startswith("55"):
        raise ValueError("only Brazilian numbers (+55) can be dialled")
    digits = "".join(ch for ch in text if ch.isdigit())
    if digits.startswith("55"):
        digits = digits[2:]
    if len(digits) not in (10, 11):
        raise ValueError("a Brazilian number has a 2-digit area code and 8 or 9 digits")
    if not 11 <= int(digits[:2]) <= 99:
        raise ValueError("area code out of range")
    return f"55{digits}"


class EvolutionClient:
    """One Evolution instance. Credentials are resolved lazily, on first send.

    Lazily because a worker that never sends a WhatsApp message — every CI run,
    every developer laptop — must not need the credentials to exist. Building
    one of these is free and does nothing.
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
        instance: str | None = None,
        transport: httpx.BaseTransport | None = None,
        connect_timeout: float = CONNECT_TIMEOUT_SECONDS,
        read_timeout: float = READ_TIMEOUT_SECONDS,
    ) -> None:
        self._base_url = base_url
        self._api_key = api_key
        self._instance = instance
        #: Tests pass an ``httpx.MockTransport`` so the suite replays recorded
        #: responses instead of reaching the network.
        self._transport = transport
        self._timeout = httpx.Timeout(read_timeout, connect=connect_timeout)

    # -- configuration ----------------------------------------------------

    @property
    def base_url(self) -> str:
        if self._base_url is None:
            self._base_url = config.require_secret(API_URL_VAR).rstrip("/")
        return self._base_url

    @property
    def instance(self) -> str:
        if self._instance is None:
            self._instance = config.require_secret(INSTANCE_VAR)
        return self._instance

    def _key(self) -> str:
        if self._api_key is None:
            self._api_key = config.require_secret(API_KEY_VAR)
        return self._api_key

    def _headers(self) -> dict[str, str]:
        """The only place the browser ``User-Agent`` is set. See the docstring."""
        return {
            "User-Agent": USER_AGENT,
            "apikey": self._key(),
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    # -- sending ----------------------------------------------------------

    def send_text(self, number: str, text: str) -> SendResult:
        """Send one text message, or do nothing at all in dry run.

        The kill switch is checked *before* the number is normalised, the
        credentials are resolved or a client is constructed, so a dry run works
        on a machine that has no Evolution configuration whatsoever.
        """
        if not sending_enabled():
            return SendResult(status=DELIVERY_DRY_RUN)
        return self.post_text(normalise_number(number), text)

    def post_text(self, number: str, text: str) -> SendResult:
        """The request itself. Re-checks the switch; see the module docstring."""
        if not sending_enabled():
            raise SendingDisabled()

        url = f"{self.base_url}/message/sendText/{self.instance}"
        payload = {"number": number, "text": text}
        started = time.monotonic()
        with get_breaker(BREAKER_NAME).guard():
            body, status = self._request(url, payload)
        return SendResult(
            status="sent",
            message_id=_message_id(body),
            status_code=status,
            duration_ms=int((time.monotonic() - started) * 1000),
        )

    def _request(self, url: str, payload: dict[str, Any]) -> tuple[Any, int]:
        try:
            with httpx.Client(
                timeout=self._timeout, transport=self._transport, follow_redirects=False
            ) as client:
                response = client.post(url, json=payload, headers=self._headers())
        except httpx.TimeoutException:
            # Never chain: the original stringifies the request, number included.
            raise EvolutionError("timeout") from None
        except httpx.HTTPError:
            raise EvolutionError("transport_error") from None

        if response.status_code >= 400:
            raise EvolutionError(_failure_reason(response), status=response.status_code)
        try:
            return response.json(), response.status_code
        except ValueError:
            # A 200 that is not JSON is Cloudflare or a proxy, not Evolution.
            raise EvolutionError("non_json_response", status=response.status_code) from None


def _failure_reason(response: httpx.Response) -> str:
    """A short code for the log and the `jobs.error` column — never the body.

    Cloudflare's block is called out by name because it is the failure this
    integration hits first and the one whose fix (:data:`USER_AGENT`) is not
    obvious from a bare 403.
    """
    if response.status_code == 403 and "1010" in response.text[:2000]:
        return "cloudflare_1010_client_fingerprint"
    if response.status_code in (401, 403):
        return "unauthorised"
    if response.status_code == 404:
        return "instance_or_route_not_found"
    if response.status_code == 429:
        return "rate_limited"
    return "http_error"


def _message_id(body: Any) -> str | None:
    """Evolution returns ``{"key": {"id": …}, …}``. Missing is not an error."""
    if isinstance(body, dict):
        key = body.get("key")
        if isinstance(key, dict) and key.get("id"):
            return str(key["id"])
        if body.get("id"):
            return str(body["id"])
    return None
