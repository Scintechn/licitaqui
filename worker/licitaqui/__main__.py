"""Entrypoint: ``python -m licitaqui`` (the image's CMD).

Runs until SIGTERM or SIGINT, which is what Easypanel and `docker stop` send;
the handler lets the job in flight finish before the process exits.
"""

from __future__ import annotations

import signal
import sys
from types import FrameType

from .observability import get_logger, init_sentry, setup_logging
from .service import WorkerService


def main() -> int:
    setup_logging()
    log = get_logger("main")
    init_sentry()

    try:
        service = WorkerService.from_env()
    except RuntimeError as exc:
        log.error("cannot start", extra={"reason": str(exc)})
        return 2

    def handle(signum: int, _frame: FrameType | None) -> None:
        log.info("signal received", extra={"signal": signal.Signals(signum).name})
        service.stop.set()

    signal.signal(signal.SIGTERM, handle)
    signal.signal(signal.SIGINT, handle)

    service.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
