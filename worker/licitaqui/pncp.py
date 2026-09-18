"""HTTP access to PNCP, under the §7.2 budget.

Three services, three circuit breakers, because they fail independently — the
measurements behind ADR-0001 caught `/api/consulta` down for thirteen minutes
while `/api/search/` answered every request:

- ``pncp-consulta`` — the documented Consulta API, including the period
  endpoints ``/v1/contratacoes/atualizacao`` and ``/publicacao`` that
  :mod:`licitaqui.sync_tenders` sweeps.
- ``pncp-search`` — the undocumented backend of the `pncp.gov.br/app/editais`
  screen, kept as the fallback sweep.
- ``pncp-itens`` — `/api/pncp/v1/.../itens`, which :mod:`licitaqui.sync_items`
  reads. POC 1 kept it apart from the detail endpoint for the same reason: the
  detail endpoint is the one that returns HTTP 500, and an items outage must
  not stop the sweep that feeds every other job.

Three rules this module exists to enforce:

**No retries here.** A failed call raises. The queue owns retries — 2, 8 and
30 minutes, four attempts (§7.2) — and the breaker owns "stop calling a service
that is down". Retrying inside a page loop as well would multiply those into
the retry storm §7.2 forbids, and would hide the failure rate the ADR measures.

**A pace a public government API should not notice.** One request at a time per
client, at most :data:`DEFAULT_RATE_LIMIT` per second, with the ``/atualizacao``
page size pinned to 50 because the period endpoints reject every other value
("Tamanho de página inválido" for 100 and 500).

**Timeouts from the spec, not from httpx's defaults:** connect 15 s, read 30 s.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import date
from typing import Any

import httpx

from . import config
from .breaker import CircuitBreaker, get_breaker
from .observability import get_logger

_log = get_logger("pncp")

BASE_URL = "https://pncp.gov.br"
SEARCH_PATH = "/api/search/"
ATUALIZACAO_PATH = "/api/consulta/v1/contratacoes/atualizacao"
PUBLICACAO_PATH = "/api/consulta/v1/contratacoes/publicacao"
ITEMS_PATH = "/api/pncp/v1/orgaos/{cnpj}/compras/{year}/{sequence}/itens"

BREAKER_CONSULTA = "pncp-consulta"
BREAKER_SEARCH = "pncp-search"
BREAKER_ITEMS = "pncp-itens"

#: The period endpoints accept this and nothing else. 100 and 500 are rejected
#: with "Tamanho de página inválido"; it is not a tunable.
PERIOD_PAGE_SIZE = 50
#: The search API caps `pagina × tam_pagina` at 10,000, so a sweep that needs
#: more than that has to be partitioned — which is half of why ADR-0001 picked
#: the period endpoints.
SEARCH_PAGE_SIZE = 500
SEARCH_WINDOW_CAP = 10_000
#: POC 1's page size for the items endpoint, which unlike the period endpoints
#: accepts it. Most tenders have far fewer items than this, so it is normally
#: one request per tender.
ITEMS_PAGE_SIZE = 500

#: §7.2: throttle PNCP calls (e.g. 4 req/s per worker).
DEFAULT_RATE_LIMIT = 4.0
#: An extra breath between pages of the same sweep, on top of the rate limit.
DEFAULT_PAGE_DELAY_SECONDS = 0.15
#: A page loop that never terminates would hammer the API forever. PNCP
#: reported 90 pages for one day × one modality; this is an order of magnitude
#: of headroom over that, and it is a bug guard, not a budget.
MAX_PAGES = 2_000

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Accept-Language": "pt-BR,pt;q=0.9",
    "Referer": f"{BASE_URL}/app/editais",
}


class PncpError(RuntimeError):
    """A PNCP call that did not return usable data."""


def _timeout() -> httpx.Timeout:
    return httpx.Timeout(
        connect=float(config.DEFAULT_CONNECT_TIMEOUT_SECONDS),
        read=float(config.DEFAULT_STATEMENT_TIMEOUT_SECONDS),
        write=float(config.DEFAULT_STATEMENT_TIMEOUT_SECONDS),
        pool=float(config.DEFAULT_STATEMENT_TIMEOUT_SECONDS),
    )


class _Throttle:
    """At most ``rate`` requests per second, shared across threads."""

    def __init__(self, rate: float) -> None:
        self._min_interval = 0.0 if rate <= 0 else 1.0 / rate
        self._lock = threading.Lock()
        self._next_at = 0.0

    def wait(self) -> None:
        if self._min_interval <= 0:
            return
        with self._lock:
            now = time.monotonic()
            sleep_for = self._next_at - now
            self._next_at = max(now, self._next_at) + self._min_interval
        if sleep_for > 0:
            time.sleep(sleep_for)


@dataclass
class PncpClient:
    """One HTTP client for both PNCP services, with their breakers attached.

    Built per job rather than per process: a job is a unit of work with its own
    connection budget, and a client held open between jobs would keep sockets
    to PNCP alive while the worker is idle.
    """

    base_url: str = BASE_URL
    rate_limit: float = DEFAULT_RATE_LIMIT
    page_delay: float = DEFAULT_PAGE_DELAY_SECONDS
    transport: httpx.BaseTransport | None = None
    _client: httpx.Client = field(init=False, repr=False)
    _throttle: _Throttle = field(init=False, repr=False)

    def __post_init__(self) -> None:
        self._client = httpx.Client(
            base_url=self.base_url,
            headers=HEADERS,
            timeout=_timeout(),
            follow_redirects=True,
            transport=self.transport,
        )
        self._throttle = _Throttle(self.rate_limit)

    def __enter__(self) -> PncpClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._client.close()

    # -- one request ------------------------------------------------------

    @property
    def consulta_breaker(self) -> CircuitBreaker:
        return get_breaker(BREAKER_CONSULTA)

    @property
    def search_breaker(self) -> CircuitBreaker:
        return get_breaker(BREAKER_SEARCH)

    @property
    def items_breaker(self) -> CircuitBreaker:
        return get_breaker(BREAKER_ITEMS)

    def _get(self, path: str, params: dict[str, Any], breaker: CircuitBreaker) -> Any:
        """One GET under the breaker. Raises on anything but 200 and 204.

        ``204`` is PNCP's "past the last page" and comes back as ``None``, which
        is a successful call: it closes a half-open circuit rather than tripping
        it. A 4xx is the caller's fault and is *not* counted against the
        breaker — a bad parameter must not open the circuit for a healthy
        service — but it still raises, so the job fails and is retried.

        Every transport failure is translated into :class:`PncpError`. That
        matters more than it looks: PNCP's characteristic failure is a *read
        timeout*, not an HTTP error — every one of the 16 failures behind
        ADR-0001, and all 11 observed during the 3-hour outage on 2026-09-18,
        were timeouts. Left as ``httpx.ReadTimeout`` those would sail past a
        caller catching ``PncpError``, and the search fallback would never fire
        in exactly the situation it exists for.
        """
        self._throttle.wait()
        started = time.monotonic()
        with breaker.guard():
            try:
                response = self._client.get(path, params=params)
            except httpx.HTTPError as exc:
                raise PncpError(f"GET {path} -> {type(exc).__name__}: {exc}") from exc
            if response.status_code == 204:
                payload = None
            elif response.status_code == 200:
                payload = response.json() if response.content.strip() else None
            elif 400 <= response.status_code < 500:
                # Record a success first: the service answered, and quickly.
                breaker.record_success()
                raise PncpError(f"GET {path} -> HTTP {response.status_code}: {response.text[:200]}")
            else:
                raise PncpError(f"GET {path} -> HTTP {response.status_code}")
        _log.debug(
            "pncp call",
            extra={
                "path": path,
                "status": 204 if payload is None else 200,
                "duration_ms": int((time.monotonic() - started) * 1000),
            },
        )
        return payload

    # -- the period endpoints (ADR-0001, the primary path) ----------------

    def iter_atualizacao(
        self,
        day_from: date,
        day_to: date,
        modality: int,
        *,
        uf: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Every contratação whose `dataAtualizacaoGlobal` falls in the window.

        Windows on the timestamp that moves when the record **or any of its
        children** changes, which is the trigger §7.1 needs. Pages at 50 until
        ``paginasRestantes`` reaches 0; a ``204`` also ends the walk, because
        that is what PNCP returns past the last page.
        """
        yield from self._iter_period(ATUALIZACAO_PATH, day_from, day_to, modality, uf)

    def iter_publicacao(
        self,
        day_from: date,
        day_to: date,
        modality: int,
        *,
        uf: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        """Same walk, windowed on publication date: the initial backfill (ADR §5)."""
        yield from self._iter_period(PUBLICACAO_PATH, day_from, day_to, modality, uf)

    def _iter_period(
        self,
        path: str,
        day_from: date,
        day_to: date,
        modality: int,
        uf: str | None,
    ) -> Iterator[dict[str, Any]]:
        params: dict[str, Any] = {
            "dataInicial": day_from.strftime("%Y%m%d"),
            "dataFinal": day_to.strftime("%Y%m%d"),
            "codigoModalidadeContratacao": modality,
            "tamanhoPagina": PERIOD_PAGE_SIZE,
        }
        if uf:
            params["uf"] = uf
        for page in range(1, MAX_PAGES + 1):
            body = self._get(path, {**params, "pagina": page}, self.consulta_breaker)
            if not body:
                return
            records = body.get("data") or []
            yield from records
            if body.get("paginasRestantes", 0) <= 0 or not records:
                return
            if self.page_delay:
                time.sleep(self.page_delay)
        _log.warning("period sweep hit the page guard", extra={"path": path, "pages": MAX_PAGES})

    # -- the items endpoint (§7.1 sync_items) -----------------------------

    def iter_items(self, cnpj: str, year: int, sequence: int) -> Iterator[dict[str, Any]]:
        """Every item of one contratação, paged the way POC 1 pages it.

        This endpoint answers with a bare JSON **array**, not the ``{data,
        paginasRestantes}`` envelope the period endpoints use, so the walk ends
        on a short page. A 204 (empty body) ends it too and means the tender
        genuinely has no items; a 404 raises, because a tender that has items
        today and 404s tomorrow is an outage, not an empty list, and must not
        be allowed to delete rows (:func:`licitaqui.items.upsert_items`).
        """
        path = ITEMS_PATH.format(cnpj=cnpj, year=year, sequence=sequence)
        for page in range(1, MAX_PAGES + 1):
            body = self._get(
                path,
                {"pagina": page, "tamanhoPagina": ITEMS_PAGE_SIZE},
                self.items_breaker,
            )
            if not body:
                return
            if not isinstance(body, list):
                raise PncpError(f"GET {path} -> expected a list, got {type(body).__name__}")
            yield from body
            if len(body) < ITEMS_PAGE_SIZE:
                return
            if self.page_delay:
                time.sleep(self.page_delay)
        _log.warning("items walk hit the page guard", extra={"path": path, "pages": MAX_PAGES})

    # -- the search API (ADR-0001, the fallback) --------------------------

    def iter_search(
        self,
        *,
        uf: str | None = None,
        modalities: tuple[int, ...] = (),
        status: str = "recebendo_proposta",
        page_size: int = SEARCH_PAGE_SIZE,
        stop_at: str | None = None,
    ) -> Iterator[dict[str, Any]]:
        """The POC's sweep, update-ordered, stopping at a watermark.

        ``ordenacao=-data`` really is descending `data_atualizacao_pncp` (ADR),
        so ``stop_at`` — an ISO timestamp — ends the walk at the first record
        already older than the last cycle. There is no server-side date filter:
        `dataInicial` and `dataFinal` are silently ignored by this endpoint.
        """
        params: dict[str, Any] = {
            "tipos_documento": "edital",
            "ordenacao": "-data",
            "tam_pagina": page_size,
        }
        if status:
            params["status"] = status
        if uf:
            params["ufs"] = uf
        if modalities:
            params["modalidades"] = "|".join(str(m) for m in modalities)
        for page in range(1, MAX_PAGES + 1):
            if page * page_size > SEARCH_WINDOW_CAP:
                _log.warning(
                    "search sweep hit PNCP's 10,000-record window",
                    extra={"uf": uf, "page": page},
                )
                return
            body = self._get(SEARCH_PATH, {**params, "pagina": page}, self.search_breaker)
            if not body:
                return
            items = body.get("items") or []
            for item in items:
                stamp = item.get("data_atualizacao_pncp")
                # Only a *present* timestamp older than the watermark ends the
                # walk. An item missing the field would otherwise compare as ""
                # and truncate the whole sweep at that record; yielding it costs
                # one redundant upsert, which the change detection absorbs.
                if stop_at and stamp and str(stamp) <= stop_at:
                    return
                yield item
            if len(items) < page_size:
                return
            if self.page_delay:
                time.sleep(self.page_delay)
