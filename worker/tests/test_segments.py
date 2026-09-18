"""B3's acceptance criterion: the port reproduces POC 1's classification.

The expected values are **POC 1's own**. ``tests/fixtures/poc1/items.json`` is
476 real item payloads taken from the knowledge base's cached PNCP responses,
each labelled by running ``poc1_licitacoes.segmento_item`` over it — not by
running the code under test. ``test_the_fixture_labels_are_poc1s_own`` re-derives
every label from the POC module itself whenever the knowledge base is on this
machine, so the fixture cannot quietly drift towards the port; it skips in CI,
where that read-only folder does not exist, and the committed labels stand.

The corpus covers all 15 outcomes (14 segments plus "Outros") and all three
routes into them (NCM code, keyword, nothing).
"""

from __future__ import annotations

import json
import sys
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


def test_the_port_reproduces_poc1_on_every_fixture_item() -> None:
    """476 real items, POC 1's answer, ours. The card's acceptance criterion."""
    disagreements = []
    for rec in ITEMS:
        item = rec["item"]
        verdict = classify(
            item.get("descricao"), item.get("ncmNbsCodigo"), item.get("materialOuServico")
        )
        if label(verdict.segment) != rec["poc_segment"]:
            disagreements.append(
                {
                    "descricao": (item.get("descricao") or "")[:120],
                    "ncm": item.get("ncmNbsCodigo"),
                    "kind": item.get("materialOuServico"),
                    "poc": rec["poc_segment"],
                    "port": label(verdict.segment),
                    "source": verdict.source,
                }
            )
    assert disagreements == []


def test_the_false_positive_rule_changes_nothing_on_real_data() -> None:
    """The one place the port may diverge, measured rather than asserted away.

    Scrubbing the false-positive expressions before the keyword match is a
    deliberate addition (see the module docstring). If it ever demoted a real
    item, this would be the divergence — over the corpus it demotes none, which
    is what makes the parity above a fair comparison rather than a coincidence.
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
    by_route = {"ncm": set(), "text": set(), "none": set()}
    for rec in ITEMS:
        item = rec["item"]
        verdict = classify(
            item.get("descricao"), item.get("ncmNbsCodigo"), item.get("materialOuServico")
        )
        by_route[rec["poc_path"]].add(verdict.relevance)
    assert by_route == {"ncm": {HIGH}, "text": {MEDIUM}, "none": {LOW}}


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
