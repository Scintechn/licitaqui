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

## The date window on the price endpoint needs BOTH bounds, or it is ignored

Measured 2026-10-03 against the live API, PDM 13768, five sequential calls:

===========================================  ================  ==============
request                                      ``totalRegistros``  oldest row
===========================================  ================  ==============
``tipo=codigoPdm&codigo=13768``              30 616            —
``…&dataCompraInicio=2026-09-29``            **30 616**        **2026-07-29**
``…&dataCompraInicio=2026-09-01&dataCompraFim=2026-09-30``  429  2026-09-09
===========================================  ================  ==============

``dataCompraInicio`` **alone is silently dropped** — same row count, rows two
months outside the window, HTTP 200. An incremental refresh built on it would
re-walk 18 months on every pass while its log said it had asked for a day, which
is the shape `CLAUDE.md` collects: a measurement of our own broken query. So
:meth:`ComprasClient.walk_prices` always sends both bounds **and asserts every
row landed inside them** — in code, not in a comment, because the failure is
invisible otherwise.

``dataCompraFim`` is inclusive (measured; the back-test's no-look-ahead
assertion caught it being so).
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date
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

#: The price-research endpoint, keyed by ``tender_item_codes.kind``.
#:
#: **``'S'`` is deliberately absent.** `3_consultarServico` exists, and asking it
#: would be spending the refresh budget on nothing: services resolve at 22.4%
#: and produced **0 bands from any source** across 136 service items (measured).
#: A ``KeyError`` on ``'S'`` is the intended behaviour — a mapping with a service
#: path in it would be an invitation to queue 911 CATSER codes that cannot
#: produce a row any screen will read. When somebody has a service-specific
#: measurement saying which gate fires, the path goes in with that measurement.
PRICE_PATHS = {
    "M": "/modulo-pesquisa-preco/1_consultarMaterial",
}

#: The only fields of a price row that leave this module.
#:
#: **This is a privacy boundary, not a tidiness one.** A raw row carries
#: ``niFornecedor`` — a CNPJ **or a CPF** for an individual supplier — and
#: ``nomeFornecedor``. `catalog_prices.StoredPrice` has nowhere to put either,
#: which protects *storage*; it does nothing about a **traceback**. Sentry is
#: initialised with ``send_default_pii=False``, which governs request bodies and
#: user context and leaves ``include_local_variables`` at its default of
#: ``True``, so the locals of every frame in a traceback are serialised and sent.
#: A raw payload left alive as a local of the refresh job would therefore reach a
#: third-party error tracker on any ordinary failure — a deadlock, a numeric
#: overflow, a dropped connection — silently, and no test can see it because
#: Sentry is not initialised under pytest.
#:
#: So the projection happens at the HTTP boundary: :meth:`ComprasClient._price_page`
#: reduces each row before returning, and the raw body never outlives the one
#: frame that parsed it. That frame reads the counts by :func:`isinstance`
#: narrowing rather than ``int(body.get(...) or 0)`` **so that no statement after
#: the parse can raise at all** — the first version asserted that property in a
#: docstring while `int("30.616")` and a non-mapping body could both raise with
#: the full payload alive as a local. An unraisable frame is the claim; a comment
#: saying so is not.
PRICE_ROW_FIELDS = (
    "idCompra",
    "numeroItemCompra",
    "precoUnitario",
    "dataCompra",
    "siglaUnidadeFornecimento",
    "siglaUnidadeMedida",
    "codigoItemCatalogo",
    "descricaoItem",
)

#: How many rows a completed walk may be short of the count page 1 reported.
#:
#: **Not one page.** The first version of this tolerated :data:`PAGE_SIZE`, and
#: the argument in the docstring — that at the measured insert rate a 62-page
#: walk drifts by *far less than one row* — justified a number three orders of
#: magnitude smaller than the one it set. The gap was the defect: a single page
#: returning an empty ``resultado`` loses exactly ``PAGE_SIZE`` rows and
#: ``total - PAGE_SIZE < total - PAGE_SIZE`` is false, so a band would be
#: computed over the surviving sample with no refusal recorded and no counter
#: fired. On a median code (379 purchases ≈ 709 rows) that is ~70% of the
#: evidence missing, and a shrunken sample makes :data:`MAX_SPREAD` *more* likely
#: to pass, not less.
#:
#: **Five rows is a judgement, not a derivation, and it should read as one**
#: (`CLAUDE.md` §4d). The measured insert rate — ~1.3% of a deep code's rows a
#: week, so ~0.2% a day — over a 62-page walk lasting ~4 minutes implies a drift
#: of about **0.17 rows** [I, from measured inputs]. So the figure the evidence
#: supports is zero, and five is a margin chosen for jitter the measurement did
#: not cover: a retried page, a clock skew in the API's own pagination, a row
#: updated rather than inserted. What matters for the defect is that it is a
#: handful and not a page — at 500 the check could not see a lost page at all.
WALK_DRIFT_TOLERANCE = 5

#: Safety ceiling on one code's page walk, and the reason it is this high.
#:
#: There is no cap in the design — the measurement is that codes read to full
#: depth banded at **11.5%** against **3.2%** for ones a 4-page probe cap
#: truncated, so the extra pages are worth paying for and truncation costs
#: coverage. This is purely a bound on one job: the deepest code measured
#: 2026-10-03 (PDM 13768) holds 30 616 rows = **62 pages** at
#: :data:`PAGE_SIZE`, so 200 pages is 100 000 rows — more than 3× anything
#: observed — and a code past it is a surprise worth refusing rather than a walk
#: worth running for an hour on a concurrency-2 worker (``config.py``).
#:
#: Hitting it writes :data:`licitaqui.catalog_prices.TRUNCATED_EVENT` and no
#: band row at all, so the cap can never silently bite and can never supersede a
#: band that was correct yesterday.
MAX_PRICE_PAGES = 200

_interval_lock = threading.Lock()
_last_call = [0.0]


class ComprasError(RuntimeError):
    """A request that did not yield a usable body after its retries."""


def _as_count(value: Any) -> int | None:
    """A row or page count, ``0`` for a genuine zero, or **``None`` for "cannot
    read this"** — and it cannot raise.

    Three versions of this have been wrong in different ways, so each rule is
    written down:

    * `int(value or 0)` raises on ``"30.616"`` and on a dict. Harmless in most
      modules and not in this one: the only caller holds a raw price payload as
      a local while it runs, and a raised exception serialises that into
      Sentry's frame locals (see :data:`PRICE_ROW_FIELDS`).
    * **Returning ``0`` for something unreadable was worse than raising.**
      ``walk_prices`` treats ``total == 0`` as *this code has no purchases*, so a
      count it could not parse discarded a full page of real rows and wrote
      ``refused_reason='no_rows'`` — `memory: empty-result-is-not-absence`, with
      a schema behind it, and one upstream type change would hit the whole feed
      at once while `refreshed_codes` stayed healthy. ``None`` makes *unreadable*
      distinguishable from *zero*, and the caller raises on it — in a frame that
      holds only projected rows.
    * ``str.isdigit()`` is **True for ``'²'``** while ``int('²')`` raises, so the
      test is ``isdecimal()``. One character, and it was the last way this
      function could still raise.

    A JSON float is accepted when it is integral (``30616.0`` is a count written
    sloppily); a fractional one is not a count at all. ``True`` is refused
    because ``int(True)`` is 1 and would silently become one.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return max(0, value)
    if isinstance(value, float):
        return max(0, int(value)) if value.is_integer() else None
    if isinstance(value, str) and value.strip().isdecimal():
        return int(value.strip())
    return None


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


@dataclass(frozen=True, slots=True)
class PriceWalk:
    """One code's price rows, and whether the walk is entitled to feed a band.

    Two outcomes a caller has to tell apart, and they are not the same finding:

    ``total == 0``
        The API answered that this code has no purchases in the window. A
        **genuine answer** — ~6% of uniformly sampled needed codes really have
        none in 18 months, verified by re-asking over 5 years. A 404 and a 200
        with zero rows both land here; there was a ``not_found`` flag separating
        them and it was removed, because no caller read it and `CLAUDE.md` is
        explicit that a field nothing reads is either given a reader or deleted.
    ``complete is False``
        The walk stopped at :data:`MAX_PRICE_PAGES`. A partial read is not that
        code's band, so the caller records it and computes nothing.

    An *empty* walk with rows advertised never arrives here at all:
    :meth:`ComprasClient.walk_prices` raises on it, because `CLAUDE.md` says an
    empty result is not an absence.
    """

    rows: list[dict[str, Any]]
    total: int
    pages_read: int
    complete: bool


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

    @property
    def price_breaker(self) -> CircuitBreaker:
        """Its own breaker, because **a breaker is per endpoint**.

        `pncp-resultados` was open for a whole morning on 2026-09-30 while PNCP
        search was healthy (`CLAUDE.md`). Sharing `compras-catalogo` would let a
        weekly vocabulary walk's trouble stop the price refresh and, worse, let
        12 974 price calls a pass open the circuit under the vocabulary mirror
        the mapper depends on.
        """
        return get_breaker("compras-pesquisa-preco")

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

    def walk_prices(
        self,
        kind: str,
        code: int,
        *,
        start: date,
        end: date,
        max_pages: int = MAX_PRICE_PAGES,
    ) -> PriceWalk:
        """Every price row for one code in ``[start, end]``, both bounds sent.

        ``start`` and ``end`` are **calendar dates in BRT**: `dataCompra` is a
        Brazilian calendar date, and the row this eventually writes is UTC
        (`CLAUDE.md`'s clocks). The caller converts once; this method never
        looks at a clock.

        Three refusals live here rather than in the job, because they are
        properties of the read:

        * **an empty walk raises.** `totalRegistros` above zero with no rows
          collected is a broken run, not a finding of zero — the same rule
          :meth:`walk_catalogue` applies, and the reason `coverage_check`
          exists;
        * **a short walk raises.** Tolerance is :data:`WALK_DRIFT_TOLERANCE`
          rows, not zero, and that differs from :meth:`walk_catalogue` on
          purpose: the vocabularies are static while this feed is live, so a
          purchase inserted mid-walk shifts pagination. It is deliberately a
          handful of rows and **not a page** — see that constant for the
          defect a page-wide tolerance hid;
        * **a page count that does not follow from the row count raises**, for
          the same reason: an absent ``totalPaginas`` would otherwise read as
          "one page, complete". It is a hard stop on one assumption — that the
          API computes ``totalPaginas`` from the ``tamanhoPagina`` we sent,
          which is one measurement — so if that ever stops holding, every code
          raises. What makes that survivable rather than a feed-wide spin is the
          attempt marker in :mod:`licitaqui.catalog_prices`: a code that trips
          any of these guards is left alone for a cadence instead of re-walked
          daily;
        * **a window the API ignored raises.** Measured 2026-10-03 and
          documented at the top of this module: ``dataCompraInicio`` alone is
          dropped silently, so the only way to know the filter applied is to
          check the rows that came back.
        """
        path = PRICE_PATHS[kind]
        window = {
            "tipo": "codigoPdm",
            "codigo": code,
            "dataCompraInicio": start.isoformat(),
            # Both bounds, always. One of them alone is ignored (measured), and
            # an ignored window reads as a successful incremental refresh.
            "dataCompraFim": end.isoformat(),
            "tamanhoPagina": PAGE_SIZE,
        }
        rows, total, reported_pages, not_found = self._price_page(path, window, 1)
        if total is None:
            # **Unreadable is not zero.** Returning zero here discarded a full
            # page of real rows and recorded `no_rows` — a finding of "nobody
            # buys this" manufactured from our own failure to parse a number.
            # Raised in this frame, where only projected rows are alive.
            raise ComprasError(
                f"{kind}/{code}: totalRegistros came back unreadable — "
                "refusing rather than recording a zero"
            )
        if rows and total == 0:
            # The other direction of the same lie: rows in hand while the count
            # says there are none. One of the two is wrong and neither is a
            # finding, so this is a broken read.
            raise ComprasError(
                f"{kind}/{code}: totalRegistros is 0 while the page carried "
                f"{len(rows)} rows — a broken read, not a finding"
            )
        if not_found or total == 0:
            # A genuine zero, from a 404 or from a 200 with no rows. Both are
            # answers, and both are distinguishable from a blocked connection —
            # that raises rather than returning — and now from an unreadable
            # count, which raises above.
            return PriceWalk(rows=[], total=0, pages_read=1, complete=True)

        # **Derived from the count, not taken from `totalPaginas`.** This module
        # exists because the API lies by omission — that is the
        # `dataCompraInicio` finding — and an absent, zero or malformed
        # `totalPaginas` beside a non-zero `totalRegistros` would otherwise read
        # as "one page, complete": `min(0, max_pages)` is 0, the page loop never
        # runs, and `0 <= max_pages` says the walk finished. Up to 999 rows
        # become 500 with a band written over half of them and no refusal.
        pages = -(-total // PAGE_SIZE)
        if reported_pages is not None and reported_pages and reported_pages != pages:
            raise ComprasError(
                f"{kind}/{code}: API reported {total} rows in {reported_pages} "
                f"pages, which is not {pages} pages of {PAGE_SIZE} — refusing "
                "rather than guessing which number is wrong"
            )

        last_page = min(pages, max_pages)
        for page in range(2, last_page + 1):
            more, page_total, _pages, _nf = self._price_page(path, window, page)
            if page_total is None:
                raise ComprasError(
                    f"{kind}/{code}: page {page} returned an unreadable "
                    "totalRegistros — refusing rather than walking on"
                )
            rows.extend(more)

        complete = pages <= max_pages
        if not rows:
            raise ComprasError(
                f"{kind}/{code}: API reported {total} rows and the walk "
                "collected none — a broken run, not a finding"
            )
        # **Distinct identities, not row count.** A pagination fault that served
        # page 1's rows again for page 2 gives `len(rows) == total` and would
        # pass — with 500 duplicates standing in for 500 purchases that were
        # never read. The collapse would then quietly dedupe them and the band
        # would be computed over a halved sample with `refused_reason` null,
        # which is the same consequence the one-page tolerance had.
        seen = {(row.get("idCompra"), row.get("numeroItemCompra")) for row in rows}
        if complete and len(seen) < total - WALK_DRIFT_TOLERANCE:
            raise ComprasError(
                f"{kind}/{code}: walked {len(rows)} rows ({len(seen)} distinct "
                f"items), API reported {total} — short by more than "
                f"{WALK_DRIFT_TOLERANCE}, so a truncated or repeating read "
                "rather than a live feed shifting under us"
            )
        self._assert_window(kind, code, rows, start, end)
        _log.info(
            "prices walked",
            extra={
                "kind": kind,
                "code": code,
                "rows": len(rows),
                "reported": total,
                "pages": last_page,
                "complete": complete,
                "window_start": start.isoformat(),
                "window_end": end.isoformat(),
            },
        )
        return PriceWalk(rows=rows, total=total, pages_read=last_page, complete=complete)

    def _price_page(
        self,
        path: str,
        window: dict[str, Any],
        page: int,
    ) -> tuple[list[dict[str, Any]], int, int, bool]:
        """One page, with every row reduced to :data:`PRICE_ROW_FIELDS`.

        The projection is here and not in the caller so the **raw body never
        outlives this frame**, and this frame has no statement after the parse
        that can raise. A traceback from anywhere else in the refresh therefore
        cannot carry a supplier identifier into Sentry's frame locals — see
        :data:`PRICE_ROW_FIELDS` for why that is a live hazard rather than a
        theoretical one.
        """
        body = self.get(path, {**window, "pagina": page}, self.price_breaker)
        # Every read below narrows by type instead of coercing. `body` is the
        # full payload — up to 500 rows each carrying `niFornecedor` — so a
        # `ValueError` out of `int("30.616")`, or an `AttributeError` because the
        # body came back as a top-level array, would put all of it into Sentry's
        # frame locals. Nothing here can raise, which is the only honest form of
        # the claim :data:`PRICE_ROW_FIELDS` makes.
        fields = body if isinstance(body, dict) else {}
        found = fields.get("resultado")
        rows = [
            {field: row.get(field) for field in PRICE_ROW_FIELDS}
            for row in (found if isinstance(found, list) else [])
            if isinstance(row, dict)
        ]
        # The counts are returned as read — ``None`` meaning unreadable — and
        # the caller decides. Deciding here would mean raising with the payload
        # alive, which is the one thing this frame exists to avoid.
        return (
            rows,
            _as_count(fields.get("totalRegistros")),
            _as_count(fields.get("totalPaginas")),
            fields.get("notFound") is True,
        )

    @staticmethod
    def _assert_window(
        kind: str, code: int, rows: list[dict[str, Any]], start: date, end: date
    ) -> None:
        """Refuse rows the requested window should have excluded.

        This is the guard for the measured trap, and it has to be code: with
        ``dataCompraInicio`` alone the API answered 200, reported the *same*
        30 616 rows as an unfiltered request, and served rows two months before
        the window. Nothing in the response says the filter was dropped.

        Rows with no parseable `dataCompra` are not evidence either way and are
        passed over; a row that *does* carry one and sits outside stops the run.
        """
        for row in rows:
            raw = row.get("dataCompra")
            if not isinstance(raw, str):
                continue
            try:
                purchased_on = date.fromisoformat(raw[:10])
            except ValueError:
                continue
            if purchased_on < start or purchased_on > end:
                raise ComprasError(
                    f"{kind}/{code}: asked for [{start}, {end}] and got a row "
                    f"dated {purchased_on} — the API ignored the window, so "
                    "this walk is not the window it claims to be"
                )
