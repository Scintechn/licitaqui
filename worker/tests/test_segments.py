"""B3's acceptance criterion: the port reproduces POC 1's classification.

The expected values are **POC 1's own**. ``tests/fixtures/poc1/items.json`` is
489 real item payloads taken from the knowledge base's cached PNCP responses,
each labelled by running ``poc1_licitacoes.segmento_item`` over it — not by
running the code under test. ``test_the_fixture_labels_are_poc1s_own`` re-derives
every label from the POC module itself whenever the knowledge base is on this
machine, so the fixture cannot quietly drift towards the port; it skips in CI,
where that read-only folder does not exist, and the committed labels stand.

The corpus covers all 15 outcomes (14 segments plus "Outros"), all three routes
into them (NCM code, keyword, nothing), every description containing a
false-positive expression, and every item the beverage rule reclassifies.

The port agrees with POC 1 on all of it but the beverages, which it rescues on
purpose — ``test_the_beverage_divergence_is_exactly_the_documented_one`` is
what keeps that divergence honest and bounded.
"""

from __future__ import annotations

import json
import sys
from functools import cache
from importlib import util as importlib_util
from pathlib import Path

import pytest

from licitaqui import segments
from licitaqui.segments import (
    HIGH,
    LOW,
    MEDIUM,
    OTHER,
    SEGMENTS,
    classify,
    key_for_label,
    label,
    normalize,
    segment_for_ncm,
    segment_for_text,
)

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "poc1"
CORPUS = json.loads((FIXTURES / "items.json").read_text(encoding="utf-8"))
ITEMS = CORPUS["items"]

#: The read-only knowledge base. Present on a developer machine, absent in CI.
POC1 = Path("/Users/sci/Documents/POC Licitacao/poc1_licitacoes.py")


def load_poc1():
    """Import the POC module from the read-only knowledge base, or skip."""
    if not POC1.exists():
        pytest.skip(f"{POC1.parent} is not on this machine; the committed labels stand")
    spec = importlib_util.spec_from_file_location("poc1_licitacoes_readonly", POC1)
    module = importlib_util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


# -- the corpus itself -----------------------------------------------------


def test_the_corpus_covers_every_segment_and_every_route() -> None:
    """A parity claim over a corpus that misses a segment proves little."""
    assert {rec["poc_segment"] for rec in ITEMS} == {lab for _, lab in SEGMENTS}
    assert {rec["poc_path"] for rec in ITEMS} == {"ncm", "text", "none"}
    assert len(ITEMS) >= 400


def test_the_fixture_labels_are_poc1s_own() -> None:
    """Re-derive every expected value from POC 1, on a machine that has it."""
    poc1 = load_poc1()

    mismatched = [
        (rec["item"].get("descricao"), rec["poc_segment"], poc1.segmento_item(rec["item"]))
        for rec in ITEMS
        if poc1.segmento_item(rec["item"]) != rec["poc_segment"]
    ]
    assert mismatched == []


# -- the parity claim ------------------------------------------------------


def verdict_for(rec: dict):
    item = rec["item"]
    return classify(item.get("descricao"), item.get("ncmNbsCodigo"), item.get("materialOuServico"))


@cache
def divergences() -> tuple[dict, ...]:
    """Every fixture item where the port and POC 1 disagree."""
    out = []
    for rec in ITEMS:
        verdict = verdict_for(rec)
        if label(verdict.segment) != rec["poc_segment"]:
            out.append(
                {
                    "descricao": (rec["item"].get("descricao") or "")[:120],
                    "ncm": rec["item"].get("ncmNbsCodigo"),
                    "kind": rec["item"].get("materialOuServico"),
                    "poc": rec["poc_segment"],
                    "port": label(verdict.segment),
                    "source": verdict.source,
                }
            )
    return tuple(out)


def test_the_port_reproduces_poc1_on_every_fixture_item() -> None:
    """489 real items, POC 1's answer, ours. The card's acceptance criterion.

    Everything except the beverages the port deliberately rescues, which the
    next test pins down item by item.
    """
    unexplained = [d for d in divergences() if d["port"] != "Alimentos"]
    assert unexplained == []


def test_the_beverage_divergence_is_exactly_the_documented_one() -> None:
    """The one place the port knowingly does not reproduce POC 1.

    POC 1's food rule stops at NCM chapter 21, so beverages land in "Outros" and
    never reach a company. Every disagreement with the POC must be a beverage
    moving *into* Alimentos — never anything leaving a segment it earned.
    """
    found = divergences()
    assert found, "the corpus no longer contains the items this rule rescues"
    assert {d["port"] for d in found} == {"Alimentos"}
    assert {d["poc"] for d in found} <= {"Outros", "Construção / Hidráulica"}
    assert all(
        any(term in segments.normalize(d["descricao"]) for term in ("agua mineral", "refrigerante"))
        for d in found
    ), found


def test_a_coolant_is_not_a_soft_drink() -> None:
    """ "Refrigerante" is also what an air conditioner's gas is called.

    Five real air conditioners in the cached corpus specify "GÁS REFRIGERANTE
    R-410A" or "GÁS/FLUIDO REFRIGERANTE". Without the lookbehinds on that
    keyword they all became food — the same class of mistake POC 1's
    false-positive list exists to prevent, one keyword lower down.
    """
    coolants = [
        rec
        for rec in ITEMS
        if "refrigerante" in segments.normalize(rec["item"].get("descricao"))
        and any(
            term in segments.normalize(rec["item"].get("descricao"))
            for term in ("ar condicionado", "central de ar")
        )
    ]
    assert coolants, "the corpus no longer contains the air conditioners"
    assert all(verdict_for(rec).segment != "food" for rec in coolants)

    assert segment_for_text("Carga de gás refrigerante R-410A") != "food"
    assert segment_for_text("Mangueira para gás/fluido refrigerante") != "food"
    assert segment_for_text("Refrigerante sabor cola 2L") == "food"


def test_a_real_bottled_water_item_is_food_not_construction() -> None:
    """POC 1 files this one under Construção / Hidráulica: its bottle is PVC."""
    water = next(
        rec for rec in ITEMS if "AGUA MINERAL 20 LTS" in (rec["item"].get("descricao") or "")
    )
    assert water["poc_segment"] == "Construção / Hidráulica"

    verdict = verdict_for(water)
    assert (verdict.segment, verdict.relevance) == ("food", MEDIUM)


def test_the_beverage_rule_leaves_cleaning_alcohol_alone() -> None:
    """Why chapter 22 is not added wholesale: 2207 is ethyl alcohol."""
    assert segment_for_ncm("22071010", "M") is None  # falls through to the keywords
    assert segment_for_text("Álcool etílico 70% para limpeza") == "cleaning"
    # And why bare "agua" was rejected as a keyword: POC 1 classifies neither of
    # these as food, and adding "agua" would have made bleach a drink.
    assert segment_for_text("Água sanitária 1L") is None
    assert segment_for_text("Caixa d'água de PVC 1000L") == "construction"


def test_the_false_positive_rule_changes_nothing_on_real_data() -> None:
    """The other place the port could diverge, measured rather than argued.

    Scrubbing the false-positive expressions before the keyword match is a
    deliberate addition (see the module docstring). If it ever demoted a real
    item, that would be a second divergence — over the corpus it demotes none,
    which is what makes the parity above a fair comparison rather than a
    coincidence.
    """
    demoted = [
        rec["item"].get("descricao")
        for rec in ITEMS
        if classify(
            rec["item"].get("descricao"),
            rec["item"].get("ncmNbsCodigo"),
            rec["item"].get("materialOuServico"),
        ).source
        == "false_positive"
    ]
    assert demoted == []


def test_the_corpus_does_contain_false_positive_expressions() -> None:
    """…and the previous test is not vacuous: the expressions are in there."""
    hits = [rec for rec in ITEMS if segments.has_false_positive(rec["item"].get("descricao"))]
    assert len(hits) >= 5


# -- the route decides the relevance --------------------------------------


def test_relevance_records_how_the_segment_was_reached() -> None:
    """Over the items the port and POC 1 agree on; the beverages are by keyword."""
    diverged = {d["descricao"] for d in divergences()}
    by_route = {"ncm": set(), "text": set(), "none": set()}
    for rec in ITEMS:
        if (rec["item"].get("descricao") or "")[:120] in diverged:
            continue
        by_route[rec["poc_path"]].add(verdict_for(rec).relevance)
    assert by_route == {"ncm": {HIGH}, "text": {MEDIUM}, "none": {LOW}}
    assert all(verdict_for(rec).relevance == MEDIUM for rec in ITEMS if _is_beverage(rec))


def _is_beverage(rec: dict) -> bool:
    return (rec["item"].get("descricao") or "")[:120] in {d["descricao"] for d in divergences()}


def test_the_port_and_poc1_agree_on_all_but_a_handful() -> None:
    """Eight items in the full cache; the sample over-represents them on purpose."""
    assert len(divergences()) < 0.05 * len(ITEMS)


def test_an_unclassifiable_item_is_other_and_low() -> None:
    verdict = classify("Contratação de serviço diverso", None, "S")
    assert (verdict.segment, verdict.relevance, verdict.source) == (OTHER, LOW, "none")


# -- the pieces, one at a time --------------------------------------------


def test_normalize_folds_accents_case_and_whitespace() -> None:
    # Leading and trailing spaces survive, exactly as in POC 1's `normalizar`:
    # the keyword regexes are anchored on \b, so trimming would change nothing
    # except the parity.
    assert normalize("  CONSTRUÇÃO   Civil\nPública ") == " construcao civil publica "
    assert normalize(None) == ""


def test_keys_and_labels_are_one_to_one() -> None:
    keys = [key for key, _ in SEGMENTS]
    labels = [lab for _, lab in SEGMENTS]
    assert len(keys) == len(set(keys)) == 15  # 14 segments plus `other`
    assert len(labels) == len(set(labels))
    assert all(key_for_label(label(key)) == key for key in keys)
    assert key_for_label("a segment nobody defined") == OTHER


def test_the_first_matching_list_wins() -> None:
    """POC 1's list order is priority, and "monitor led" must not become electrical."""
    assert segment_for_text("Locação de sistema de gestão escolar") == "software"
    assert segment_for_text("Monitor LED 24 polegadas") == "it"
    assert segment_for_text("Lâmpada LED 9W") == "electrical"


def test_word_boundaries_keep_obra_out_of_dobradica() -> None:
    """The ``\\b`` POC 1 puts in front of every keyword, tested rather than trusted."""
    assert segment_for_text("Dobradiça de aço inox") == "hardware"
    assert segment_for_text("Execução de obra de pavimentação") == "construction"


def test_the_health_regexes_match_dosages() -> None:
    assert segment_for_text("Dipirona sódica 500 mg comprimido") == "health"
    assert segment_for_text("Solução 40 mcg/ml") == "health"


def test_ncm_is_only_consulted_for_materials() -> None:
    """A service quoting an NCM is describing what it maintains, not selling it."""
    assert segment_for_ncm("8471.30.12", "M") == "it"
    assert segment_for_ncm("8471.30.12", "S") is None
    assert segment_for_ncm("", "M") is None


def test_the_longest_ncm_prefix_wins() -> None:
    assert segment_for_ncm("85369010", "M") == "electrical"  # 8536, not chapter 85
    assert segment_for_ncm("85258900", "M") == "security"  # 8525 beats 85
    assert segment_for_ncm("85073000", "M") == "electrical"  # falls back to 85
    assert segment_for_ncm("04012010", "M") == "food"  # chapter 04


def test_the_ncm_code_outranks_the_description() -> None:
    """POC 1's order: a material with a known NCM never reaches the keywords."""
    verdict = classify("Cadeira giratória", "94013000", "M")
    assert (verdict.segment, verdict.relevance, verdict.source) == ("furniture", HIGH, "ncm")

    # …and an NCM nothing recognises falls through to the keywords.
    verdict = classify("Cadeira giratória", "99999999", "M")
    assert (verdict.segment, verdict.relevance, verdict.source) == ("furniture", MEDIUM, "keyword")


# -- the false-positive rules ---------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        "Aquisição por sistema de registro de preços",
        "Fornecimento em sistema de comodato",
        "Manutenção do sistema de ar condicionado central",
        "Obras do sistema de esgotamento sanitário",
        "Compra pelo SRP da unidade",
    ],
)
def test_false_positive_expressions_are_recognised(text: str) -> None:
    assert segments.has_false_positive(text)
    assert segments.strip_false_positives(normalize(text)) != normalize(text)


def test_a_keyword_that_only_survives_unscrubbed_is_demoted() -> None:
    """The POC's skip rule, applied per item instead of per search term.

    "locação de sistema" is one of POC 1's software keywords and it appears
    inside "locação de sistema de registro de preços" — a way of buying, not
    software. POC 1's ``segmento_item`` would file this under Software /
    Sistemas because it classifies the raw text; the port scrubs first and
    files it as unclassified, which is the deliberate difference the module
    docstring records. No real item in the corpus takes this branch.
    """
    text = "Aquisição de materiais para locação de sistema de registro de preços"
    assert segment_for_text(text, scrub=False) == "software"
    assert segment_for_text(text, scrub=True) is None

    verdict = classify(text, None, "M")
    assert (verdict.segment, verdict.relevance, verdict.source) == (OTHER, LOW, "false_positive")


def test_scrubbing_leaves_a_genuine_software_item_alone() -> None:
    """The guard must not eat the thing it is guarding."""
    text = "Registro de preços para locação de sistema de gestão de frotas"
    assert segment_for_text(text) == "software"
