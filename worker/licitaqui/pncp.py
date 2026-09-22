"""HTTP access to PNCP, under the §7.2 budget.

One circuit breaker per service, because they fail independently — the
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
- ``pncp-arquivos`` — `/api/pncp/v1/.../arquivos`, the "Arquivos" tab that
  :mod:`licitaqui.sync_files` reads. Its own breaker for the same reason again:
  it is served by the same host as the items endpoint but is a different
  service, and the file list going dark must not stop items arriving (nor the
  other way round).
- ``pncp-resultados`` — `/api/pncp/v1/.../itens/{n}/resultados`, the winner of
  one item, which :mod:`licitaqui.sync_awards` reads. Its own breaker again,
  and this one earns it twice over: awards are the only job that spends **one
  request per item** (§3.2), so it is by far the heaviest caller, and it is
  also the least urgent. When it goes down it must stop on its own without
  taking the sweep that feeds the Radar with it.

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
from .breaker import CircuitBreaker, CircuitOpen, get_breaker
from .observability import get_logger

_log = get_logger("pncp")

BASE_URL = "https://pncp.gov.br"
SEARCH_PATH = "/api/search/"
ATUALIZACAO_PATH = "/api/consulta/v1/contratacoes/atualizacao"
PUBLICACAO_PATH = "/api/consulta/v1/contratacoes/publicacao"
ITEMS_PATH = "/api/pncp/v1/orgaos/{cnpj}/compras/{year}/{sequence}/itens"
FILES_PATH = "/api/pncp/v1/orgaos/{cnpj}/compras/{year}/{sequence}/arquivos"
RESULTS_PATH = "/api/pncp/v1/orgaos/{cnpj}/compras/{year}/{sequence}/itens/{item}/resultados"
#: The Consulta detail endpoint: the **authoritative** header for one
#: contratação, and the only place `valorTotalEstimado`, `srp` and
#: `orcamentoSigilosoCodigo` can be read for a tender the search fallback
#: ingested (:mod:`licitaqui.tender_value`). §3.2 still calls it unstable, so
#: every caller must have somewhere to go when it is down.
#:
#: **Do not spell this `/api/pncp/v1/...`.** That spelling answers ``301`` with
#: a JSON body naming this path — and, measured on 2026-09-22, **no `Location`
#: header at all**, so `follow_redirects` cannot follow it and httpx hands the
#: 301 straight back::
#:
#:     {"status":"301","error":"301 MOVED_PERMANENTLY",
#:      "message":"Este endpoint foi movido para:
#:                 https://pncp.gov.br/api/consulta/v1/orgaos/{cnpj}/compras/{ano}/{sequencial}"}
#:
#: :func:`_http_error` turns that into a legible :class:`PncpError` rather than
#: a mystifying "expected a dict", and `test_pncp_client.py` pins this constant
#: to the `/api/consulta/` spelling so the old one cannot creep back.
CONTRATACAO_PATH = "/api/consulta/v1/orgaos/{cnpj}/compras/{year}/{sequence}"

#: The spelling that 301s, kept only so the error message can name it.
MOVED_CONTRATACAO_PREFIX = "/api/pncp/v1/orgaos/"

BREAKER_CONSULTA = "pncp-consulta"
BREAKER_SEARCH = "pncp-search"
BREAKER_ITEMS = "pncp-itens"
BREAKER_FILES = "pncp-arquivos"
BREAKER_RESULTS = "pncp-resultados"

#: What :meth:`PncpClient.contratacao_state` can tell the caller.
CONTRATACAO_GONE = "gone"
CONTRATACAO_PRESENT = "present"
CONTRATACAO_UNKNOWN = "unknown"

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
    """A PNCP call that did not return usable data.

    ``status_code`` is the HTTP status when there was one, and ``None`` when the
    request never got an answer (a timeout, a reset connection) — which is
    PNCP's characteristic failure, not an HTTP error.
    """

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class PncpNotFound(PncpError):
    """HTTP 404 — PNCP has no record at this path.

    Deliberately its own type, because on the item and file endpoints a 404 is
    **ambiguous** and only the caller can resolve it: "this contratação has no
    items/files" and "this contratação is gone" arrive as the same status. The
    client will not guess; see :mod:`licitaqui.absence` for the rule and
    :meth:`PncpClient.contratacao_state` for the signal that settles it.
    """


class PncpGone(PncpError):
    """HTTP 410 — the contratação was **excluded** by the agency.

    PNCP's Consulta detail endpoint answers a withdrawn contratação with
    ``410 GONE`` and ``"A contratação informada foi excluída e não pode ser
    consultada."`` — unlike the item and file endpoints, which 404. It is the
    only unambiguous "this is never coming back" PNCP gives us.
    """


def _http_error(path: str, response: httpx.Response) -> PncpError:
    """The right exception for a status the service *answered* with.

    404 and 410 get their own types because they carry meaning a caller acts
    on; every other 3xx/4xx is our bug and stays a plain :class:`PncpError`.

    A **301** is our bug in one specific, recurring way — the retired
    `/api/pncp/v1/orgaos/...` spelling of the contratação detail — and it does
    not look like one from the outside: PNCP sends no ``Location``, so
    ``follow_redirects`` is silently powerless and the caller just sees a
    non-200. The message says so outright rather than leaving the next person
    to re-measure it (see :data:`CONTRATACAO_PATH`).
    """
    status = response.status_code
    cls = {404: PncpNotFound, 410: PncpGone}.get(status, PncpError)
    hint = ""
    if status == 301:
        hint = (
            " — PNCP sends no Location header on this 301, so it cannot be followed. "
            f"Use {CONTRATACAO_PATH} rather than the retired "
            f"{MOVED_CONTRATACAO_PREFIX}… spelling."
        )
    return cls(f"GET {path} -> HTTP {status}: {response.text[:200]}{hint}", status_code=status)


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

    @property
    def files_breaker(self) -> CircuitBreaker:
        return get_breaker(BREAKER_FILES)

    @property
    def results_breaker(self) -> CircuitBreaker:
        return get_breaker(BREAKER_RESULTS)

    def _get(self, path: str, params: dict[str, Any], breaker: CircuitBreaker) -> Any:
        """One GET under the breaker. Raises on anything but 200 and 204.

        ``204`` is PNCP's "past the last page" and comes back as ``None``, which
        is a successful call: it closes a half-open circuit rather than tripping
        it.

        **The breaker measures whether the service is up, and nothing else.**
        Only a transport failure or a 5xx counts against it — those are the two
        shapes of "PNCP is down" that ADR-0001 measured, and the 3-hour outage
        on 2026-09-18 was made of exactly them. Everything the service *answered*
        leaves the guard normally, including a 4xx: the status is then raised
        outside the breaker, so the job fails and is retried while the circuit
        stays closed for every other tender.

        That split is not cosmetic. It used to record a success and then raise
        *inside* the guard, so the guard's own ``except`` counted the 4xx as a
        failure anyway — leaving the endpoint one failure short of open. A single
        404 on one withdrawn tender then turned the next genuine timeout into an
        open circuit, and every other tender's items or files stopped for fifteen
        minutes. That is what production showed on 2026-09-21 (jobs 2286/2287).

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
            if response.status_code >= 500:
                raise PncpError(
                    f"GET {path} -> HTTP {response.status_code}",
                    status_code=response.status_code,
                )
            # The service answered, and quickly. Whether the answer is *usable*
            # is decided below, where it cannot reach the breaker.
        status = response.status_code
        if status == 204:
            payload = None
        elif status == 200:
            payload = response.json() if response.content.strip() else None
        else:
            raise _http_error(path, response)
        _log.debug(
            "pncp call",
            extra={
                "path": path,
                "status": 204 if payload is None else 200,
                "duration_ms": int((time.monotonic() - started) * 1000),
            },
        )
        return payload

    # -- the contratação detail (the authoritative header) ----------------

    def fetch_contratacao(
        self, cnpj: int | str, year: int, sequence: int
    ) -> dict[str, Any] | None:
        """One contratação's Consulta detail record, or ``None`` on a 204.

        This is the **same request** :meth:`contratacao_state` makes; the only
        difference is that this one keeps the body. That body is the answer to
        the question the search fallback cannot answer — it carries
        ``valorTotalEstimado``, ``srp`` and ``orcamentoSigilosoCodigo``, none of
        which the search index publishes (:mod:`licitaqui.tender_value`).

        Raises rather than guessing, because each status means something
        different to the caller:

        ``410`` → :class:`PncpGone`
            the agency excluded the contratação. It is never coming back, and a
            backfill that keeps retrying it burns its budget on nothing — 206
            rows in production carry a non-`Divulgada` status today.
        ``404`` → :class:`PncpNotFound`
            PNCP has no record at this path at all.
        anything else, or a timeout → :class:`PncpError`
            including the read timeouts that *are* this service's characteristic
            failure. The caller falls back; it must not record a value it did
            not receive.
        """
        path = CONTRATACAO_PATH.format(cnpj=cnpj, year=year, sequence=sequence)
        body = self._get(path, {}, self.consulta_breaker)
        if body is None:
            return None
        if not isinstance(body, dict):
            raise PncpError(f"GET {path} -> expected an object, got {type(body).__name__}")
        return body

    # -- is this contratação still on PNCP at all? ------------------------

    def contratacao_state(self, cnpj: int | str, year: int, sequence: int) -> str:
        """``gone`` | ``present`` | ``unknown`` for one contratação.

        The item and file endpoints answer a withdrawn contratação and one with
        nothing to list with the *same* 404, so neither can settle which it is.
        The Consulta detail endpoint can: measured on 2026-09-22 against the
        three tenders whose jobs were stuck in production, it answers

            ``410 GONE — "A contratação informada foi excluída e não pode ser
            consultada."``

        for a withdrawn one, and ``200`` for a live one.

        On the ``pncp-consulta`` breaker, as ADR-0001 §4 requires — the whole
        Consulta service shares one circuit. That is affordable precisely
        because of the rule above: neither the 410 nor a 404 counts against it,
        so this diagnostic can never be what opens the circuit the sweep
        depends on. When the circuit *is* open, or the service times out, the
        answer is ``unknown`` and the caller must not pretend otherwise.

        Implemented on :meth:`fetch_contratacao` so there is one request, one
        path and one set of status rules to keep right. A caller that also
        wants the header should call that instead and read the verdict off the
        exception — asking both would be two requests for one answer.
        """
        try:
            self.fetch_contratacao(cnpj, year, sequence)
        except PncpGone:
            return CONTRATACAO_GONE
        except (PncpError, CircuitOpen):
            return CONTRATACAO_UNKNOWN
        return CONTRATACAO_PRESENT

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
        genuinely has no items.

        A **404 still raises** — as :class:`PncpNotFound`, so the caller can
        tell it from an outage. It is never quietly turned into an empty list
        here, because doing so would let :func:`licitaqui.items.upsert_items`
        prune rows we still hold. Resolving what the 404 means needs the
        database and one more question to PNCP, so it belongs to
        :mod:`licitaqui.absence` and :mod:`licitaqui.sync_items`, not here.
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

    # -- the arquivos endpoint (§7.1 sync_files) --------------------------

    def fetch_files(self, cnpj: int | str, year: int, sequence: int) -> list[dict[str, Any]]:
        """Every document on one contratação's "Arquivos" tab, in one call.

        **Deliberately unpaged**, which is POC 1's shape too: this endpoint
        answers with the whole list in a bare JSON array. Measured over the 99
        tenders with a cached file list in the knowledge base (371 documents):
        median 1 document, 95th percentile 14, maximum 39. A page loop here
        would be one more way to spend a job's timeout budget on an endpoint
        §7.2 already calls unreliable, for a list that arrives whole.

        A ``204`` (empty body) means the tender genuinely has no documents and
        comes back as ``[]``. Anything else raises, a 404 included — as
        :class:`PncpNotFound`, so the caller can tell it from an outage. It is
        never quietly turned into an empty list here: a tender that had an
        edital yesterday and 404s today must never be allowed to prune
        (:func:`licitaqui.files.upsert_files`). What the 404 *does* mean is
        :mod:`licitaqui.absence`'s question, not this method's.
        """
        path = FILES_PATH.format(cnpj=cnpj, year=year, sequence=sequence)
        body = self._get(path, {}, self.files_breaker)
        if body is None:
            return []
        if not isinstance(body, list):
            raise PncpError(f"GET {path} -> expected a list, got {type(body).__name__}")
        return body

    # -- the resultados endpoint (§7.1 sync_awards) -----------------------

    def fetch_results(
        self, cnpj: int | str, year: int, sequence: int, item_number: int
    ) -> list[dict[str, Any]]:
        """Who won one item, and for how much. **One request per item** (§3.2).

        POC 3's endpoint, unchanged, and unpaged for the same reason
        :meth:`fetch_files` is: it answers with a bare JSON array and there is
        at most a handful of results per item — 420 results over the 418 cached
        item queries in the knowledge base, the largest being two
        (``sequencialResultado`` 1 and 2, a Registro de Preços runner-up).

        A ``204`` means this item has no published result and comes back as
        ``[]`` — measured: asking for item 999 of a real tender answers 204,
        not 404. Anything else raises, a 404 included: an item that had a
        winner yesterday and 404s today is an outage, and
        :mod:`licitaqui.sync_awards` must not read it as "not awarded after
        all" and keep re-asking.
        """
        path = RESULTS_PATH.format(cnpj=cnpj, year=year, sequence=sequence, item=item_number)
        body = self._get(path, {}, self.results_breaker)
        if body is None:
            return []
        if not isinstance(body, list):
            raise PncpError(f"GET {path} -> expected a list, got {type(body).__name__}")
        return body

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
