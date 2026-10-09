"""CNPJá open client: parsing into the BrasilAPI record shape, and sanitised errors.

Nothing here touches the network. ``me_not_simei.json`` is a real response
captured on 2026-10-09 with every identifier replaced (CNPJ, names, address,
phones, e-mails, partners); the activity codes, porte and Simples/SIMEI history
are the real ones, because those are what the parser is for.
"""

from __future__ import annotations

import copy
import json
import logging
from pathlib import Path

import httpx
import pytest

from licitaqui import cnpja
from licitaqui.cnpja import CnpjaError

FIXTURES = Path(__file__).parent / "fixtures" / "cnpja"
CNPJ = "99900001000150"


def fixture(name: str = "me_not_simei") -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def client_answering(status: int, **response) -> httpx.Client:
    return httpx.Client(
        transport=httpx.MockTransport(lambda request: httpx.Response(status, **response))
    )


@pytest.fixture(autouse=True)
def no_spacing(monkeypatch):
    """The 12 s politeness gap is real in production and pointless here."""
    monkeypatch.setattr(cnpja, "MIN_INTERVAL_SECONDS", 0.0)


# -- parsing --------------------------------------------------------------


def test_a_payload_becomes_the_same_record_brasilapi_would_have_written():
    record = cnpja.parse(CNPJ, fixture())

    assert record.cnpj == CNPJ
    assert record.legal_name == "EMPRESA EXEMPLO LTDA"
    assert record.trade_name == "FANTASIA EXEMPLO"
    assert record.main_cnae == "5819100"
    assert record.secondary_cnaes == (
        "4752100",
        "9511800",
        "4751201",
        "9512600",
        "4753900",
        "4789007",
    )
    assert record.size == "ME"
    assert record.state == "GO"


def test_status_and_city_are_upper_cased_to_match_brasilapis_rows():
    """``companies`` already holds ``ATIVA``; a second spelling would split every comparison."""
    record = cnpja.parse(CNPJ, fixture())

    assert record.registration_status == "ATIVA"
    assert record.city == "PLANALTINA"


def test_an_explicit_optant_false_is_a_fact():
    """The fixture's company left SIMEI and Simples; that is ``False``, not unknown."""
    record = cnpja.parse(CNPJ, fixture())

    assert record.is_mei is False
    assert record.is_simples is False


def test_a_current_mei_reads_true():
    payload = fixture()
    payload["company"]["simei"] = {"optant": True, "since": "2020-01-01", "history": []}

    assert cnpja.parse(CNPJ, payload).is_mei is True


@pytest.mark.parametrize("entry", [None, {}, {"optant": None}, "yes"])
def test_no_registry_entry_is_unknown_never_false(entry):
    """ADR-0002's warning, carried over: telling a MEI "not a MEI" on a missing record."""
    payload = fixture()
    payload["company"]["simei"] = entry

    assert cnpja.parse(CNPJ, payload).is_mei is None


def test_the_main_cnae_is_not_repeated_among_the_secondaries():
    payload = fixture()
    payload["sideActivities"].append({"id": 5819100, "text": "same as main"})
    payload["sideActivities"].append(copy.deepcopy(payload["sideActivities"][0]))

    record = cnpja.parse(CNPJ, payload)

    assert "5819100" not in record.secondary_cnaes
    assert len(record.secondary_cnaes) == len(set(record.secondary_cnaes)) == 6


@pytest.mark.parametrize(
    "size_id, expected", [(1, "ME"), (3, "EPP"), (5, "DEMAIS"), (0, None), ("1", None)]
)
def test_porte_uses_the_receita_code(size_id, expected):
    payload = fixture()
    payload["company"]["size"]["id"] = size_id

    assert cnpja.parse(CNPJ, payload).size == expected


@pytest.mark.parametrize("main", [None, {}, {"id": None}, {"id": 0}])
def test_a_payload_without_a_main_cnae_is_a_failed_lookup(main):
    payload = fixture()
    payload["mainActivity"] = main

    with pytest.raises(CnpjaError, match="mainActivity"):
        cnpja.parse(CNPJ, payload)


def test_only_the_columns_we_store_are_read():
    """The partners, phones, e-mails and street never reach the record (§12)."""
    rendered = repr(cnpja.parse(CNPJ, fixture()))

    for leaked in ("SOCIO EXEMPLO", "example.com", "RUA EXEMPLO", "00000000", "70000000"):
        assert leaked not in rendered


# -- transport ------------------------------------------------------------


def test_a_200_is_parsed():
    record = cnpja.lookup(CNPJ, client=client_answering(200, json=fixture()))

    assert record.main_cnae == "5819100"


def test_a_404_is_flagged_as_not_found():
    with pytest.raises(CnpjaError) as caught:
        cnpja.fetch(CNPJ, client=client_answering(404, json={"message": f"{CNPJ} not found"}))

    assert caught.value.not_found
    assert CNPJ not in str(caught.value)


@pytest.mark.parametrize(
    "status, reason",
    [(429, "rate_limited"), (500, "unexpected_status"), (503, "unexpected_status")],
)
def test_other_statuses_are_failures_not_not_found(status, reason):
    with pytest.raises(CnpjaError) as caught:
        cnpja.fetch(CNPJ, client=client_answering(status, text="oops"))

    assert caught.value.reason == reason
    assert not caught.value.not_found


def test_a_body_that_is_not_json_is_a_failure():
    with pytest.raises(CnpjaError) as caught:
        cnpja.fetch(CNPJ, client=client_answering(200, text="<html>"))

    assert caught.value.reason == "invalid_json"


def test_a_transport_error_never_carries_the_url(caplog):
    def boom(request):
        raise httpx.ConnectError(f"cannot reach {request.url}")

    caplog.set_level(logging.DEBUG)
    with pytest.raises(CnpjaError) as caught:
        cnpja.fetch(CNPJ, client=httpx.Client(transport=httpx.MockTransport(boom)))

    assert caught.value.reason == "transport_error:ConnectError"
    assert caught.value.__cause__ is None
    assert caught.value.__suppress_context__
    assert CNPJ not in str(caught.value)
    assert CNPJ not in caplog.text
