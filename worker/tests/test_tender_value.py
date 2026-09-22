"""The value precedence, and the two client changes it rests on. No database.

The bug these pin down, from production on 2026-09-22: the Radar showed
"Valor não informado" on 5,080 of 5,965 tenders while `pncp.gov.br` showed the
number. Every one of the 5,080 had been ingested by ADR-0001's search fallback,
which publishes no `valorTotalEstimado` — and nothing ever went back for it.

Nothing here reaches PNCP; the detail endpoint is served from memory by an
`httpx.MockTransport`.
"""

from __future__ import annotations

from decimal import Decimal

import httpx
import pytest

from licitaqui import breaker as breaker_module
from licitaqui.items import EPP_REVENUE_CAP, favored_treatment, pick_total, total_estimated_value
from licitaqui.pncp import (
    CONTRATACAO_GONE,
    CONTRATACAO_PATH,
    CONTRATACAO_PRESENT,
    CONTRATACAO_UNKNOWN,
    MOVED_CONTRATACAO_PREFIX,
    PncpClient,
    PncpError,
    PncpGone,
    PncpNotFound,
)
from licitaqui.tender_value import _agreement
from licitaqui.tenders import UPSERT_SQL, from_consulta, from_search


@pytest.fixture(autouse=True)
def _fresh_breakers():
    breaker_module.reset_all()
    yield
    breaker_module.reset_all()


# -- the precedence rule ---------------------------------------------------


class TestPickTotal:
    """Which of the two figures becomes the tender's value."""

    def test_the_consulta_header_wins_whenever_it_is_positive(self):
        # Sci's rule: show what the portal shows. The item sum is never
        # preferred to PNCP's own number, even when it is larger — production
        # has 41 tenders where the item sum over-counts.
        assert pick_total(Decimal("271350.31"), Decimal("999999.99")) == Decimal("271350.31")

    def test_the_item_sum_is_used_when_there_is_no_header(self):
        assert pick_total(None, Decimal("271350.31")) == Decimal("271350.31")

    def test_a_zero_header_is_not_a_value_and_falls_through_to_the_items(self):
        # 108 production rows hold exactly 0.00 because PNCP published
        # `valorTotalEstimado: 0`. A card reading "R$ 0,00" looks like a free
        # contract, which is worse than admitting we do not know.
        assert pick_total(Decimal("0.00"), Decimal("42000.00")) == Decimal("42000.00")

    def test_a_zero_item_sum_is_not_a_value_either(self):
        # Every sigiloso item reports 0, so a confidential budget sums to zero.
        assert pick_total(None, Decimal("0")) is None

    def test_neither_source_leaves_the_tender_unvalued(self):
        assert pick_total(None, None) is None

    def test_a_negative_figure_is_never_a_value(self):
        assert pick_total(Decimal("-1"), Decimal("-5")) is None

    def test_total_estimated_value_still_agrees_with_it(self):
        # The item-row form and the pre-summed form must not diverge: the card's
        # value and `favored_treatment` are derived from the two of them.
        class _Item:
            def __init__(self, total):
                self.total_value = total

        items = [_Item(Decimal("100.01")), _Item(Decimal("50.00"))]
        assert total_estimated_value(None, items) == pick_total(None, Decimal("150.01"))

    def test_the_value_and_the_me_epp_claim_come_from_one_number(self):
        # A tender valued from the items must get the ME/EPP verdict that
        # number implies, not one derived from a different sum.
        class _Item:
            def __init__(self, total):
                self.total_value = total

        items = [_Item(EPP_REVENUE_CAP + Decimal("1"))]
        assert favored_treatment(None, items) is False
        assert pick_total(None, EPP_REVENUE_CAP + Decimal("1")) > EPP_REVENUE_CAP


class TestAgreement:
    """How the consulta-vs-item-sum rate is counted."""

    def test_a_cent_apart_is_a_disagreement(self):
        assert _agreement(Decimal("100.00"), Decimal("100.01")) is False

    def test_sub_cent_rounding_across_many_items_is_not(self):
        # 14 of the 51 production mismatches differ by under five hundredths of
        # a cent: `numeric(16,2)` rounding over a few hundred rows, not a
        # disagreement about the number.
        assert _agreement(Decimal("100.000"), Decimal("100.004")) is True

    def test_not_comparable_is_none_and_never_counted_either_way(self):
        # "We could not compare" and "they disagree" are different findings and
        # the reported rate must not blur them.
        assert _agreement(None, Decimal("10")) is None
        assert _agreement(Decimal("10"), None) is None
        assert _agreement(Decimal("0"), Decimal("10")) is None


# -- what the search index cannot tell us ----------------------------------


class TestConfidentialBudgetIsUnknownNotFalse:
    def test_a_search_item_leaves_the_flag_unknown(self):
        # The index publishes no `orcamentoSigilosoCodigo`, so `False` would be
        # a claim nobody checked — about 5,080 tenders.
        tender = from_search(
            {
                "numero_controle_pncp": "87612826000190-1-000958/2026",
                "description": "Aquisição de materiais",
            }
        )
        assert tender.confidential_budget is None
        assert tender.estimated_value is None
        assert tender.price_registration is None

    def test_a_consulta_record_still_reads_the_code_not_its_truthiness(self):
        # 1 = "Compra sem sigilo". Reading it as a truthy int marks 83 of the
        # knowledge base's 95 cached tenders as confidential.
        base = {
            "numeroControlePNCP": "87612826000190-1-000958/2026",
            "objetoCompra": "x",
        }
        assert from_consulta(base | {"orcamentoSigilosoCodigo": 1}).confidential_budget is False
        assert from_consulta(base | {"orcamentoSigilosoCodigo": 3}).confidential_budget is True

    def test_the_upsert_coalesces_it_so_a_fallback_sweep_cannot_erase_it(self):
        # It did not, so a search sweep passing over a consulta-sourced tender
        # wrote `False` straight over a real `True`.
        assert (
            "confidential_budget = coalesce(excluded.confidential_budget, "
            "tenders.confidential_budget)" in UPSERT_SQL
        )


# -- the client: the body `contratacao_state` used to discard ---------------


def client_for(status: int, body: dict | None = None, *, path: str | None = None) -> PncpClient:
    """A client answering the contratação detail endpoint from memory."""
    wanted = path or CONTRATACAO_PATH.format(cnpj="87612826000190", year=2026, sequence=958)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path != wanted:
            return httpx.Response(404, text='{"message":"unmapped path in the test"}')
        if status == 200:
            return httpx.Response(200, json=body or {})
        if status == 204:
            return httpx.Response(204)
        return httpx.Response(status, text=f'{{"status":"{status}"}}')

    return PncpClient(transport=httpx.MockTransport(handler), rate_limit=0.0, page_delay=0.0)


DETAIL = {
    "numeroControlePNCP": "87612826000190-1-000958/2026",
    "objetoCompra": "Registro de preços para aquisição de material de consumo",
    "valorTotalEstimado": 271350.31,
    "srp": True,
    "orcamentoSigilosoCodigo": 1,
    "situacaoCompraNome": "Divulgada no PNCP",
    "dataAtualizacaoGlobal": "2026-09-20T04:11:02",
}


class TestFetchContratacao:
    def test_it_returns_the_body_that_carries_the_value(self):
        with client_for(200, DETAIL) as client:
            record = client.fetch_contratacao("87612826000190", 2026, 958)
        assert record["valorTotalEstimado"] == 271350.31
        # And it maps onto exactly the columns the search path could not fill.
        tender = from_consulta(record)
        assert tender.estimated_value == 271350.31
        assert tender.price_registration is True
        assert tender.confidential_budget is False

    def test_a_withdrawn_contratacao_raises_gone(self):
        # 410 is PNCP's only unambiguous "never coming back"; a backfill that
        # retried every one of the 206 non-Divulgada rows would burn its budget.
        with client_for(410) as client, pytest.raises(PncpGone):
            client.fetch_contratacao("87612826000190", 2026, 958)

    def test_a_404_raises_not_found(self):
        with client_for(404) as client, pytest.raises(PncpNotFound):
            client.fetch_contratacao("87612826000190", 2026, 958)

    def test_a_204_is_no_record_rather_than_an_error(self):
        with client_for(204) as client:
            assert client.fetch_contratacao("87612826000190", 2026, 958) is None

    def test_a_list_body_is_refused_rather_than_mapped(self):
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(200, json=[{"numeroControlePNCP": "x"}])

        client = PncpClient(transport=httpx.MockTransport(handler), rate_limit=0.0)
        with client, pytest.raises(PncpError, match="expected an object"):
            client.fetch_contratacao("87612826000190", 2026, 958)

    def test_contratacao_state_still_answers_the_404_lane_correctly(self):
        # It is now implemented on fetch_contratacao; the three verdicts the
        # absence rule depends on must be unchanged.
        with client_for(200, DETAIL) as client:
            assert client.contratacao_state("87612826000190", 2026, 958) == CONTRATACAO_PRESENT
        with client_for(410) as client:
            assert client.contratacao_state("87612826000190", 2026, 958) == CONTRATACAO_GONE
        with client_for(500) as client:
            assert client.contratacao_state("87612826000190", 2026, 958) == CONTRATACAO_UNKNOWN

    def test_one_request_answers_both_questions(self):
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request.url.path)
            return httpx.Response(200, json=DETAIL)

        client = PncpClient(transport=httpx.MockTransport(handler), rate_limit=0.0)
        with client:
            client.fetch_contratacao("87612826000190", 2026, 958)
        assert len(calls) == 1


class TestTheMovedSpelling:
    """The `/api/pncp/v1/...` spelling of the detail endpoint."""

    def test_the_path_constant_uses_the_consulta_spelling(self):
        # Measured 2026-09-22: the old spelling answers 301. Pinned here so it
        # cannot creep back into the constant.
        assert CONTRATACAO_PATH.startswith("/api/consulta/v1/orgaos/")
        assert not CONTRATACAO_PATH.startswith(MOVED_CONTRATACAO_PREFIX)

    def test_a_301_is_a_legible_error_because_it_cannot_be_followed(self):
        # PNCP sends the 301 with **no Location header**, so `follow_redirects`
        # is powerless and httpx hands the 301 straight back. Without the hint
        # the caller sees a bare "HTTP 301" and has to re-measure why.
        with client_for(301) as client, pytest.raises(PncpError) as caught:
            client.fetch_contratacao("87612826000190", 2026, 958)
        message = str(caught.value)
        assert "301" in message
        assert "no Location header" in message
        assert "/api/consulta/v1/orgaos/" in message

    def test_a_301_does_not_open_the_consulta_circuit(self):
        # Only a transport failure or a 5xx measures "the service is down". A
        # 301 is our bug, and must not stop the sweep for every other tender.
        with client_for(301) as client:
            for _ in range(4):
                with pytest.raises(PncpError):
                    client.fetch_contratacao("87612826000190", 2026, 958)
            assert client.consulta_breaker.state != "open"
