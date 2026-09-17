"""Structured logging and Sentry wiring.

Logs are one JSON object per line on stdout, which is what Easypanel collects.
Sentry is optional: with ``SENTRY_DSN_WORKER`` unset every function here is a
no-op, so local runs and CI need no configuration.
"""

from __future__ import annotations

import json
import logging
import sys
import time
from typing import Any

from . import config

LOGGER_NAME = "licitaqui"

_RESERVED = frozenset(logging.LogRecord("", 0, "", 0, "", None, None).__dict__) | {
    "asctime",
    "message",
    "taskName",
}


class JsonFormatter(logging.Formatter):
    """One JSON object per record, with any ``extra=`` fields inlined."""

    converter = time.gmtime

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S") + f".{int(record.msecs):03d}Z",
            "level": record.levelname.lower(),
            "logger": record.name,
            "message": config.redact(record.getMessage()),
        }
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = value if _is_jsonable(value) else repr(value)
        if record.exc_info:
            payload["exception"] = config.redact(self.formatException(record.exc_info))
        return json.dumps(payload, ensure_ascii=False, default=str)


def _is_jsonable(value: Any) -> bool:
    return isinstance(value, str | int | float | bool | type(None) | list | dict)


def setup_logging(level: str | int = logging.INFO) -> logging.Logger:
    logger = logging.getLogger(LOGGER_NAME)
    logger.setLevel(level)
    logger.propagate = False
    if not logger.handlers:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(JsonFormatter())
        logger.addHandler(handler)
    return logger


def get_logger(suffix: str | None = None) -> logging.Logger:
    return logging.getLogger(LOGGER_NAME if not suffix else f"{LOGGER_NAME}.{suffix}")


def init_sentry(dsn: str | None = None, *, environment: str | None = None) -> bool:
    """Initialise Sentry when a DSN is configured. Returns whether it was.

    Never logs the DSN. Any import or initialisation problem is swallowed:
    telemetry must not be able to stop the worker from starting.
    """
    dsn = dsn or config.sentry_dsn()
    if not dsn:
        return False
    try:
        import sentry_sdk

        sentry_sdk.init(
            dsn=dsn,
            environment=environment or "production",
            traces_sample_rate=0.0,
            send_default_pii=False,
        )
    except Exception:  # pragma: no cover - defensive
        get_logger().warning("sentry initialisation failed", exc_info=True)
        return False
    return True


def capture_exception(exc: BaseException) -> None:
    """Send an exception to Sentry when it is configured; otherwise do nothing."""
    try:
        import sentry_sdk

        if sentry_sdk.get_client().is_active():
            sentry_sdk.capture_exception(exc)
    except Exception:  # pragma: no cover - telemetry must never break a job
        get_logger().debug("sentry capture failed", exc_info=True)
