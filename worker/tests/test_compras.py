"""The dadosabertos client (card B36). No network: httpx MockTransport throughout.

The first test here exists because the first version of this file **could not
open its breaker**. `CircuitBreaker.guard()` records success on any normal
return, so returning a 503 from inside the guard called ``record_success()`` and
*reset* the failure count — and a run alternating reset-by-peer with 503 could
never accumulate two consecutive failures at all. `pncp.py` raises inside the
guard for exactly this reason; this file returned. Both shapes are pinned below,
because a breaker that cannot open is invisible until the day it is needed —
which is B32's 916 failing jobs.
"""

from __future__ import annotations

import contextlib

import httpx
import pytest

from licitaqui import breaker as breaker_module
from licitaqui.breaker import CircuitOpen, get_breaker
from licitaqui.compras import ComprasClient, ComprasError


@pytest.fixture(autouse=True)
def _fresh_breakers():
    """Breakers are process-wide, and so is the spacing — reset both per test."""
    from licitaqui import compras

    breaker_module.reset_all()
    original = compras.MIN_INTERVAL[0]
    compras.MIN_INTERVAL[0] = 0.0
    yield
    compras.MIN_INTERVAL[0] = original
    breaker_module.reset_all()


def _client(handler) -> ComprasClient:
    """Real retry logic, collapsed delays — the waits are measured in seconds."""
    return ComprasClient(
        transport=httpx.MockTransport(handler), attempts=2, sleep=lambda _seconds: None
    )


# --------------------------------------------------- the breaker must open


def test_repeated_http_5xx_opens_the_breaker() -> None:
    """A 503 is a failure. It used not to be, and that was the defect."""
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(503, json={})

    client = _client(handler)
    with pytest.raises(ComprasError):
        client.get("/x", {}, client.catalogue_breaker)
    # Threshold is 2 consecutive failures (config.BREAKER_FAILURE_THRESHOLD).
    assert get_breaker("compras-catalogo").state == "open"
    before = calls["n"]
    # Open means the next call does not reach the network at all.
    with pytest.raises((CircuitOpen, ComprasError)):
        client.get("/x", {}, client.catalogue_breaker)
    assert calls["n"] == before
    client.close()


def test_alternating_transport_error_and_5xx_still_opens_it() -> None:
    """The realistic degradation shape, and the one the old code could not see.

    With a 503 counting as a success, an endpoint alternating `ReadError` and
    503 never accumulated two *consecutive* failures, so the breaker stayed
    closed through an unbounded number of failed requests.
    """
    state = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        state["n"] += 1
        if state["n"] % 2:
            raise httpx.ReadError("reset by peer")
        return httpx.Response(503, json={})

    client = _client(handler)
    for _ in range(4):
        with contextlib.suppress(ComprasError, CircuitOpen):
            client.get("/x", {}, client.catalogue_breaker)
    assert get_breaker("compras-catalogo").state == "open"
    client.close()


def test_a_404_is_an_answer_and_never_a_failure() -> None:
    """No rows for this code is not the endpoint being broken."""
    client = _client(lambda r: httpx.Response(404, json={}))
    body = client.get("/x", {}, client.catalogue_breaker)
    assert body["resultado"] == []
    # And it is distinguishable from a genuine 200 with zero rows, which the
    # docstring promises and the first version could not deliver.
    assert body["notFound"] is True
    assert get_breaker("compras-catalogo").state == "closed"
    client.close()


def test_a_genuine_empty_200_is_not_marked_not_found() -> None:
    client = _client(
        lambda r: httpx.Response(
            200, json={"resultado": [], "totalRegistros": 0, "totalPaginas": 0}
        )
    )
    body = client.get("/x", {}, client.catalogue_breaker)
    assert body["resultado"] == []
    assert "notFound" not in body
    client.close()


def test_a_400_is_retried_because_it_is_transient_here() -> None:
    """Measured: PDM 4915 returned 400 once and 200 on three retries."""
    seen = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["n"] += 1
        if seen["n"] == 1:
            return httpx.Response(400, json={})
        return httpx.Response(
            200, json={"resultado": [{"ok": 1}], "totalRegistros": 1, "totalPaginas": 1}
        )

    client = _client(handler)
    body = client.get("/x", {}, client.catalogue_breaker)
    assert body["resultado"] == [{"ok": 1}]
    assert seen["n"] == 2
    client.close()


def test_a_429_widens_the_spacing_even_from_zero() -> None:
    """Multiplying is not widening when the interval is zero.

    `0 * 1.5` is `0`, so the first version of `_widen` could take 429s forever
    without ever slowing down. The fixture zeroes the spacing, which is also the
    worst case.
    """
    from licitaqui import compras

    assert compras.MIN_INTERVAL[0] == 0.0  # the fixture zeroed it
    client = _client(lambda r: httpx.Response(429, json={}))
    with pytest.raises((ComprasError, CircuitOpen)):
        client.get("/x", {}, client.catalogue_breaker)
    assert compras.MIN_INTERVAL[0] > 0.0
    client.close()


# ------------------------------------------------------ the vocabulary walk


def _page(rows: list[dict], total: int, pages: int) -> httpx.Response:
    return httpx.Response(
        200, json={"resultado": rows, "totalRegistros": total, "totalPaginas": pages}
    )


def test_walk_raises_on_an_empty_vocabulary() -> None:
    """`CLAUDE.md`: an empty result is a broken run, not a finding of zero."""
    client = _client(lambda r: _page([], 0, 0))
    with pytest.raises(ComprasError, match="empty walk"):
        client.walk_catalogue("pdm")
    client.close()


def test_walk_raises_when_it_collected_fewer_rows_than_the_api_reported() -> None:
    """A short walk would silently shrink the vocabulary.

    Which would turn mapped items into unmapped ones with no record of why —
    so it must fail loudly instead.
    """
    client = _client(lambda r: _page([{"codigoPdm": 1}], 9, 1))
    with pytest.raises(ComprasError, match="walked 1 rows, API reported 9"):
        client.walk_catalogue("pdm")
    client.close()


def test_walk_follows_every_page() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        page = int(request.url.params["pagina"])
        return _page([{"codigoPdm": page}], 3, 3)

    client = _client(handler)
    rows = client.walk_catalogue("pdm")
    assert [r["codigoPdm"] for r in rows] == [1, 2, 3]
    client.close()


def test_the_walk_asks_for_the_largest_page_the_api_allows() -> None:
    """Latency is server-side, so the call count is the only lever (measured)."""
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.params["tamanhoPagina"])
        return _page([{"codigoPdm": 1}], 1, 1)

    client = _client(handler)
    client.walk_catalogue("pdm")
    assert seen == ["500"]
    client.close()
