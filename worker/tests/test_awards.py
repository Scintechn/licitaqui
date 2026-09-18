"""Mapping a PNCP award onto an `awards` row: the CPF rule and POC 3's bands.

No database and no network. The proof that masking survives the *real* write
path is `test_integration_sync_awards.py`; this file pins the rules it relies
on, one at a time.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from datetime import date
from decimal import Decimal
from typing import Any

import pytest

from licitaqui.awards import (
    DISCOUNT_MAX_VALID,
    DISCOUNT_MIN_VALID,
    MASKED_UNKNOWN,
    QUALITY_CANCELLED,
    QUALITY_CONFIDENTIAL,
    QUALITY_OK,
    QUALITY_OUT_OF_RANGE,
    Award,
    award_date,
    classify_supplier,
    discount_fraction,
    discount_pct,
    from_pncp,
    initials,
    is_cancelled,
    map_all,
    mask_cpf,
    quality_of,
    redact_record,
)

TENDER = "99000000000018-1-000123/2026"

#: A CPF that belongs to nobody: 000.000.000-00 fails the check digits, and the
#: repeated-digit CPFs are reserved as invalid by the Receita Federal's own
#: algorithm. Every personal-data fixture in this suite uses one.
FAKE_CPF = "11111111111"
FAKE_CPF_PUNCTUATED = "111.111.111-11"
FAKE_NAME = "Joao da Silva Souza"


def pj_record(**overrides: Any) -> dict[str, Any]:
    """The shape `/…/itens/{n}/resultados` really answers with (a cached record)."""
    record = {
        "indicadorSubcontratacao": False,
        "dataInclusao": "2026-09-14T12:23:16",
        "numeroItem": 1,
        "niFornecedor": "68117429000105",
        "dataCancelamento": None,
        "dataAtualizacao": "2026-09-14T12:23:16",
        "tipoPessoa": "PJ",
        "nomeRazaoSocialFornecedor": "PAPELARIA CENTRAL LTDA",
        "valorTotalHomologado": 850.0,
        "reservaRemanescente": {"codigo": 1, "nome": "Não se aplica"},
        "codigoPais": "BRA",
        "porteFornecedorId": 1,
        "quantidadeHomologada": 1.0,
        "valorUnitarioHomologado": 850.0,
        "percentualDesconto": 0.0,
        "ordemClassificacaoSrp": None,
        "dataResultado": "2026-09-14",
        "motivoCancelamento": None,
        "numeroControlePNCPCompra": TENDER,
        "situacaoCompraItemResultadoId": 1,
        "porteFornecedorNome": "ME",
        "situacaoCompraItemResultadoNome": "Informado",
        "sequencialResultado": 1,
        "aplicacaoBeneficioMeEpp": True,
    }
    record.update(overrides)
    return record


def pf_record(**overrides: Any) -> dict[str, Any]:
    """A natural-person winner: the case §12 is about."""
    base: dict[str, Any] = {
        "tipoPessoa": "PF",
        "niFornecedor": FAKE_CPF,
        "nomeRazaoSocialFornecedor": FAKE_NAME,
        "porteFornecedorNome": "Não Informado",
    }
    base.update(overrides)
    return pj_record(**base)


# -- the CPF rule (§12) ----------------------------------------------------


def test_a_cpf_is_masked_into_the_shape_the_spec_prescribes():
    assert mask_cpf("12345678901") == "***.456.789-**"
    assert mask_cpf("123.456.789-01") == "***.456.789-**"


def test_a_masked_cpf_keeps_none_of_the_digits_that_identify_it():
    masked = mask_cpf(FAKE_CPF)
    assert masked.count("*") == 5
    # The first three and the two check digits are gone, whatever they were.
    assert masked.startswith("***.") and masked.endswith("-**")


@pytest.mark.parametrize("bad", ["", "123", "1234567890123456", "abc"])
def test_a_document_of_no_recognised_length_keeps_nothing(bad: str):
    assert mask_cpf(bad) == MASKED_UNKNOWN


def test_a_company_keeps_its_cnpj_and_its_razao_social():
    supplier = classify_supplier(pj_record())
    assert supplier.doc == "68117429000105"
    assert supplier.name == "PAPELARIA CENTRAL LTDA"
    assert supplier.person_type == "PJ"
    assert supplier.personal is False


def test_a_natural_person_is_masked_to_document_and_initials():
    supplier = classify_supplier(pf_record())
    assert supplier.doc == "***.111.111-**"
    assert supplier.name == "J. S. S."
    assert supplier.person_type == "PF"
    assert supplier.personal is True


def test_an_eleven_digit_document_is_a_cpf_even_when_pncp_says_pj():
    """Fail closed. A PJ flag on a CPF-shaped document is a contradiction, and
    the safe reading of a contradiction about personal data is the one that
    masks."""
    supplier = classify_supplier(
        pj_record(niFornecedor=FAKE_CPF, nomeRazaoSocialFornecedor=FAKE_NAME)
    )
    assert supplier.personal is True
    assert supplier.doc == "***.111.111-**"
    assert supplier.name == "J. S. S."


def test_a_pf_flag_masks_even_a_fourteen_digit_document():
    supplier = classify_supplier(
        pj_record(tipoPessoa="PF", nomeRazaoSocialFornecedor="FULANO DE TAL")
    )
    assert supplier.personal is True
    assert supplier.doc == MASKED_UNKNOWN
    assert supplier.name == "F. T."


def test_a_document_of_unknown_shape_is_masked_and_so_is_the_name():
    supplier = classify_supplier(
        pj_record(niFornecedor="ABC-99", nomeRazaoSocialFornecedor=FAKE_NAME, tipoPessoa=None)
    )
    assert supplier.personal is True
    assert supplier.doc == MASKED_UNKNOWN
    assert supplier.name == "J. S. S."


def test_a_tipo_pessoa_outside_pj_and_pf_is_decided_by_the_document():
    """`tipoPessoa` is not a two-value domain in live data.

    The B8 backfill found a ``"PE"`` among 5,000-odd real awards, on a 14-digit
    document belonging to a company ("ALFARI SOLUÇÕES LTDA"). Trusting the flag
    to be PJ-or-PF would have had to guess; keying on the document shape does
    not. A `PE` on a CPF-shaped document is masked for the same reason.
    """
    company = classify_supplier(pj_record(tipoPessoa="PE"))
    assert company.personal is False
    assert company.person_type == "PE"

    person = classify_supplier(pj_record(tipoPessoa="PE", niFornecedor=FAKE_CPF))
    assert person.personal is True
    assert person.doc == "***.111.111-**"


def test_a_missing_tipo_pessoa_is_read_off_the_document_length():
    assert classify_supplier(pj_record(tipoPessoa=None)).personal is False
    assert classify_supplier(pj_record(tipoPessoa="", niFornecedor=FAKE_CPF)).personal is True


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("Joao da Silva Souza", "J. S. S."),
        ("MARIA DOS SANTOS", "M. S."),
        ("Ana", "A."),
        ("  Pedro   Alvares   Cabral  ", "P. A. C."),
        ("68.117.429 FULANO DE TAL", "F. T."),
        ("", None),
        (None, None),
    ],
)
def test_initials_drop_the_particles_and_anything_that_is_not_a_name(name, expected):
    assert initials(name) == expected


def test_the_raw_payload_of_a_person_carries_neither_the_cpf_nor_the_name():
    """The trap: masking two columns and storing the untouched payload beside
    them stores the CPF anyway, one key deeper."""
    record = pf_record(
        niFornecedor=FAKE_CPF_PUNCTUATED,
        motivoCancelamento=f"Proposta de {FAKE_NAME} ({FAKE_CPF}) cancelada",
        reservaRemanescente={"codigo": 1, "nome": f"{FAKE_NAME} - {FAKE_CPF_PUNCTUATED}"},
    )
    supplier = classify_supplier(record)
    redacted = redact_record(record, supplier)
    blob = json.dumps(redacted, ensure_ascii=False)

    assert FAKE_CPF not in blob
    assert FAKE_CPF_PUNCTUATED not in blob
    assert FAKE_NAME not in blob
    assert "Silva" not in blob and "Souza" not in blob
    assert redacted["niFornecedor"] == "***.111.111-**"
    assert redacted["nomeRazaoSocialFornecedor"] == "J. S. S."
    # Everything impersonal survives untouched.
    assert redacted["valorUnitarioHomologado"] == 850.0
    assert redacted["numeroControlePNCPCompra"] == TENDER


def test_a_company_payload_is_stored_as_it_arrived():
    record = pj_record()
    assert redact_record(record, classify_supplier(record)) == record


def test_from_pncp_never_returns_an_unmasked_person():
    award = from_pncp(TENDER, pf_record(), unit_estimated_value=Decimal("1000"))
    row = json.dumps(asdict(award), ensure_ascii=False, default=str)
    assert FAKE_CPF not in row
    assert FAKE_NAME not in row
    assert award.supplier_doc == "***.111.111-**"
    assert award.supplier_name == "J. S. S."


# -- POC 3's discount band -------------------------------------------------


def test_the_discount_is_poc3s_formula():
    assert discount_fraction(Decimal("100"), Decimal("65")) == Decimal("0.35")


def test_the_thresholds_are_poc3s_thresholds():
    assert str(DISCOUNT_MIN_VALID) == "-0.05"
    assert str(DISCOUNT_MAX_VALID) == "0.90"


@pytest.mark.parametrize(
    ("estimated", "awarded", "expected"),
    [
        (Decimal("100"), Decimal("65"), QUALITY_OK),
        (Decimal("100"), Decimal("105"), QUALITY_OK),  # -5% exactly: still plausible
        (Decimal("100"), Decimal("10"), QUALITY_OK),  # 90% exactly: the edge is inside
        (Decimal("100"), Decimal("106"), QUALITY_OUT_OF_RANGE),
        (Decimal("100"), Decimal("9"), QUALITY_OUT_OF_RANGE),
        (None, Decimal("65"), QUALITY_CONFIDENTIAL),
        (Decimal("0"), Decimal("65"), QUALITY_CONFIDENTIAL),
        (Decimal("100"), None, QUALITY_CONFIDENTIAL),
    ],
)
def test_the_four_quality_classes(estimated, awarded, expected):
    discount = discount_fraction(estimated, awarded)
    assert quality_of(discount, cancelled=False) == expected


def test_a_zero_estimate_is_a_confidential_budget_not_a_free_item():
    """B3 measured all 374 sigiloso items reporting an estimate of 0. Treating
    that as a real estimate would manufacture a 100% discount."""
    assert discount_fraction(Decimal("0"), Decimal("500")) is None
    award = from_pncp(TENDER, pj_record(), unit_estimated_value=Decimal("0"))
    assert award.quality == QUALITY_CONFIDENTIAL
    assert award.discount_pct is None


def test_cancelled_wins_over_every_other_class():
    assert quality_of(Decimal("0.35"), cancelled=True) == QUALITY_CANCELLED
    assert quality_of(None, cancelled=True) == QUALITY_CANCELLED


def test_the_cancellation_signal_is_poc3s_date():
    assert is_cancelled(pj_record(dataCancelamento="2026-09-15T10:00:00")) is True
    assert is_cancelled(pj_record()) is False
    # The situação field alone is not enough, and never disagrees in practice:
    # of the 420 cached records, both "Cancelado" rows also carry the date.
    assert is_cancelled(pj_record(situacaoCompraItemResultadoNome="Cancelado")) is False


def test_the_discount_is_stored_in_percentage_points():
    award = from_pncp(TENDER, pj_record(), unit_estimated_value=Decimal("1000"))
    assert award.unit_awarded_value == Decimal("850.0")
    assert award.discount_pct == Decimal("15.00")


def test_a_discount_the_column_cannot_hold_is_null_rather_than_clamped():
    """`numeric(6,2)` tops out at ±9999.99 points. A clamped −9999.99% would
    look like a measurement; NULL plus `out_of_range` does not."""
    assert discount_pct(Decimal("-1000")) is None
    award = from_pncp(
        TENDER,
        pj_record(valorUnitarioHomologado=1_000_000.0),
        unit_estimated_value=Decimal("0.01"),
    )
    assert award.discount_pct is None
    assert award.quality == QUALITY_OUT_OF_RANGE


# -- the naive-Brasília trap, one column over ------------------------------


def test_a_date_only_result_keeps_its_day():
    assert award_date("2026-09-14") == date(2026, 9, 14)


def test_a_late_evening_result_does_not_slide_into_the_next_day():
    """PNCP sends naive Brasília wall clock. 23:30 BRT is 02:30 UTC the next
    day, so anything that lets Postgres do the cast stores the wrong date."""
    assert award_date("2026-09-17T23:30:00") == date(2026, 9, 17)
    assert award_date("2026-09-17T00:30:00") == date(2026, 9, 17)


def test_an_explicit_offset_is_converted_rather_than_trusted():
    assert award_date("2026-09-18T01:30:00+00:00") == date(2026, 9, 17)


def test_a_missing_date_is_none():
    assert award_date(None) is None
    assert award_date("") is None


# -- the row ---------------------------------------------------------------


def test_the_sequence_comes_from_the_payload():
    award = from_pncp(TENDER, pj_record(sequencialResultado=2), unit_estimated_value=None)
    assert award.sequence == 2
    assert from_pncp(TENDER, pj_record(sequencialResultado=None)).sequence == 1


def test_an_award_without_an_item_number_is_rejected_rather_than_renumbered():
    with pytest.raises(ValueError, match="numeroItem"):
        from_pncp(TENDER, pj_record(numeroItem=None))


def test_the_caller_can_supply_the_item_number():
    award = from_pncp(TENDER, pj_record(numeroItem=None), item_number=7)
    assert award.item_number == 7


def test_map_all_drops_a_repeated_sequence():
    records = [pj_record(), pj_record(), pj_record(sequencialResultado=2)]
    awards = map_all(TENDER, records, item_number=1, unit_estimated_value=Decimal("1000"))
    assert [a.sequence for a in awards] == [1, 2]


def test_the_award_row_carries_what_the_price_band_needs():
    award = from_pncp(TENDER, pj_record(), unit_estimated_value=Decimal("1000"))
    assert isinstance(award, Award)
    assert award.tender_id == TENDER
    assert award.item_number == 1
    assert award.company_size == "ME"
    assert award.awarded_quantity == Decimal("1.0")
    assert award.awarded_on == date(2026, 9, 14)
    assert award.quality == QUALITY_OK


# -- the targeting knobs (no database) -------------------------------------


def test_the_default_segments_are_b3s_labels():
    """They are joined against `tender_items.segment`, which holds POC 1's
    labels (B3), so a typo here is a silent collection of nothing."""
    from licitaqui.segments import SEGMENTS
    from licitaqui.sync_awards import DEFAULT_SEGMENTS

    labels = {label for _, label in SEGMENTS}
    assert set(DEFAULT_SEGMENTS) <= labels
    assert "Outros" not in DEFAULT_SEGMENTS


def test_the_segments_of_interest_can_be_overridden_by_environment(monkeypatch):
    from licitaqui.sync_awards import DEFAULT_SEGMENTS, SEGMENTS_VAR, configured_segments

    monkeypatch.delenv(SEGMENTS_VAR, raising=False)
    assert configured_segments() == DEFAULT_SEGMENTS
    monkeypatch.setenv(SEGMENTS_VAR, "Alimentos, Mobiliário ")
    assert configured_segments() == ("Alimentos", "Mobiliário")


def test_an_absent_segments_payload_is_the_configured_set_and_an_empty_one_is_all(monkeypatch):
    from licitaqui.sync_awards import SEGMENTS_VAR, _segments_param

    monkeypatch.setenv(SEGMENTS_VAR, "Alimentos")
    assert _segments_param(None) == ["Alimentos"]
    # `None` in the SQL means "no segment predicate": the unbounded sweep.
    assert _segments_param([]) is None
    assert _segments_param(["Mobiliário"]) == ["Mobiliário"]


def test_zero_is_a_value_and_not_unset():
    """`int(payload.get(k) or default)` would turn `cooldown_hours: 0` — an
    operator saying *re-probe now* — back into the week-long default."""
    from licitaqui.sync_awards import _int_option

    assert _int_option({"cooldown_hours": 0}, "cooldown_hours", 168) == 0
    assert _int_option({}, "cooldown_hours", 168) == 168
    assert _int_option({"cooldown_hours": None}, "cooldown_hours", 168) == 168
    assert _int_option({"cooldown_hours": "24"}, "cooldown_hours", 168) == 24
