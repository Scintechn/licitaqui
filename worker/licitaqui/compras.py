"""Client for ``dadosabertos.compras.gov.br`` — public, no authentication.

## Why this is not :mod:`licitaqui.pncp`

A different host with different behaviour, so it gets its own breakers: a
breaker is **per endpoint** (``CLAUDE.md``), and ``pncp-resultados`` was open for
a whole morning on 2026-09-30 while PNCP search was healthy. Sharing one would
let this feed's trouble close PNCP's circuit and vice versa.

## The rate ceiling, and what was NOT established

Measured 2026-10-02 against the live API, every row a real condition:

=========================  ==========  ==========================
condition                  throughput  429
=========================  ==========  ==========================
1 request in flight        0.26/s      0 over 640 calls
3 workers, 0.40 s spacing  0.55/s      0 over 2 668 calls
6 workers, 0.40 s spacing  1.90/s      0 over **60** calls
10 workers, 0.40 s spacing 2.33/s      **19 of 60**
=========================  ==========  ==========================

**What those rows do not establish.** The spacing was 0.40 s in all three
multi-worker rows, so worker count and arrival rate moved together and the
table cannot separate them; 10 workers at a wider spacing was never run. An
earlier tweet-length claim that "the arrival rate is the constraint, not the
concurrency" was an **inference** from confounded conditions and is withdrawn.

**And the 1.90/s row did not survive a long walk.** A sustained probe at 6
workers / 0.40 s took 4 × 429 at around call 600 the same day, after which the
backoff below widened the spacing to its 2.0 s ceiling and the run completed.
So the only condition measured clean over thousands of calls is **3 workers at
0.40 s = 0.55 calls/s**, and that is the figure a refresh budget should use.

This client is **sequential** -- it makes one request at a time, so it runs the
first row, 0.26/s. Concurrency belongs to B35's price refresh, which is where
the table above matters; it is quoted here because :data:`MIN_INTERVAL` is the
control that the 429s moved.

Latency is server-side and dominates: mean 3.89 s per 500-row page, p90 7.82,
max 32.06, and **page size does not change it** (size 10 took 29.85 s on the
same code where size 500 took 9.60 s). There is no deep-page penalty either, so
:data:`PAGE_SIZE` is the maximum the API allows -- fewer calls is the only lever
the clock responds to.

## One measured quirk that must not be read as a rejection

``HTTP 400`` can be **transient** here: PDM 4915 returned 400 once and 200 on
three retries the same minute. It is retried like a 5xx rather than treated as a
malformed request.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx

from .breaker import CircuitBreaker, get_breaker
from .observability import get_logger

_log = get_logger("compras")

BASE_URL = "https://dadosabertos.compras.gov.br"

#: Maximum the API accepts; ``tamanhoPagina=1000`` is a 400 and the minimum is 10.
PAGE_SIZE = 500

#: Minimum spacing between request starts, for the life of the PROCESS: a 429
#: widens it and nothing narrows it again, so one bad run slows every later
#: job in that worker until it restarts.
DEFAULT_INTERVAL = 0.4
MIN_INTERVAL = [DEFAULT_INTERVAL]
MAX_INTERVAL = 2.0

CATALOGUE_PATHS = {
    "pdm": "/modulo-material/3_consultarPdmMaterial",
    "service": "/modulo-servico/6_consultarItemServico",
}

_interval_lock = threading.Lock()
_last_call = [0.0]


class ComprasError(RuntimeError):
    """A request that did not yield a usable body after its retries."""


def _throttle(sleep: Callable[[float], None] = time.sleep) -> None:
    with _interval_lock:
        wait = MIN_INTERVAL[0] - (time.monotonic() - _last_call[0])
        if wait > 0:
            sleep(wait)
        _last_call[0] = time.monotonic()


def _widen() -> None:
    """A 429 is about the whole process, not about one request."""
    with _interval_lock:
        # `max(DEFAULT_INTERVAL, ...)` because multiplying is not widening when
        # the interval is zero: 0 * 1.5 is 0, so a client configured without
        # spacing could take 429s forever and never slow down. A test pins it.
        MIN_INTERVAL[0] = min(MAX_INTERVAL, max(DEFAULT_INTERVAL, MIN_INTERVAL[0] * 1.5))
    _log.warning("rate limited, widening interval", extra={"interval_s": MIN_INTERVAL[0]})


@dataclass
class ComprasClient:
    """Throttled, breaker-protected reader for the catalogue endpoints."""

    timeout_s: float = 90.0
    attempts: int = 4
    transport: httpx.BaseTransport | None = None
    #: Injected so the retry and throttle delays can be collapsed in tests.
    #: Real backoff is measured in seconds and a unit test must not pay it.
    sleep: Callable[[float], None] = time.sleep
    _client: httpx.Client = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._client = httpx.Client(
            base_url=BASE_URL,
            timeout=httpx.Timeout(connect=15.0, read=self.timeout_s, write=15.0, pool=15.0),
            headers={"Accept": "application/json"},
            transport=self.transport,
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> ComprasClient:
        return self

    def __exit__(self, *_: object) -> None:
        self.close()

    @property
    def catalogue_breaker(self) -> CircuitBreaker:
        return get_breaker("compras-catalogo")

    def get(self, path: str, params: dict[str, Any], breaker: CircuitBreaker) -> Any:
        """One GET, throttled, retried, under ``breaker``.

        A 404 is an answer (no rows for this code), not a failure: it does not
        reach the breaker and is returned as an empty body carrying
        ``notFound: True``, which is the only thing distinguishing it from a
        genuine 200 with zero rows. A caller that must tell them apart reads that
        flag; a caller that does not can ignore it.
        """
        last: Exception | None = None
        for attempt in range(self.attempts):
            _throttle(self.sleep)
            retry_after: str | None = None
            try:
                # **The status check belongs INSIDE the guard.** `guard()` records
                # success on any normal return, so returning a 503 from here would
                # call `record_success()` and *reset* the failure count -- the
                # breaker could never open on an HTTP error, and a run alternating
                # reset-by-peer with 503 would never accumulate two consecutive
                # failures at all. `pncp.py` raises inside the guard for the same
                # reason; this file returned instead, and that was a defect.
                with breaker.guard():
                    try:
                        response = self._client.get(path, params=params)
                    except httpx.HTTPError as exc:
                        raise ComprasError(f"GET {path} -> {type(exc).__name__}: {exc}") from exc
                    # A 404 is an answer -- this code has no rows -- so it must not
                    # count as a failure. Raised outside the guard, below.
                    if response.status_code != 404 and response.status_code >= 400:
                        retry_after = (
                            response.headers.get("Retry-After")
                            if response.status_code == 429
                            else None
                        )
                        raise ComprasError(
                            f"GET {path} -> HTTP {response.status_code}",
                        )
            except ComprasError as exc:
                last = exc
                if "HTTP 429" in str(exc):
                    _widen()
                    delay = (
                        float(retry_after)
                        if retry_after and retry_after.isdigit()
                        else min(60.0, 8.0 * (attempt + 1))
                    )
                else:
                    # 400 is included deliberately: measured transient on this API
                    # (PDM 4915 returned 400 once and 200 on three retries).
                    delay = 1.5 * (attempt + 1)
                self.sleep(delay)
                continue
            if response.status_code == 404:
                return {"resultado": [], "totalRegistros": 0, "totalPaginas": 0, "notFound": True}
            return response.json()
        raise ComprasError(f"{path} failed after {self.attempts} attempts: {last}")

    def walk_catalogue(self, which: str) -> list[dict[str, Any]]:
        """Every row of one closed vocabulary.

        **Raises on an empty walk and on a short walk**, rather than returning
        what it got. ``CLAUDE.md``: an empty result is not an absence, and a walk
        that stops early would silently shrink the vocabulary — which would turn
        mapped items into unmapped ones with no record of why.
        """
        path = CATALOGUE_PATHS[which]
        first = self.get(path, {"pagina": 1, "tamanhoPagina": PAGE_SIZE}, self.catalogue_breaker)
        total = int(first.get("totalRegistros") or 0)
        pages = int(first.get("totalPaginas") or 0)
        rows = list(first.get("resultado") or [])
        for page in range(2, pages + 1):
            body = self.get(
                path, {"pagina": page, "tamanhoPagina": PAGE_SIZE}, self.catalogue_breaker
            )
            rows.extend(body.get("resultado") or [])
        if not rows:
            raise ComprasError(f"{which}: empty walk — a broken run, not a finding")
        if len(rows) != total:
            # Strict equality against the count read from page 1, so this fires
            # both on a short walk and on a row inserted mid-walk. Both are
            # refusals rather than findings: the vocabularies move slowly, and
            # the failure direction that matters is never shrinking the
            # vocabulary silently.
            raise ComprasError(f"{which}: walked {len(rows)} rows, API reported {total}")
        _log.info("catalogue walked", extra={"which": which, "rows": len(rows)})
        return rows
