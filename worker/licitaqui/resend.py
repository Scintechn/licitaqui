"""Resend REST API client (e-mail), with the kill switch that keeps it quiet.

Mirrors :mod:`licitaqui.evolution` — read that module's docstring first; the
shape here is deliberately the same (a kill switch checked in the transport,
lazy credentials, a dataclass result, a circuit breaker), so this module only
calls out where e-mail differs from WhatsApp.

## Reusing the web app's own integration

`apps/web/lib/auth/magic-link-email.ts` already proved this transport: Resend
via ``POST https://api.resend.com/emails``, called directly rather than
through a client library, from inside Auth.js's own ``sendVerificationRequest``
hook. This module is the same call, made from the worker instead, for the
templates in ``worker/templates/email/`` that hook never touches.

Credentials and the sending address are the **same secret and the same
verified domain** the web app already uses — a second Resend account or a
second sending domain is not this task's to create, and would only be two
things to keep in sync instead of one. :data:`API_KEY_VARS` and
:data:`FROM_VAR` name the identical variables ``apps/web/lib/auth/config.ts``
resolves.

## The kill switch: ``EMAIL_DELIVERY``

Copied from :mod:`licitaqui.evolution`'s reasoning (its docstring, and
``evolution.py:70-74``) rather than paraphrased, because the property that
matters is the same property: **nothing here talks to Resend unless**
``EMAIL_DELIVERY=send``. Unset — the default everywhere: CI, a laptop, a fresh
container — means ``dry_run``: the message is rendered, the delivery is
logged, and no socket is opened.

It is a *word*, not a boolean, on purpose. ``=1`` is the kind of value that
arrives by accident in a copy-pasted env block or a "turn everything on"
compose file; ``send`` has to be typed by someone who meant it. Anything else,
including a typo, is dry run — the switch fails safe in every direction, and
:func:`delivery_mode` says which mode is in force for the log line.

The gate is checked here, in the transport, rather than in the job: it is the
last statement before the request, so no caller — a new job kind, a script, an
operator REPL — can route around it. :func:`post_email` raises
:class:`SendingDisabled` if it is ever reached with the switch off, and the
``httpx`` client is not even constructed until after the check.

It is a **separate** variable from ``WHATSAPP_DELIVERY``, deliberately: this
task (E6) ships with e-mail off regardless of what the WhatsApp switch happens
to be set to on whatever machine runs it, and the two channels stay
independently flippable — a mistake flipping one must not silently turn the
other on too.

## LGPD (§12)

The recipient's address is in the request body and nowhere else — never in a
URL, the way a phone number never was for Evolution either. It is never
logged, and never appears in an exception message: an ``httpx`` exception
stringifies its request, and a Resend error body can echo the address back, so
neither is propagated or chained. :class:`ResendError` carries a short reason
code and a status, nothing else.
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

#: Credentials and sending address. Named to match `apps/web/lib/auth/config.ts`
#: exactly (`AUTH_RESEND_KEY` is Auth.js's own name; `RESEND_API_KEY` is the
#: repo's), so the worker reads the identical secret the web app already has
#: configured rather than asking Sci to set a second one for the same account.
API_KEY_VARS = ("AUTH_RESEND_KEY", "RESEND_API_KEY")
#: The address e-mails are sent from. Must be on Resend's verified domain (G2).
FROM_VAR = "AUTH_EMAIL_FROM"

#: The kill switch. See the module docstring.
DELIVERY_VAR = "EMAIL_DELIVERY"
#: The one value that lets a request leave the process.
DELIVERY_SEND = "send"
#: What every other value — including unset — means.
DELIVERY_DRY_RUN = "dry_run"

DEFAULT_API_URL = "https://api.resend.com"

#: Spec §7.2: connect 15 s, query 30 s. Same budget as every other outbound
#: call this worker makes.
CONNECT_TIMEOUT_SECONDS = 15.0
READ_TIMEOUT_SECONDS = 30.0

#: Circuit breaker name (§7.2): two consecutive failures open it for 15 min.
BREAKER_NAME = "resend"

#: Statuses that mean "do not try again": the key, the sender or the recipient
#: address is wrong, and retrying will fail identically (§7.2's "stop on
#: 401/402/404", extended to Resend's own 422 for a rejected payload).
PERMANENT_STATUSES = frozenset({400, 401, 402, 403, 404, 422})

# httpx logs 'HTTP Request: POST <url> "HTTP/1.1 200 OK"' at INFO. Keep it below
# WARNING so raising the root log level cannot start leaking request lines.
logging.getLogger("httpx").setLevel(logging.WARNING)


class ResendError(RuntimeError):
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
            f"refusing to call Resend: {DELIVERY_VAR} is not '{DELIVERY_SEND}'. "
            "This is the kill switch; it is off by default and on purpose."
        )


@dataclass(frozen=True, slots=True)
class SendResult:
    """What one call to :meth:`ResendClient.send` did.

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


class ResendClient:
    """One Resend account. Credentials are resolved lazily, on first send.

    Lazily because a worker that never sends an e-mail — every CI run, every
    developer laptop — must not need the credentials to exist. Building one of
    these is free and does nothing.
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
        from_address: str | None = None,
        transport: httpx.BaseTransport | None = None,
        connect_timeout: float = CONNECT_TIMEOUT_SECONDS,
        read_timeout: float = READ_TIMEOUT_SECONDS,
    ) -> None:
        self._base_url = base_url or DEFAULT_API_URL
        self._api_key = api_key
        self._from_address = from_address
        #: Tests pass an ``httpx.MockTransport`` so the suite replays recorded
        #: responses instead of reaching the network.
        self._transport = transport
        self._timeout = httpx.Timeout(read_timeout, connect=connect_timeout)

    # -- configuration ------------------------------------------------------

    def _key(self) -> str:
        if self._api_key is None:
            self._api_key = config.require_secret(*API_KEY_VARS)
        return self._api_key

    @property
    def from_address(self) -> str:
        if self._from_address is None:
            self._from_address = config.require_secret(FROM_VAR)
        return self._from_address

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._key()}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }

    # -- sending --------------------------------------------------------------

    def send(
        self,
        *,
        to: str,
        subject: str,
        text: str,
        html: str | None = None,
        reply_to: str | None = None,
    ) -> SendResult:
        """Send one e-mail, or do nothing at all in dry run.

        The kill switch is checked *before* the credentials are resolved or a
        client is constructed, so a dry run works on a machine that has no
        Resend configuration whatsoever — the same guarantee
        ``EvolutionClient.send_text`` gives WhatsApp.
        """
        if not sending_enabled():
            return SendResult(status=DELIVERY_DRY_RUN)
        return self.post_email(to=to, subject=subject, text=text, html=html, reply_to=reply_to)

    def post_email(
        self,
        *,
        to: str,
        subject: str,
        text: str,
        html: str | None = None,
        reply_to: str | None = None,
    ) -> SendResult:
        """The request itself. Re-checks the switch; see the module docstring."""
        if not sending_enabled():
            raise SendingDisabled()

        url = f"{self._base_url}/emails"
        payload: dict[str, Any] = {
            "from": self.from_address,
            "to": [to],
            "subject": subject,
            "text": text,
        }
        if html is not None:
            payload["html"] = html
        if reply_to is not None:
            payload["reply_to"] = reply_to

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
            # Never chain: the original stringifies the request, address included.
            raise ResendError("timeout") from None
        except httpx.HTTPError:
            raise ResendError("transport_error") from None

        if response.status_code >= 400:
            raise ResendError(_failure_reason(response), status=response.status_code)
        try:
            return response.json(), response.status_code
        except ValueError:
            raise ResendError("non_json_response", status=response.status_code) from None


def _failure_reason(response: httpx.Response) -> str:
    """A short code for the log and the `jobs.error` column — never the body."""
    if response.status_code in (401, 403):
        return "unauthorised"
    if response.status_code == 404:
        return "not_found"
    if response.status_code == 422:
        return "invalid_request"
    if response.status_code == 429:
        return "rate_limited"
    return "http_error"


def _message_id(body: Any) -> str | None:
    """Resend returns ``{"id": "…"}``. Missing is not an error."""
    if isinstance(body, dict) and body.get("id"):
        return str(body["id"])
    return None
