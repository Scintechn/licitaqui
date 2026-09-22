"""The short-title evaluation, replayed offline.

Running the gate inside `pytest` is deliberate, for the same reason
`test_evaluation.py` does it: `evaluate-ai.yml` only fires when the AI files
change, but the deterministic rules, the branch predicate and the validator can
be broken from anywhere in the worker. Replaying the recorded answers costs
nothing and fails the ordinary suite if they are.
"""

from __future__ import annotations

import json

import pytest

from evaluation import titles as harness
from licitaqui import titles


def _report(name: str) -> harness.CaseReport:
    return harness.run_case(name, model=harness.SCREENING_MODEL, mode="recorded", key=None)


def test_there_are_answer_keys() -> None:
    assert harness.case_names()


@pytest.mark.parametrize("name", harness.case_names())
def test_every_answer_key_scores_full_marks(name: str) -> None:
    report = _report(name)
    assert report.error is None, report.error
    assert report.failures == [], [f"{c.name} → {c.found}" for c in report.failures]


def test_the_gate_is_not_an_average() -> None:
    """One fabricated beneficiary fails the run, whatever the percentage says."""
    reports = [_report(n) for n in harness.case_names()]
    reports.append(
        harness.CaseReport(
            name="synthetic",
            title="Coleta de lixo para MEI",
            source="ai",
            checks=[
                harness.CheckResult(
                    "não inventa destinatário", ok=False, found="para MEI", safety=True
                )
            ],
        )
    )
    assert (
        harness.print_report(
            reports, model=harness.SCREENING_MODEL, mode="recorded", threshold=50.0
        )
        is False
    )


# -- The three measured fabrications --------------------------------------


FABRICATIONS = [n for n in harness.case_names() if n.startswith("fabricacao_")]


def test_all_three_fabrications_are_answer_keys() -> None:
    assert len(FABRICATIONS) == 3


@pytest.mark.parametrize("name", FABRICATIONS)
def test_a_fabrication_is_rejected(name: str) -> None:
    case = harness.load_case(name)
    block = titles.item_lines(case.get("itens", []))
    assert titles.validate(case["answer"], case["objeto"], block) is not None


@pytest.mark.parametrize("name", FABRICATIONS)
def test_a_fabrication_key_fails_a_weakened_validator(
    name: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The fixture must *bite*, not merely be present.

    A key that passes whatever the validator does would prove nothing, so this
    removes the vocabulary check and asserts the key notices.
    """
    monkeypatch.setattr(titles, "_derivable", lambda token, vocabulary: True)
    report = _report(name)
    assert report.failures, "the fabrication key passed with the validator disabled"


# -- The pipeline keys carry the checks that make the gate prompt-sensitive


PIPELINE = [n for n in harness.case_names() if not n.startswith("fabricacao_")]


@pytest.mark.parametrize("name", PIPELINE)
def test_every_pipeline_key_forbids_a_recipient_clause(name: str) -> None:
    case = harness.load_case(name)
    assert any(c["tipo"] == "sem_destinatario" for c in case["checks"]), (
        "without this check the key cannot notice the 'o que e PARA QUEM' prompt coming back"
    )


@pytest.mark.parametrize(
    ("title", "flagged"),
    [
        ("Manutenção predial para Escola Prudêncio de Pinho", True),
        ("Coleta de lixo hospitalar para MEI e pequenas empresas", True),
        ("Recapeamento asfáltico para moradores de Rio Claro", True),
        ("Aquisição de materiais hospitalares para hemodinâmica", False),
        ("Obras de manutenção e melhoramentos em aeródromos", False),
        ("Manutenção e conservação de bens imóveis", False),
    ],
)
def test_the_recipient_clause_pattern_discriminates(title: str, flagged: bool) -> None:
    """It must catch a beneficiary without catching a purpose."""
    hit = harness.RECIPIENT_CLAUSE.search(titles.norm(title))
    assert (hit is not None) is flagged, f"{title} → {hit}"


# -- The keys themselves ---------------------------------------------------


@pytest.mark.parametrize("name", harness.case_names())
def test_a_key_is_well_formed(name: str) -> None:
    case = harness.load_case(name)
    assert case.get("nota"), "every key says why it exists"
    assert case.get("objeto")
    if "answer" in case:
        assert case.get("rejeicao")
    else:
        assert case["checks"]
        for check in case["checks"]:
            assert check["nome"] and check["tipo"]


def test_the_recorded_answers_carry_their_versions() -> None:
    """So a replay that is scoring a stale prompt can be spotted."""
    for path in harness.RECORDED.glob("*.json"):
        stored = json.loads(path.read_text(encoding="utf-8"))
        assert stored["prompt_version"] == titles.PROMPT_VERSION, (
            f"{path.name} was recorded under prompt {stored['prompt_version']}, "
            f"but the code is on {titles.PROMPT_VERSION}; re-record it"
        )
        assert stored["rules_version"] == titles.RULES_VERSION
