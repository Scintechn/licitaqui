"""The PNCP client's paging, throttling and breaker behaviour.

No network: every test serves PNCP from an :class:`httpx.MockTransport`, which
is also how the recorded quirks stay tested — the 50-record page cap, the ``204``
that means "past the last page", the 10,000-record search window.
"""

from __future__ import annotations

import time
from datetime import date

import httpx
import pytest

from licitaqui import breaker as breaker_module
from licitaqui import pncp
from licitaqui.breaker import CircuitOpen, get_breaker
from licitaqui.pncp import PncpClient, PncpError, PncpGone, PncpNotFound, _Throttle

DAY = date(2026, 9, 17)


@pytest.fixture(autouse=True)
def _fresh_breakers():
    """Breakers are process-wide; a test must not inherit another's open circuit."""
    breaker_module.reset_all()
    yield
    breaker_module.reset_all()


def client(handler, **kwargs) -> PncpClient:
    """A client wired to a handler, with the pacing removed so tests are fast."""
    kwargs.setdefault("rate_limit", 0)
    kwargs.setdefault("page_delay", 0)
    return PncpClient(transport=httpx.MockTransport(handler), **kwargs)


def page(records: int, remaining: int, *, first: int = 0) -> dict:
    return {
        "data": [
            {
                "numeroControlePNCP": f"00000000000{i:03d}-1-{i:06d}/2026",
                "dataAtualizacaoGlobal": "2026-09-17T10:00:00",
            }
            for i in range(first, first + records)
        ],
        "totalRegistros": records,
        "paginasRestantes": remaining,
    }


# -- paging ----------------------------------------------------------------


def test_pages_until_pncp_says_no_pages_remain():
    """Three pages: `paginasRestantes` counts down to 0 on the last one."""
    seen = []
    remaining_by_page = {1: 2, 2: 1, 3: 0}

    def handler(request: httpx.Request) -> httpx.Response:
        current = int(request.url.params["pagina"])
        seen.append(current)
        return httpx.Response(
            200, json=page(50, remaining_by_page[current], first=(current - 1) * 50)
        )

    with client(handler) as c:
        records = list(c.iter_atualizacao(DAY, DAY, 6))

    assert seen == [1, 2, 3]
    assert len(records) == 150
    assert len({r["numeroControlePNCP"] for r in records}) == 150


def test_a_204_ends_the_walk():
    """PNCP answers 204 past the last page; it is a success, not a failure."""

    def handler(request: httpx.Request) -> httpx.Response:
        if int(request.url.params["pagina"]) == 1:
            return httpx.Response(200, json=page(50, 1))
        return httpx.Response(204)

    with client(handler) as c:
        records = list(c.iter_atualizacao(DAY, DAY, 6))

    assert len(records) == 50
    assert get_breaker(pncp.BREAKER_CONSULTA).state == "closed"


def test_page_size_is_pinned_to_fifty():
    """The period endpoints reject every other value with "Tamanho de página inválido"."""
    sizes = set()

    def handler(request: httpx.Request) -> httpx.Response:
        sizes.add(request.url.params["tamanhoPagina"])
        return httpx.Response(200, json=page(3, 0))

    with client(handler) as c:
        list(c.iter_atualizacao(DAY, DAY, 6))

    assert sizes == {"50"}


def test_the_window_and_modality_reach_pncp_as_sent():
    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(dict(request.url.params))
        return httpx.Response(200, json=page(1, 0))

    with client(handler) as c:
        list(c.iter_atualizacao(date(2026, 9, 15), date(2026, 9, 17), 8, uf="SP"))

    assert captured["dataInicial"] == "20260915"
    assert captured["dataFinal"] == "20260917"
    assert captured["codigoModalidadeContratacao"] == "8"
    assert captured["uf"] == "SP"


def test_no_uf_parameter_is_sent_for_a_national_sweep():
    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(dict(request.url.params))
        return httpx.Response(200, json=page(1, 0))

    with client(handler) as c:
        list(c.iter_atualizacao(DAY, DAY, 6))

    assert "uf" not in captured


def test_publicacao_uses_its_own_path():
    paths = []

    def handler(request: httpx.Request) -> httpx.Response:
        paths.append(request.url.path)
        return httpx.Response(200, json=page(1, 0))

    with client(handler) as c:
        list(c.iter_publicacao(DAY, DAY, 6))

    assert paths == [pncp.PUBLICACAO_PATH]


# -- failure, and the breaker ---------------------------------------------


def test_a_500_raises_rather_than_retrying():
    """§7.2 forbids retry storms: the queue owns the 2/8/30-minute backoff."""
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(500, text="Erro na comunicação com o banco de dados.")

    with client(handler) as c, pytest.raises(PncpError):
        list(c.iter_atualizacao(DAY, DAY, 6))

    assert len(calls) == 1


def test_two_consecutive_failures_open_the_circuit_and_the_third_call_never_leaves():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(503)

    with client(handler) as c:
        for _ in range(2):
            with pytest.raises(PncpError):
                list(c.iter_atualizacao(DAY, DAY, 6))
        assert get_breaker(pncp.BREAKER_CONSULTA).state == "open"

        with pytest.raises(CircuitOpen):
            list(c.iter_atualizacao(DAY, DAY, 6))

    # Two requests reached PNCP; the third was refused locally.
    assert len(calls) == 2


def test_a_read_timeout_becomes_a_PncpError_and_trips_the_breaker():
    """PNCP's characteristic failure is a timeout, not an HTTP status.

    Every failure behind ADR-0001 and every one during the 2026-09-18 outage
    was a read timeout. If those escaped as `httpx.ReadTimeout`, the sweep's
    `except PncpError` would not see them and the fallback would never fire.
    """

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    with client(handler) as c:
        for _ in range(2):
            with pytest.raises(PncpError, match="ReadTimeout"):
                list(c.iter_atualizacao(DAY, DAY, 6))
        assert get_breaker(pncp.BREAKER_CONSULTA).state == "open"


def test_a_connection_error_becomes_a_PncpError_too():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection reset by peer", request=request)

    with client(handler) as c, pytest.raises(PncpError, match="ConnectError"):
        list(c.iter_search(uf="SP"))


def test_a_4xx_raises_but_leaves_the_circuit_closed():
    """A bad parameter is our bug. It must not stop us calling a healthy service."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text="Tamanho de página inválido")

    with client(handler) as c:
        for _ in range(3):
            with pytest.raises(PncpError):
                list(c.iter_atualizacao(DAY, DAY, 6))
        assert get_breaker(pncp.BREAKER_CONSULTA).state == "closed"


def test_the_two_services_have_independent_circuits():
    """The consulta outage that motivated the fallback left search untouched."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == pncp.SEARCH_PATH:
            return httpx.Response(200, json={"items": [], "total": 0})
        return httpx.Response(500)

    with client(handler) as c:
        for _ in range(2):
            with pytest.raises(PncpError):
                list(c.iter_atualizacao(DAY, DAY, 6))
        assert get_breaker(pncp.BREAKER_CONSULTA).state == "open"
        assert get_breaker(pncp.BREAKER_SEARCH).state == "closed"
        assert list(c.iter_search(uf="SP")) == []


# -- the search sweep (the fallback) --------------------------------------


def search_page(items: int, stamp: str) -> dict:
    return {
        "items": [
            {
                "numero_controle_pncp": f"00000000000{i:03d}-1-{i:06d}/2026",
                "data_atualizacao_pncp": stamp,
                "description": "objeto",
            }
            for i in range(items)
        ],
        "total": items,
    }


def test_search_stops_at_the_watermark():
    """`ordenacao=-data` is update-descending, so the first old record ends it."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "items": [
                    {"numero_controle_pncp": "1-1-1/2026", "data_atualizacao_pncp": "2026-09-17"},
                    {"numero_controle_pncp": "2-1-2/2026", "data_atualizacao_pncp": "2026-09-16"},
                    {"numero_controle_pncp": "3-1-3/2026", "data_atualizacao_pncp": "2026-09-10"},
                ],
                "total": 3,
            },
        )

    with client(handler) as c:
        found = list(c.iter_search(stop_at="2026-09-16"))

    assert [i["numero_controle_pncp"] for i in found] == ["1-1-1/2026"]


def test_an_item_with_no_timestamp_does_not_truncate_the_sweep():
    """Comparing a missing value as "" would end the walk at that record."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "items": [
                    {"numero_controle_pncp": "1-1-1/2026", "data_atualizacao_pncp": "2026-09-17"},
                    {"numero_controle_pncp": "2-1-2/2026"},  # no timestamp at all
                    {"numero_controle_pncp": "3-1-3/2026", "data_atualizacao_pncp": "2026-09-17"},
                ],
                "total": 3,
            },
        )

    with client(handler) as c:
        found = list(c.iter_search(stop_at="2026-09-16"))

    assert [i["numero_controle_pncp"] for i in found] == [
        "1-1-1/2026",
        "2-1-2/2026",
        "3-1-3/2026",
    ]


def test_search_refuses_to_page_past_pncps_ten_thousand_record_window():
    """`pagina × tam_pagina > 10_000` is HTTP 400: stop before asking."""
    pages = []

    def handler(request: httpx.Request) -> httpx.Response:
        pages.append(int(request.url.params["pagina"]))
        return httpx.Response(200, json=search_page(500, "2026-09-17"))

    with client(handler) as c:
        list(c.iter_search(uf="SP"))

    assert pages == list(range(1, 21))  # 20 × 500 = 10,000, and no page 21


def test_search_sends_the_filters_the_poc_used():
    captured: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured.update(dict(request.url.params))
        return httpx.Response(200, json={"items": [], "total": 0})

    with client(handler) as c:
        list(c.iter_search(uf="SP", modalities=(6, 8)))

    assert captured["tipos_documento"] == "edital"
    assert captured["status"] == "recebendo_proposta"
    assert captured["ordenacao"] == "-data"
    assert captured["ufs"] == "SP"
    assert captured["modalidades"] == "6|8"


# -- pacing ----------------------------------------------------------------


def test_the_throttle_spaces_requests_out():
    """§7.2: throttle PNCP calls. Four per second means 250 ms apart."""
    throttle = _Throttle(rate=20.0)  # 50 ms, so the test stays quick
    started = time.monotonic()
    for _ in range(4):
        throttle.wait()
    elapsed = time.monotonic() - started

    assert elapsed >= 0.15  # three gaps of 50 ms; the first call is free


def test_a_zero_rate_disables_the_throttle():
    throttle = _Throttle(rate=0)
    started = time.monotonic()
    for _ in range(50):
        throttle.wait()
    assert time.monotonic() - started < 0.05


def test_the_default_rate_is_the_specs_four_per_second():
    assert pncp.DEFAULT_RATE_LIMIT == 4.0


# -- the items endpoint (B3) ----------------------------------------------
#
# A bare JSON array, not the `{data, paginasRestantes}` envelope the period
# endpoints use, and a breaker of its own so an items outage cannot stop the
# sweep that feeds every other job.


def items_page(count: int, *, first: int = 1) -> list[dict]:
    return [
        {"numeroItem": n, "descricao": f"Item {n}", "materialOuServico": "M"}
        for n in range(first, first + count)
    ]


def test_items_are_read_from_a_bare_array():
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/pncp/v1/orgaos/12345678000199/compras/2026/7/itens"
        assert request.url.params["tamanhoPagina"] == str(pncp.ITEMS_PAGE_SIZE)
        return httpx.Response(200, json=items_page(3))

    got = list(client(handler).iter_items("12345678000199", 2026, 7))

    assert [i["numeroItem"] for i in got] == [1, 2, 3]


def test_items_page_until_a_short_page_arrives():
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        page_number = int(request.url.params["pagina"])
        seen.append(page_number)
        size = pncp.ITEMS_PAGE_SIZE
        if page_number == 1:
            return httpx.Response(200, json=items_page(size))
        return httpx.Response(200, json=items_page(2, first=size + 1))

    got = list(client(handler).iter_items("12345678000199", 2026, 7))

    assert seen == [1, 2]
    assert len(got) == pncp.ITEMS_PAGE_SIZE + 2


def test_an_empty_items_response_ends_the_walk():
    got = list(client(lambda r: httpx.Response(204)).iter_items("12345678000199", 2026, 7))
    assert got == []


def test_a_failing_items_endpoint_raises_rather_than_returning_nothing():
    """An outage must never look like "this tender has no items"."""
    with pytest.raises(PncpError):
        list(client(lambda r: httpx.Response(404)).iter_items("12345678000199", 2026, 7))


def test_the_items_breaker_is_not_the_consulta_one():
    """POC 1 kept them apart: the detail endpoint is the one that returns 500."""
    instance = client(lambda r: httpx.Response(503))
    for _ in range(2):
        with pytest.raises(PncpError):
            list(instance.iter_items("12345678000199", 2026, 7))

    assert get_breaker(pncp.BREAKER_ITEMS).state == "open"
    assert get_breaker(pncp.BREAKER_CONSULTA).state == "closed"
    with pytest.raises(CircuitOpen):
        list(instance.iter_items("12345678000199", 2026, 7))


# -- what a status the service *answered* with may do to the breaker -------
#
# The rule: the breaker measures whether PNCP is up. Only a transport failure
# or a 5xx counts. Everything else — a 4xx, a 410, a 301 — is an answer, and an
# answer means the service is up however unusable the answer is.
#
# It used to record a success and then raise *inside* the guard, so the guard's
# own `except` counted the 4xx as a failure anyway. Among 4xx alone that was
# invisible (the success reset the counter first, so it never reached two), and
# `test_a_4xx_raises_but_leaves_the_circuit_closed` passed throughout. It was
# not invisible in production: on 2026-09-21 jobs 2286 and 2287 ended
# `CircuitOpen` on `pncp-itens` and `pncp-arquivos` after 404s on a withdrawn
# tender, because a 404 left the endpoint one failure short of open and the
# next genuine timeout finished the job — for every tender, not just that one.


def test_a_404_is_its_own_exception_type():
    """So `sync_items`/`sync_files` can tell it from an outage (see
    :mod:`licitaqui.absence`), while `except PncpError` still catches it."""
    with pytest.raises(PncpNotFound) as raised:
        list(
            client(lambda r: httpx.Response(404, text="Compra não encontrada.")).iter_items(
                "12345678000199", 2026, 7
            )
        )

    assert isinstance(raised.value, PncpError)
    assert raised.value.status_code == 404


def test_a_404_leaves_no_failure_behind_on_the_breaker():
    """The regression test for the production bug: a single 404 followed by one
    genuine failure must leave the circuit closed, because one genuine failure
    is not two."""
    answers = iter([404, 503])

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(next(answers))

    instance = client(handler)
    for _ in range(2):
        with pytest.raises(PncpError):
            list(instance.iter_items("12345678000199", 2026, 7))

    assert get_breaker(pncp.BREAKER_ITEMS).state == "closed"


def test_a_404_does_not_stop_the_next_tender_from_being_read():
    """The blast radius that made this worth fixing: one withdrawn tender must
    not take the endpoint down for every other tender."""
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if "/compras/2026/7/" in request.url.path:
            return httpx.Response(404)
        return httpx.Response(200, json=items_page(2))

    instance = client(handler)
    for _ in range(3):
        with pytest.raises(PncpNotFound):
            list(instance.iter_items("12345678000199", 2026, 7))

    assert len(list(instance.iter_items("12345678000199", 2026, 8))) == 2
    assert get_breaker(pncp.BREAKER_ITEMS).state == "closed"


def test_a_5xx_is_still_a_failure_for_the_breaker():
    """The control: the fix must not disarm the breaker for a real outage."""
    instance = client(lambda r: httpx.Response(500))
    for _ in range(2):
        with pytest.raises(PncpError):
            list(instance.iter_items("12345678000199", 2026, 7))

    assert get_breaker(pncp.BREAKER_ITEMS).state == "open"


def test_a_timeout_is_still_a_failure_for_the_breaker():
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    instance = client(handler)
    for _ in range(2):
        with pytest.raises(PncpError):
            list(instance.iter_items("12345678000199", 2026, 7))

    assert get_breaker(pncp.BREAKER_ITEMS).state == "open"


# -- "is this contratação still on PNCP?" ---------------------------------


def contratacao(status: int, **kwargs):
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/consulta/v1/orgaos/12345678000199/compras/2026/7"
        if status == 200:
            return httpx.Response(200, json={"numeroControlePNCP": "…"})
        return httpx.Response(status, text="…")

    return client(handler, **kwargs)


def test_consulta_answers_410_for_a_contratacao_the_agency_excluded():
    """Measured 2026-09-22 against the three tenders whose jobs were stuck:
    `410 GONE — "A contratação informada foi excluída e não pode ser consultada."`"""
    assert contratacao(410).contratacao_state("12345678000199", 2026, 7) == pncp.CONTRATACAO_GONE


def test_consulta_answers_200_for_a_contratacao_that_is_still_published():
    assert contratacao(200).contratacao_state("12345678000199", 2026, 7) == pncp.CONTRATACAO_PRESENT


def test_a_consulta_that_cannot_be_asked_says_unknown_rather_than_guessing():
    assert contratacao(500).contratacao_state("12345678000199", 2026, 7) == pncp.CONTRATACAO_UNKNOWN


def test_an_open_consulta_circuit_says_unknown_without_a_request():
    """ADR-0001 §4 puts the whole Consulta service behind one breaker. When it
    is open this question is simply unanswerable, and must not pretend."""
    get_breaker(pncp.BREAKER_CONSULTA).record_failure()
    get_breaker(pncp.BREAKER_CONSULTA).record_failure()
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        return httpx.Response(200, json={})

    state = client(handler).contratacao_state("12345678000199", 2026, 7)

    assert state == pncp.CONTRATACAO_UNKNOWN
    assert calls == []


def test_neither_a_410_nor_a_404_can_open_the_consulta_circuit():
    """Which is what makes the diagnostic affordable: it can never be the thing
    that opens the circuit ADR-0001's sweep depends on."""
    for status in (410, 404):
        breaker_module.reset_all()
        instance = contratacao(status)
        for _ in range(4):
            instance.contratacao_state("12345678000199", 2026, 7)
        assert get_breaker(pncp.BREAKER_CONSULTA).state == "closed"


def test_a_410_is_its_own_exception_type():
    with pytest.raises(PncpGone) as raised:
        client(lambda r: httpx.Response(410, text="foi excluída")).fetch_files(
            "12345678000199", 2026, 7
        )

    assert raised.value.status_code == 410
