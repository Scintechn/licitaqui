"""Mapping PNCP's two record shapes onto a `tenders` row (§6.1).

The Consulta fixture below is a real response, copied from the knowledge base's
cached PNCP detail responses (`cache_pncp/00394429000100_2026_2346.json`) and
trimmed. Keeping it real is the point: every field this maps was wrong at least
once against an invented fixture, and `orcamentoSigilosoCodigo` — where 1 means
*not* confidential — would still be wrong today.
"""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from licitaqui.tenders import (
    from_consulta,
    from_search,
    parse_timestamp,
    split_control_number,
)

BRT = ZoneInfo("America/Sao_Paulo")


def brt(*args) -> datetime:
    """PNCP sends Brasília wall-clock time; the mapper attaches the offset."""
    return datetime(*args, tzinfo=BRT)


CONSULTA_RECORD = {
    "valorTotalEstimado": 494019.86,
    "valorTotalHomologado": None,
    "orcamentoSigilosoCodigo": 1,
    "orcamentoSigilosoDescricao": "Compra sem sigilo",
    "numeroControlePNCP": "00394429000100-1-002346/2026",
    "linkSistemaOrigem": "https://cnetmobile.estaleiro.serpro.gov.br/comprasnet-web/x",
    "anoCompra": 2026,
    "sequencialCompra": 2346,
    "numeroCompra": "843",
    "processo": "67720.001877/2026-19",
    "orgaoEntidade": {
        "cnpj": "00394429000100",
        "razaoSocial": "COMANDO DA AERONAUTICA",
        "poderId": "E",
        "esferaId": "F",
    },
    "unidadeOrgao": {
        "ufNome": "São Paulo",
        "codigoUnidade": "120016",
        "nomeUnidade": "GRUPAMENTO DE APOIO DE SÃO JOSÉ DOS CAMPOS",
        "ufSigla": "SP",
        "municipioNome": "São José dos Campos",
        "codigoIbge": "3549904",
    },
    "modalidadeId": 6,
    "modalidadeNome": "Pregão - Eletrônico",
    "modoDisputaId": 3,
    "modoDisputaNome": "Aberto-Fechado",
    "objetoCompra": "Aquisição de materiais através de Sistema de Registro de Preços (SRP)",
    "srp": True,
    "dataPublicacaoPncp": "2026-09-16T04:00:17",
    "dataAberturaProposta": "2026-09-16T08:00:00",
    "dataEncerramentoProposta": "2026-09-28T08:30:00",
    "situacaoCompraId": 1,
    "situacaoCompraNome": "Divulgada no PNCP",
    "dataInclusao": "2026-09-16T04:00:17",
    "dataAtualizacao": "2026-09-16T04:00:17",
    # 20 minutes after the header: a child changed. This is the common case —
    # 79 of the 95 cached records show it.
    "dataAtualizacaoGlobal": "2026-09-16T04:20:36",
    "usuarioNome": "Compras.gov.br",
}

SEARCH_ITEM = {
    "numero_controle_pncp": "00394429000100-1-002346/2026",
    "item_url": "/compras/00394429000100/2026/2346",
    "orgao_nome": "COMANDO DA AERONAUTICA",
    "unidade_nome": "GRUPAMENTO DE APOIO DE SÃO JOSÉ DOS CAMPOS",
    "uf": "SP",
    "municipio_nome": "São José dos Campos",
    "esfera_nome": "Federal",
    "modalidade_licitacao_id": "6",
    "modalidade_licitacao_nome": "Pregão - Eletrônico",
    "description": "Aquisição de materiais através de Sistema de Registro de Preços (SRP)",
    "title": "Edital nº 843/2026",
    "data_publicacao_pncp": "2026-09-16T04:00:17",
    "data_atualizacao_pncp": "2026-09-16T04:00:17",
    "data_inicio_vigencia": "2026-09-16T08:00:00",
    "data_fim_vigencia": "2026-09-28T08:30:00",
}


# -- the natural key -------------------------------------------------------


def test_split_control_number_matches_the_unique_constraint():
    assert split_control_number("51885242000140-1-000744/2026") == ("51885242000140", 2026, 744)


@pytest.mark.parametrize("bad", ["", "nonsense", "123456", "cnpj-1-2"])
def test_split_control_number_rejects_what_it_cannot_parse(bad: str):
    with pytest.raises(ValueError):
        split_control_number(bad)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("2026-09-16T04:20:36", brt(2026, 9, 16, 4, 20, 36)),
        ("2026-09-16T04:20", brt(2026, 9, 16, 4, 20)),
        ("2026-09-16", brt(2026, 9, 16)),
        (None, None),
        ("", None),
        ("not a date", None),
    ],
)
def test_parse_timestamp_handles_pncps_several_shapes(raw, expected):
    assert parse_timestamp(raw) == expected


# -- the Consulta record ---------------------------------------------------


def test_from_consulta_maps_the_whole_row():
    tender = from_consulta(CONSULTA_RECORD)

    assert tender.id == "00394429000100-1-002346/2026"
    assert (tender.agency_cnpj, tender.year, tender.sequence) == ("00394429000100", 2026, 2346)
    assert tender.agency_name == "COMANDO DA AERONAUTICA"
    assert tender.unit_name == "GRUPAMENTO DE APOIO DE SÃO JOSÉ DOS CAMPOS"
    assert tender.city == "São José dos Campos"
    assert tender.state == "SP"
    assert tender.sphere == "F"
    assert tender.modality_id == 6
    assert tender.modality_name == "Pregão - Eletrônico"
    assert tender.status == "Divulgada no PNCP"
    assert tender.estimated_value == 494019.86
    assert tender.bidding_system_url.startswith("https://")
    assert tender.proposals_open_at == brt(2026, 9, 16, 8, 0)
    assert tender.proposals_close_at == brt(2026, 9, 28, 8, 30)


def test_from_consulta_takes_srp_from_the_header_not_from_keywords():
    """POC 1 inferred SRP from a false-positive keyword list; the header has it."""
    assert from_consulta(CONSULTA_RECORD).price_registration is True
    assert from_consulta({**CONSULTA_RECORD, "srp": False}).price_registration is False


def test_pncp_updated_at_is_the_global_timestamp_not_the_header_one():
    """The whole of ADR-0001 rests on this column holding the child-aware value."""
    tender = from_consulta(CONSULTA_RECORD)
    assert tender.pncp_updated_at == brt(2026, 9, 16, 4, 20, 36)
    assert tender.pncp_updated_at != parse_timestamp(CONSULTA_RECORD["dataAtualizacao"])


def test_pncp_updated_at_falls_back_to_the_header_when_global_is_absent():
    record = {k: v for k, v in CONSULTA_RECORD.items() if k != "dataAtualizacaoGlobal"}
    assert from_consulta(record).pncp_updated_at == brt(2026, 9, 16, 4, 0, 17)


@pytest.mark.parametrize(
    ("code", "confidential"),
    [(1, False), (2, True), (3, True), ("1", False), ("3", True), (None, False)],
)
def test_confidential_budget_reads_the_code_not_its_truthiness(code, confidential):
    """1 is "Compra sem sigilo". Treating the code as a boolean inverts 83 of 95."""
    record = {**CONSULTA_RECORD, "orcamentoSigilosoCodigo": code}
    assert from_consulta(record).confidential_budget is confidential


def test_from_consulta_rejects_a_record_without_the_natural_key():
    with pytest.raises(ValueError):
        from_consulta({k: v for k, v in CONSULTA_RECORD.items() if k != "numeroControlePNCP"})


# -- the search item (the fallback's poorer record) ------------------------


def test_from_search_maps_what_the_index_carries():
    tender = from_search(SEARCH_ITEM)

    assert tender.id == "00394429000100-1-002346/2026"
    assert (tender.agency_cnpj, tender.year, tender.sequence) == ("00394429000100", 2026, 2346)
    assert tender.state == "SP"
    assert tender.sphere == "F"  # spelled out as "Federal" in the index
    assert tender.modality_id == 6  # arrives as a string
    assert tender.proposals_close_at == brt(2026, 9, 28, 8, 30)
    assert tender.pncp_updated_at == brt(2026, 9, 16, 4, 0, 17)


def test_from_search_leaves_the_fields_it_cannot_know_unset():
    """srp and the estimated value are absent from the index.

    They must stay None so the upsert's COALESCE keeps whatever a
    consulta-sourced write already established, instead of blanking it.
    """
    tender = from_search(SEARCH_ITEM)
    assert tender.price_registration is None
    assert tender.estimated_value is None
    assert tender.bidding_system_url is None
