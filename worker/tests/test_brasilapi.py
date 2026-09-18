"""BrasilAPI client: parsing, the ADR-0002 gotchas, and sanitised errors.

Nothing here touches the network. The transport is an ``httpx.MockTransport``
and the payloads are fixtures captured from real responses with the identifiers
replaced; the live check is ``worker/scripts/check_company_lookup_live.py``.
"""

from __future__ import annotations

import dataclasses
import json
import logging
import time
from pathlib import Path

import httpx
import pytest

from licitaqui import brasilapi
from licitaqui.brasilapi import BrasilApiError

FIXTURES = Path(__file__).parent / "fixtures" / "brasilapi"
#: A real CNPJ is never committed; this one has valid check digits and is ours.
CNPJ = "99900001000150"


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


def client_returning(handler) -> httpx.Client:
    """A client whose transport runs ``handler`` instead of reaching the network."""
    return httpx.Client(transport=httpx.MockTransport(handler))


def client_answering(status: int, **response) -> httpx.Client:
    """A client that always answers with this one response."""
    return client_returning(lambda request: httpx.Response(status, **response))


# -- normalisation and check digits ---------------------------------------


@pytest.mark.parametrize("raw", ["99.900.001/0001-50", "99900001000150", " 99 900 001 0001 50 "])
def test_punctuation_is_stripped(raw):
    assert brasilapi.normalise_cnpj(raw) == CNPJ


@pytest.mark.parametrize("raw", ["", "123", "999000010001501"])
def test_anything_that_is_not_14_digits_is_a_programming_error(raw):
    with pytest.raises(ValueError, match="14 digits"):
        brasilapi.normalise_cnpj(raw)


def test_check_digits_separate_a_typo_from_a_real_cnpj():
    assert brasilapi.has_valid_check_digits(CNPJ)
    assert not brasilapi.has_valid_check_digits("99900001000151")
    # Repdigits pass mod-11 arithmetic but are not CNPJs.
    assert not brasilapi.has_valid_check_digits("00000000000000")


# -- the ADR-0002 gotchas, verified against captured payloads --------------


def test_size_comes_from_codigo_porte_because_descricao_porte_is_always_null():
    for name, expected in (
        ("micro_mei", "ME"),
        ("epp_baixada", "EPP"),
        ("demais_null_flags", "DEMAIS"),
    ):
        payload = fixture(name)
        assert payload["descricao_porte"] is None, "the ADR says this field is always null"
        assert brasilapi.parse(CNPJ, payload).size == expected


def test_an_unknown_porte_code_is_unknown_rather_than_guessed():
    assert brasilapi.company_size({"codigo_porte": 0}) is None
    assert brasilapi.company_size({"codigo_porte": None}) is None
    assert brasilapi.company_size({"codigo_porte": "01"}) == "ME"


def test_a_null_mei_flag_stays_unknown_and_never_becomes_false():
    unknown = brasilapi.parse(CNPJ, fixture("demais_null_flags"))
    assert unknown.is_mei is None
    assert unknown.is_simples is None

    mei = brasilapi.parse(CNPJ, fixture("micro_mei"))
    assert mei.is_mei is True

    not_mei = brasilapi.parse(CNPJ, fixture("epp_baixada"))
    assert not_mei.is_mei is False, "an explicit false is a different fact from null"


def test_tri_state_keeps_three_states():
    assert brasilapi.tri_state(None) is None
    assert brasilapi.tri_state(True) is True
    assert brasilapi.tri_state(False) is False
    assert brasilapi.tri_state("SIM") is True
    assert brasilapi.tri_state("nao") is False


def test_secondary_cnaes_may_be_empty_and_may_be_long():
    assert brasilapi.parse(CNPJ, fixture("demais_null_flags")).secondary_cnaes == ()

    payload = fixture("micro_mei")
    payload["cnaes_secundarios"] = [{"codigo": 1000000 + i, "descricao": "x"} for i in range(70)]
    assert len(brasilapi.parse(CNPJ, payload).secondary_cnaes) == 70


def test_secondary_cnaes_drop_duplicates_and_the_primary():
    record = brasilapi.parse(CNPJ, fixture("micro_mei"))
    assert record.main_cnae == "8219999"
    assert record.secondary_cnaes == ("1732000", "4761003")


def test_a_cnae_shorter_than_seven_digits_is_zero_padded():
    # BrasilAPI sends the code as an integer, so CNAE 0111-3/01 arrives as
    # 111301. B6's segment map joins on the 7-digit form.
    payload = fixture("epp_baixada") | {"cnae_fiscal": 111301}
    assert brasilapi.parse(CNPJ, payload).main_cnae == "0111301"


def test_a_closed_registration_is_carried_through_not_swallowed():
    assert brasilapi.parse(CNPJ, fixture("epp_baixada")).registration_status == "BAIXADA"


def test_a_payload_without_a_primary_cnae_is_a_failed_lookup():
    payload = fixture("micro_mei") | {"cnae_fiscal": None}
    with pytest.raises(BrasilApiError, match="cnae_fiscal"):
        brasilapi.parse(CNPJ, payload)


def test_only_the_fields_companies_has_columns_for_are_kept():
    payload = fixture("micro_mei")
    assert payload["qsa"] and payload["logradouro"] and payload["email"]
    stored = repr(dataclasses.astuple(brasilapi.parse(CNPJ, payload)))
    for personal in ("SOCIO FIXTURE", "RUA FIXTURE", "fixture@example.invalid", "80000000"):
        assert personal not in stored


# -- one request, sanitised errors ----------------------------------------


def test_a_successful_lookup_returns_a_record():
    payload = fixture("micro_mei")
    with client_answering(200, json=payload) as client:
        record = brasilapi.lookup(CNPJ, client=client)
    assert record.main_cnae == "8219999"
    assert record.legal_name == "EMPRESA FIXTURE MICRO MEI LTDA"


@pytest.mark.parametrize(
    ("status", "reason", "not_found"),
    [
        (404, "not_found", True),
        (429, "rate_limited", False),
        (500, "unexpected_status", False),
        (503, "unexpected_status", False),
    ],
)
def test_http_statuses_map_to_reason_codes(status, reason, not_found):
    body = {"message": f"CNPJ {CNPJ} nao encontrado"}
    with client_answering(status, json=body) as client, pytest.raises(BrasilApiError) as caught:
        brasilapi.fetch(CNPJ, client=client)
    assert caught.value.reason == reason
    assert caught.value.not_found is not_found


def test_the_error_never_quotes_the_cnpj_back():
    """BrasilAPI's 404 body and every httpx exception carry the CNPJ (§12)."""
    body = {"message": f"CNPJ {CNPJ} nao encontrado"}
    with client_answering(404, json=body) as client, pytest.raises(BrasilApiError) as caught:
        brasilapi.fetch(CNPJ, client=client)
    assert CNPJ not in str(caught.value)
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None


def test_a_timeout_is_a_timeout_and_carries_no_url():
    def handler(request):
        raise httpx.ConnectTimeout("timed out", request=request)

    with client_returning(handler) as client, pytest.raises(BrasilApiError) as caught:
        brasilapi.fetch(CNPJ, client=client)
    assert caught.value.reason == "timeout"
    assert "brasilapi.com.br" not in str(caught.value)


def test_a_transport_error_keeps_only_the_exception_class():
    def handler(request):
        raise httpx.ConnectError("connection refused", request=request)

    with client_returning(handler) as client, pytest.raises(BrasilApiError) as caught:
        brasilapi.fetch(CNPJ, client=client)
    assert caught.value.reason == "transport_error:ConnectError"
    assert CNPJ not in str(caught.value)


def test_a_200_that_is_not_json_is_a_failed_lookup():
    with (
        client_answering(200, text="<html>") as client,
        pytest.raises(BrasilApiError, match="invalid_json"),
    ):
        brasilapi.fetch(CNPJ, client=client)


def test_a_200_that_is_a_list_is_a_failed_lookup():
    with (
        client_answering(200, json=[]) as client,
        pytest.raises(BrasilApiError, match="unexpected"),
    ):
        brasilapi.fetch(CNPJ, client=client)


def test_httpx_cannot_log_the_url_even_at_debug_level(caplog):
    """httpx logs 'HTTP Request: GET <url>' at INFO, and the URL is the CNPJ."""
    payload = fixture("micro_mei")
    with caplog.at_level(logging.DEBUG), client_answering(200, json=payload) as client:
        brasilapi.fetch(CNPJ, client=client)
    assert logging.getLogger("httpx").level >= logging.WARNING
    assert CNPJ not in caplog.text


def test_lookups_are_spaced_so_we_are_a_good_citizen(monkeypatch):
    """The uncached rate limit is unmeasured (ADR-0002), so calls are spaced."""
    monkeypatch.setattr(brasilapi, "MIN_INTERVAL_SECONDS", 0.05)
    monkeypatch.setattr(brasilapi, "_last_call_at", 0.0)
    payload = fixture("micro_mei")
    with client_answering(200, json=payload) as client:
        started = time.monotonic()
        for _ in range(3):
            brasilapi.fetch(CNPJ, client=client)
        elapsed = time.monotonic() - started
    assert elapsed >= 0.10, "three lookups must span at least two gaps"
