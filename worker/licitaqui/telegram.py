"""Telegram Bot API client, with the kill switch that keeps it quiet.

Spec §9: the bot is ``@LicitaQuiBot``, it is ours alone, and it carries the
Básico plan's one weekly alert (§10). This module is the transport only — who
may be messaged, how often, and with which words is
:mod:`licitaqui.telegram_alerts`.

## The kill switch: ``TELEGRAM_DELIVERY``

**Nothing here talks to Telegram unless ``TELEGRAM_DELIVERY=send``.** Unset —
the default everywhere: CI, a laptop, a fresh container — means `dry_run`: the
message is rendered, the delivery is logged, and no socket is opened.

Same word, same shape and the same reasoning as ``WHATSAPP_DELIVERY`` in
:mod:`licitaqui.evolution`, and it is deliberately a *second* switch rather
than one shared flag. The two channels fail differently and are turned on at
different times: WhatsApp's risk is the number being banned, Telegram's is that
`@LicitaQuiBot` is a **live bot a real person is already talking to**, so a
worker pointed at the production database — a backfill, a REPL, a `pytest` run
that picked up the wrong DSN — would message founders for real. One flag would
mean turning WhatsApp on turns Telegram on with it.

It is a *word*, not a boolean, for the reason evolution.py gives: ``=1`` is the
kind of value that arrives by accident in a copy-pasted env block. Anything
else, including a typo, is dry run. The gate is checked **in the transport**,
immediately before the request, so no caller — a new job kind, a script, an
operator REPL — can route around it, and :func:`TelegramClient.post_message`
raises :class:`SendingDisabled` if it is ever reached with the switch off.

## Markdown, and the tender whose title contains an underscore

E0's bodies use ``*negrito*`` (templates README §4), which is Telegram's
*legacy* ``Markdown`` parse mode. That mode has no way to escape a stray
``*``, ``_``, ``[`` or backtick, and the values we substitute are agency names
and PNCP objects written by whoever published the tender — so one procurement
object reading ``AQUISIÇÃO DE MATERIAL_ESCOLAR`` is enough to get
``400 can't parse entities`` and drop a whole digest.

Two defences, both needed:

1. :func:`escape_markdown` is applied to every **value** before it reaches the
   template, never to the body, so E0's own ``*…*`` still renders and the data
   inside it cannot close it early.
2. If Telegram rejects the parse anyway, :meth:`TelegramClient.send_message`
   retries once **without** ``parse_mode``. A message with visible asterisks is
   a blemish; a digest that silently did not arrive is the failure this product
   exists to avoid.

## LGPD (§12)

A Telegram ``chat_id`` is personal data: it identifies one person's account and
is enough to message them. It is in the request body and in no URL, it is never
logged, never put in an exception message and never written to `jobs.error`.
Where a log line needs to distinguish two recipients it carries
:func:`chat_ref` — the same shape as ``company.cnpj_ref``, a truncated SHA-256
that correlates rows without naming anyone. An ``httpx`` exception stringifies
its request and a Telegram error body quotes what it was given, so neither is
propagated or chained: :class:`TelegramError` carries a reason code and a
status, nothing else.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import time
from dataclasses import dataclass
from typing import Any

import httpx

from . import config
from .breaker import get_breaker

#: Credentials. Names only; the values live in Easypanel and the gitignored env
#: files, and are resolved the way ``db/migrate.py`` resolves its own (§12).
BOT_TOKEN_VAR = "TELEGRAM_BOT_TOKEN"

#: The kill switch. See the module docstring.
DELIVERY_VAR = "TELEGRAM_DELIVERY"
#: The one value that lets a request leave the process.
DELIVERY_SEND = "send"
#: What every other value — including unset — means.
DELIVERY_DRY_RUN = "dry_run"

API_BASE_VAR = "TELEGRAM_API_BASE"
DEFAULT_API_BASE = "https://api.telegram.org"

#: Spec §7.2: connect 15 s, query 30 s.
CONNECT_TIMEOUT_SECONDS = 15.0
READ_TIMEOUT_SECONDS = 30.0

#: Circuit breaker name (§7.2): two consecutive failures open it for 15 min.
BREAKER_NAME = "telegram"

#: Legacy ``Markdown``, which is what E0's ``*negrito*`` is written in.
PARSE_MODE = "Markdown"

#: Telegram truncates at 4096 UTF-16 code units and 400s on anything longer.
MAX_MESSAGE_CHARS = 4096

#: Statuses that mean "do not try again" (§7.2, "stop on 401/402/404"). 403 is
#: here because it is what a person who blocked the bot looks like: retrying
#: four times cannot unblock them, and :mod:`licitaqui.telegram_alerts` turns
#: the alert off instead.
PERMANENT_STATUSES = frozenset({400, 401, 403, 404})

#: The legacy-Markdown metacharacters. There are only four, which is the one
#: mercy of that parse mode.
_MARKDOWN_SPECIALS = re.compile(r"([*_`\[])")

# httpx logs 'HTTP Request: POST <url> …' at INFO, and our URL contains the bot
# token. Keep it below WARNING: raising the root log level must not leak it.
logging.getLogger("httpx").setLevel(logging.WARNING)


class TelegramError(RuntimeError):
    """A send that did not happen. The message is a reason code, never a body."""

    def __init__(self, reason: str, *, status: int | None = None) -> None:
        super().__init__(reason if status is None else f"{reason} (http {status})")
        self.reason = reason
        self.status = status

    @property
    def retryable(self) -> bool:
        return self.status not in PERMANENT_STATUSES if self.status is not None else True

    @property
    def blocked(self) -> bool:
        """Whether the recipient has put the bot out of reach for good."""
        return self.reason in (REASON_BLOCKED, REASON_CHAT_NOT_FOUND)


class SendingDisabled(RuntimeError):
    """The transport was reached with the kill switch off. A bug, loudly."""

    def __init__(self) -> None:
        super().__init__(
            f"refusing to call Telegram: {DELIVERY_VAR} is not '{DELIVERY_SEND}'. "
            "This is the kill switch; it is off by default and on purpose."
        )


#: Stable reason codes. They reach the log, `events.props` and `jobs.error`, and
#: a dashboard will group by them, so they are named once here.
REASON_BLOCKED = "blocked_by_user"
REASON_CHAT_NOT_FOUND = "chat_not_found"
REASON_PARSE = "cannot_parse_entities"
REASON_UNAUTHORISED = "unauthorised"
REASON_FORBIDDEN = "forbidden"
REASON_RATE_LIMITED = "rate_limited"
REASON_TIMEOUT = "timeout"
REASON_TRANSPORT = "transport_error"
REASON_HTTP = "http_error"
REASON_NON_JSON = "non_json_response"
REASON_NOT_OK = "api_not_ok"


@dataclass(frozen=True, slots=True)
class SendResult:
    """What one call to :meth:`TelegramClient.send_message` did.

    ``status`` is ``sent`` or ``dry_run``. Nothing here identifies the
    recipient: it is written straight into the delivery log (§12).
    """

    status: str
    message_id: int | None = None
    status_code: int | None = None
    duration_ms: int | None = None
    #: True when the parse mode had to be dropped. See the module docstring.
    plain_text_fallback: bool = False

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


def chat_ref(chat_id: int | str) -> str:
    """A stable, non-reversing handle for a chat, for logs and `events` (§12).

    The same shape as ``licitaqui.company.cnpj_ref``: a truncated SHA-256, so
    two log lines about the same person can be correlated and no log line names
    them. Sixteen hex characters is 64 bits — far more than the collision
    headroom a few thousand chats need, and short enough to read.
    """
    return hashlib.sha256(str(chat_id).encode("ascii")).hexdigest()[:16]


def escape_markdown(value: Any) -> str:
    """Neutralise legacy-Markdown metacharacters in a **value**.

    Applied to what we substitute, never to the body E0 wrote: the template's
    own ``*negrito*`` has to keep working, and the data inside it must not be
    able to close it early. See the module docstring.
    """
    return _MARKDOWN_SPECIALS.sub(r"\\\1", str(value))


def escape_context(context: dict[str, Any]) -> dict[str, Any]:
    """:func:`escape_markdown` over every string value; flags pass through.

    Booleans are ``[[se: …]]`` flags and must stay booleans — escaping one
    would turn ``False`` into the string ``"False"``, which is truthy, which
    would render a block the caller asked to hide.
    """
    return {
        key: value if isinstance(value, bool) or value is None else escape_markdown(value)
        for key, value in context.items()
    }


class TelegramClient:
    """The bot. Credentials are resolved lazily, on first send.

    Lazily because a worker that never sends a Telegram message — every CI run,
    every developer laptop — must not need the token to exist. Building one of
    these is free and does nothing.
    """

    def __init__(
        self,
        *,
        token: str | None = None,
        api_base: str | None = None,
        transport: httpx.BaseTransport | None = None,
        connect_timeout: float = CONNECT_TIMEOUT_SECONDS,
        read_timeout: float = READ_TIMEOUT_SECONDS,
    ) -> None:
        self._token = token
        self._api_base = api_base
        #: Tests pass an ``httpx.MockTransport`` so the suite replays recorded
        #: responses instead of reaching the network.
        self._transport = transport
        self._timeout = httpx.Timeout(read_timeout, connect=connect_timeout)

    # -- configuration ----------------------------------------------------

    @property
    def api_base(self) -> str:
        if self._api_base is None:
            self._api_base = (config.resolve_secret(API_BASE_VAR) or DEFAULT_API_BASE).rstrip("/")
        return self._api_base

    def _bot_token(self) -> str:
        if self._token is None:
            self._token = config.require_secret(BOT_TOKEN_VAR)
        return self._token

    def _url(self, method: str) -> str:
        """The endpoint. **Never log this**: the token is in the path."""
        return f"{self.api_base}/bot{self._bot_token()}/{method}"

    # -- sending ----------------------------------------------------------

    def send_message(self, chat_id: int | str, text: str) -> SendResult:
        """Send one message, or do nothing at all in dry run.

        The kill switch is checked *before* the token is resolved or a client is
        constructed, so a dry run works on a machine that has no Telegram
        configuration whatsoever.
        """
        if not sending_enabled():
            return SendResult(status=DELIVERY_DRY_RUN)
        try:
            return self.post_message(chat_id, text)
        except TelegramError as exc:
            if exc.reason != REASON_PARSE:
                raise
            # A stray metacharacter got through. Better a message with visible
            # asterisks than no digest at all; see the module docstring.
            result = self.post_message(chat_id, text, parse_mode=None)
            return SendResult(
                status=result.status,
                message_id=result.message_id,
                status_code=result.status_code,
                duration_ms=result.duration_ms,
                plain_text_fallback=True,
            )

    def post_message(
        self, chat_id: int | str, text: str, *, parse_mode: str | None = PARSE_MODE
    ) -> SendResult:
        """The request itself. Re-checks the switch; see the module docstring."""
        if not sending_enabled():
            raise SendingDisabled()
        if not str(text).strip():
            # A blank body is our bug, and Telegram answers it with a 400 that
            # reads like a recipient problem.
            raise TelegramError("empty_message")

        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "text": text[:MAX_MESSAGE_CHARS],
            # A digest is three tender links; a preview card for one of them
            # would bury the other two.
            "disable_web_page_preview": True,
        }
        if parse_mode:
            payload["parse_mode"] = parse_mode

        started = time.monotonic()
        with get_breaker(BREAKER_NAME).guard():
            body, status = self._request(self._url("sendMessage"), payload)
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
                response = client.post(url, json=payload)
        except httpx.TimeoutException:
            # Never chain: the original stringifies the request, chat id and
            # bot token included.
            raise TelegramError(REASON_TIMEOUT) from None
        except httpx.HTTPError:
            raise TelegramError(REASON_TRANSPORT) from None

        try:
            body = response.json()
        except ValueError:
            raise TelegramError(REASON_NON_JSON, status=response.status_code) from None

        if response.status_code >= 400 or not (isinstance(body, dict) and body.get("ok")):
            raise TelegramError(_failure_reason(body), status=response.status_code)
        return body, response.status_code


def _failure_reason(body: Any) -> str:
    """A short code for the log and `jobs.error` — never Telegram's own text.

    ``description`` quotes back what it was given, so it is matched against and
    then discarded rather than stored.
    """
    description = ""
    if isinstance(body, dict):
        description = str(body.get("description") or "").lower()
    if "blocked by the user" in description or "user is deactivated" in description:
        return REASON_BLOCKED
    if "chat not found" in description:
        return REASON_CHAT_NOT_FOUND
    if "can't parse entities" in description or "can t parse entities" in description:
        return REASON_PARSE
    if "unauthorized" in description or "token" in description:
        return REASON_UNAUTHORISED
    if "too many requests" in description or "retry after" in description:
        return REASON_RATE_LIMITED
    if "forbidden" in description:
        # Every *other* 403. Measured against the live bot on 2026-09-21:
        # `TELEGRAM_CHAT_ID` in `.env.local` holds the bot's own id, and
        # `sendMessage` to it answers "Forbidden: the bot can't send messages to
        # the bot". Named rather than left as `api_not_ok` because a bare
        # "api_not_ok (http 403)" in `jobs.error` is the kind of thing that
        # costs somebody an afternoon.
        #
        # Deliberately **not** `blocked`: the auto-pause in
        # `telegram_alerts.send` stops somebody's digest, and it should only
        # fire on the two descriptions that really mean the person is gone —
        # not on a misconfiguration, which pausing would merely hide.
        return REASON_FORBIDDEN
    return REASON_NOT_OK if description else REASON_HTTP


def _message_id(body: Any) -> int | None:
    """Telegram returns ``{"ok": true, "result": {"message_id": …}}``."""
    if isinstance(body, dict):
        result = body.get("result")
        if isinstance(result, dict) and isinstance(result.get("message_id"), int):
            return int(result["message_id"])
    return None
