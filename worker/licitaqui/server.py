"""The worker's tiny HTTP surface: ``GET /health`` and ``POST /wake``.

``POST /wake`` is how a Vercel route tells the worker that a user is waiting on
screen: it cuts the 2-minute idle poll short so a priority-1 job starts within
a second instead of up to two minutes (§5.1). It is authenticated with the
``WORKER_WAKE_TOKEN`` shared secret and does nothing else — it never accepts a
job definition, so a leaked endpoint cannot make the worker run arbitrary work.

``GET /health`` answers from process state only and never touches the database.
An uptime monitor hitting it every minute must not be what keeps the Neon
compute awake.

The standard library server is enough for two endpoints; adding a web framework
would mean another dependency in the image for no gain.
"""

from __future__ import annotations

import hmac
import json
import sys
from collections.abc import Callable
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

from .observability import get_logger

_log = get_logger("http")

MAX_BODY_BYTES = 64 * 1024
HealthProvider = Callable[[], dict[str, Any]]


class WorkerHTTPServer(ThreadingHTTPServer):
    """Holds what the handler needs; one instance per worker process."""

    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        address: tuple[str, int],
        *,
        wake_token: str | None,
        on_wake: Callable[[], None],
        health: HealthProvider,
    ) -> None:
        self.wake_token = wake_token
        self.on_wake = on_wake
        self.health = health
        super().__init__(address, WorkerRequestHandler)

    @property
    def port(self) -> int:
        return int(self.server_address[1])

    def handle_error(self, request: Any, client_address: Any) -> None:
        """Log instead of printing a traceback to stderr.

        An uptime monitor that drops a keep-alive connection is normal and must
        not look like an incident in the container logs.
        """
        exc = sys.exception()
        if isinstance(exc, ConnectionResetError | BrokenPipeError | TimeoutError):
            _log.debug("client disconnected", extra={"remote": client_address[0]})
            return
        _log.warning("request failed", exc_info=True, extra={"remote": client_address[0]})


class WorkerRequestHandler(BaseHTTPRequestHandler):
    server_version = "licitaqui-worker"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    server: WorkerHTTPServer  # type: ignore[assignment]

    # -- routes -----------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        if self._path() == "/health":
            body = self.server.health()
            ok = body.get("status") == "ok"
            self._json(HTTPStatus.OK if ok else HTTPStatus.SERVICE_UNAVAILABLE, body)
        elif self._path() == "/wake":
            self._json(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "use POST"})
        else:
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        self._discard_body()
        if self._path() != "/wake":
            self._json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            return
        expected = self.server.wake_token
        if not expected:
            _log.error("wake refused: WORKER_WAKE_TOKEN is not configured")
            self._json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "wake is not configured"})
            return
        if not self._authorized(expected):
            _log.warning("wake rejected", extra={"remote": self.client_address[0]})
            self._json(HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return
        self.server.on_wake()
        _log.info("woken")
        self._json(HTTPStatus.ACCEPTED, {"woken": True})

    # -- helpers ----------------------------------------------------------

    def _path(self) -> str:
        return self.path.split("?", 1)[0].rstrip("/") or "/"

    def _authorized(self, expected: str) -> bool:
        header = self.headers.get("Authorization", "")
        scheme, _, presented = header.partition(" ")
        if scheme.lower() != "bearer" or not presented:
            return False
        return hmac.compare_digest(presented.strip(), expected)

    def _discard_body(self) -> None:
        length = self.headers.get("Content-Length")
        if not length:
            return
        try:
            remaining = min(int(length), MAX_BODY_BYTES)
        except ValueError:
            return
        while remaining > 0:
            chunk = self.rfile.read(min(remaining, 8192))
            if not chunk:
                break
            remaining -= len(chunk)

    def _json(self, status: HTTPStatus, body: dict[str, Any]) -> None:
        payload = json.dumps(body, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, fmt: str, *args: Any) -> None:
        """Route access logs through the JSON logger instead of stderr."""
        _log.debug("http", extra={"detail": fmt % args})
