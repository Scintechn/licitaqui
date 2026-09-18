"""Mapping a PNCP item, and the four things the items say about the tender.

The ME/EPP and favored-treatment rules are on §13's minimum-tests list. They are
exercised against the four real tenders in ``tests/fixtures/poc1/tenders.json``
— one per value of `me_epp_summary`, picked from the cached PNCP responses by
the same rule the code implements — plus two more chosen for their money: one
above the EPP cap and one whose budget is confidential.
"""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

import pytest

from licitaqui.items import (
    EPP_REVENUE_CAP,
    OTHER_LABEL,
    TenderItem,
    classify_all,
    favored_treatment,
    from_pncp,
    me_epp_summary,
    tender_segments,
    total_estimated_value,
)
from licitaqui.segments import SEGMENTS, label

CLEANING = label("cleaning")
FOOD = label("food")
IT = label("it")
OFFICE = label("office")

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "poc1"
TENDERS = {
    t.get("note") or t["me_epp_summary"]: t
    for t in json.loads((FIXTURES / "tenders.json").read_text(encoding="utf-8"))["tenders"]
}

TENDER_ID = "99000000000103-1-000001/2026"


def items_of(name: str) -> list[TenderItem]:
    return classify_all(TENDER_ID, TENDERS[name]["itens"])


def item(number: int, **overrides) -> TenderItem:
    return TenderItem(tender_id=TENDER_ID, number=number, **overrides)


# -- mapping ---------------------------------------------------------------


def test_from_pncp_maps_and_classifies_in_one_pass() -> None:
    record = {
        "numeroItem": 3,
        "descricao": "NOTEBOOK 16GB RAM",
        "materialOuServico": "M",
        "materialOuServicoNome": "Material",
        "quantidade": 10,
        "unidadeMedida": "Unidade ",
        "valorUnitarioEstimado": 4500.5,
        "valorTotal": 45005.0,
        "ncmNbsCodigo": "8471.30.12",
        "criterioJulgamentoNome": "Menor preço",
        "tipoBeneficio": 1,
        "tipoBeneficioNome": "Participação exclusiva para ME/EPP",
        "temResultado": False,
    }

    mapped = from_pncp(TENDER_ID, record)

    assert mapped.number == 3
    assert mapped.kind == "M"
    assert mapped.unit == "Unidade"
    assert mapped.quantity == Decimal("10")
    assert mapped.unit_estimated_value == Decimal("4500.5")
    # The stored value is POC 1's label, because that is what B6 seeded
    # `cnae_segments.segment` with and R1 joins the two.
    assert mapped.segment == "Informática / TI"
    assert mapped.segment_key == "it"
    assert mapped.relevance == "high"  # the NCM said so
    assert mapped.benefit_id == 1
    assert mapped.is_exclusive
    assert mapped.raw is record  # the whole payload survives in `raw`


def test_an_item_without_a_number_is_rejected() -> None:
    """`(tender_id, number)` is the primary key; inventing one would collide."""
    with pytest.raises(ValueError, match="numeroItem"):
        from_pncp(TENDER_ID, {"descricao": "sem número"})


def test_classify_all_drops_a_repeated_number() -> None:
    records = [
        {"numeroItem": 1, "descricao": "Papel A4"},
        {"numeroItem": 1, "descricao": "Papel A4"},
        {"numeroItem": 2, "descricao": "Caneta"},
    ]
    assert [i.number for i in classify_all(TENDER_ID, records)] == [1, 2]


def test_item_timestamps_are_naive_brasilia_and_stay_in_raw() -> None:
    """B2's clock bug cannot bite here, and this says why.

    Every item timestamp PNCP sends is naive Brasília wall clock — the shape
    that stored deadlines three hours early when it reached a `timestamptz`.
    `tender_items` has no such column fed by PNCP, so the values only live on
    in `raw`, where any later reader must parse them with
    `licitaqui.tenders.parse_timestamp`.
    """
    stamps = [
        i.get("dataAtualizacao")
        for tender in TENDERS.values()
        for i in tender["itens"]
        if i.get("dataAtualizacao")
    ]
    assert stamps
    assert all(not s.endswith("Z") and "+" not in s for s in stamps)

    mapped = from_pncp(TENDER_ID, dict(TENDERS["exclusive"]["itens"][0]))
    assert "dataAtualizacao" in mapped.raw


def test_item_level_confidential_budget_is_a_real_boolean() -> None:
    """Unlike the tender's `orcamentoSigilosoCodigo`, where 1 means *no* secrecy.

    Measured over the 8,861 cached items: 8,487 false, 374 true, and every one
    of the 374 reports its values as zero — which is why a zero sum is read as
    "unknown" and not as "free".
    """
    confidential = TENDERS["confidential_budget"]["itens"]
    assert all(i["orcamentoSigiloso"] is True for i in confidential)
    assert all((i["valorTotal"] or 0) == 0 for i in confidential)


# -- ME/EPP summary --------------------------------------------------------


@pytest.mark.parametrize("expected", ["exclusive", "quota", "mixed", "none"])
def test_me_epp_summary_on_real_tenders(expected: str) -> None:
    assert me_epp_summary(items_of(expected)) == expected


def test_me_epp_summary_rules() -> None:
    exclusive = item(1, benefit_id=1)
    quota = item(2, benefit_id=3)
    open_item = item(3, benefit_id=4)
    not_applicable = item(4, benefit_id=5)
    subcontracting = item(5, benefit_id=2)

    assert me_epp_summary([exclusive, exclusive]) == "exclusive"
    assert me_epp_summary([quota, open_item]) == "quota"
    assert me_epp_summary([quota, quota]) == "quota"
    assert me_epp_summary([exclusive, open_item]) == "mixed"
    assert me_epp_summary([exclusive, quota]) == "mixed"
    assert me_epp_summary([open_item, not_applicable]) == "none"
    # Subcontracting is a benefit, but it reserves nothing: anyone may bid.
    assert me_epp_summary([subcontracting, open_item]) == "none"
    assert me_epp_summary([item(6, benefit_id=None)]) == "none"


def test_a_tender_with_no_items_has_no_summary() -> None:
    """Unknown is not "no benefit"; §6.1 leaves the column nullable for it."""
    assert me_epp_summary([]) is None


# -- favored treatment -----------------------------------------------------


def test_favored_treatment_at_the_epp_cap() -> None:
    assert Decimal("4800000") == EPP_REVENUE_CAP
    assert favored_treatment(EPP_REVENUE_CAP - 1, []) is True
    assert favored_treatment(EPP_REVENUE_CAP, []) is True  # at the cap, still inside
    assert favored_treatment(EPP_REVENUE_CAP + 1, []) is False


def test_favored_treatment_on_real_tenders() -> None:
    small = TENDERS["quota"]
    assert favored_treatment(small["valorTotalEstimado"], items_of("quota")) is True

    big = TENDERS["above_epp_cap"]
    assert favored_treatment(big["valorTotalEstimado"], items_of("above_epp_cap")) is False


def test_the_value_falls_back_to_the_sum_of_the_items() -> None:
    """POC 1's own fallback when the detail endpoint gave no total."""
    none_tender = TENDERS["none"]
    assert none_tender["valorTotalEstimado"] is None

    items = items_of("none")
    assert total_estimated_value(None, items) == Decimal("802697.4")
    assert favored_treatment(None, items) is True  # R$ 802,697 is inside the cap


def test_an_unknown_value_is_not_a_favored_one() -> None:
    """A confidential budget sums to zero; a card must not call that "small"."""
    confidential = TENDERS["confidential_budget"]
    items = items_of("confidential_budget")

    assert total_estimated_value(confidential["valorTotalEstimado"], items) is None
    assert favored_treatment(confidential["valorTotalEstimado"], items) is None
    assert favored_treatment(None, []) is None


# -- the segments array ----------------------------------------------------


def test_tender_segments_rank_by_money() -> None:
    """POC 1 gives the edital the segment it spends the most on; segments[0] is it."""
    items = [
        item(1, segment=IT, total_value=Decimal("100")),
        item(2, segment=CLEANING, total_value=Decimal("900")),
        item(3, segment=IT, total_value=Decimal("850")),
    ]
    assert tender_segments(items) == [IT, CLEANING]


def test_other_is_not_a_segment() -> None:
    items = [item(1, segment=OTHER_LABEL, total_value=Decimal("5000")), item(2, segment=FOOD)]
    assert tender_segments(items) == [FOOD]


def test_segments_fall_back_to_the_object_when_the_items_say_nothing() -> None:
    """POC 1's own fallback: classify the objeto when the items carry none."""
    items = [item(1, segment=OTHER_LABEL)]
    assert tender_segments(items, object_text="Aquisição de material de limpeza") == [CLEANING]
    assert tender_segments([], object_text="Serviço indeterminado") == []


def test_zero_valued_items_still_produce_a_stable_order() -> None:
    items = [item(1, segment=OFFICE), item(2, segment=FOOD)]
    assert tender_segments(items) == [FOOD, OFFICE]


def test_the_stored_segment_is_the_vocabulary_b6_seeded() -> None:
    """`tender_items.segment` must be joinable with `cnae_segments.segment`.

    B6 seeded that table with POC 1's labels ("Alimentos", "Saúde / Hospitalar"),
    so an English key here would match no company on the Radar. Storing POC 1's
    own string also keeps the parity claim literal.
    """
    assert [lab for _, lab in SEGMENTS][:3] == [
        "Software / Sistemas",
        "Segurança Eletrônica / CFTV",
        "Informática / TI",
    ]
    mapped = from_pncp(TENDER_ID, {"numeroItem": 1, "descricao": "Refrigerante sabor cola 2L"})
    assert mapped.segment == "Alimentos"
    assert mapped.segment_key == "food"
