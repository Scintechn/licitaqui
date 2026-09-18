"""The evaluation harness, replayed offline.

Running the gate inside `pytest` is deliberate: `evaluate-ai.yml` only runs when
the AI files change, but a change to `parse_number`, the page selection or the
scoring can break the screening from anywhere in the worker. Replaying the
recorded answers costs nothing and fails the ordinary suite if it does.
"""

from __future__ import annotations

import pytest

from evaluation import run as harness
from evaluation import scoring
from evaluation.scoring import CheckResult

# -- The check types are the answer keys' contract -------------------------


@pytest.mark.parametrize(
    ("check", "data", "expected"),
    [
        (
            {"nome": "n", "campo": "a", "tipo": "igual", "valor": "exclusivo"},
            {"a": "Exclusivo"},
            True,
        ),
        ({"nome": "n", "campo": "a", "tipo": "igual", "valor": "exclusivo"}, {"a": "misto"}, False),
        (
            {"nome": "n", "campo": "a", "tipo": "contem_todos", "valor": ["2026-09-30", "08:30"]},
            {"a": "2026-09-30 08:30"},
            True,
        ),
        (
            {"nome": "n", "campo": "a", "tipo": "contem_algum", "valor": ["compras"]},
            {"a": "Compras.gov.br"},
            True,
        ),
        (
            {"nome": "n", "campo": "a", "tipo": "numero", "valor": 48196.0, "tolerancia": 0.005},
            {"a": "R$ 48.196,00"},
            True,
        ),
        ({"nome": "n", "campo": "a", "tipo": "entre", "valor": [10, 20]}, {"a": 15}, True),
        ({"nome": "n", "campo": "a", "tipo": "minimo", "valor": 7}, {"a": 6}, False),
        ({"nome": "n", "campo": "a", "tipo": "verdadeiro", "valor": True}, {"a": True}, True),
        ({"nome": "n", "campo": "a", "tipo": "falso_ou_nulo", "valor": False}, {"a": None}, True),
        ({"nome": "n", "campo": "a", "tipo": "falso_ou_nulo", "valor": False}, {"a": True}, False),
        (
            {"nome": "n", "campo": "a", "tipo": "nulo_ou_contem", "valor": ["2026-09-30"]},
            {"a": None},
            True,
        ),
        ({"nome": "n", "campo": "a", "tipo": "tamanho", "valor": 2}, {"a": [1, 2]}, True),
        ({"nome": "n", "campo": "a.b", "tipo": "igual", "valor": "x"}, {"a": {"b": "x"}}, True),
        ({"nome": "n", "campo": "a.b", "tipo": "igual", "valor": "x"}, {"a": None}, False),
    ],
)
def test_check_types(check, data, expected):
    assert scoring.run_check(check, data).ok is expected


def test_an_unknown_check_type_is_a_broken_answer_key_not_a_silent_zero():
    with pytest.raises(ValueError, match="unknown check type"):
        scoring.run_check({"nome": "n", "campo": "a", "tipo": "aproximado", "valor": 1}, {"a": 1})


# -- The answer keys and their documents -----------------------------------


def test_the_three_answer_keys_have_their_extracted_text():
    names = harness.case_names()
    assert len(names) == 3
    for name in names:
        case = harness.load_case(name)
        assert case.document.has_text
        assert case.answer_key["checks"], "an answer key with no checks would pass vacuously"


def test_every_check_of_every_answer_key_is_a_type_the_scorer_knows():
    for name in harness.case_names():
        case = harness.load_case(name)
        for check in case.answer_key["checks"]:
            scoring.run_check(check, {})  # raises on an unknown type


# -- The gate itself, offline ----------------------------------------------


def test_the_recorded_run_still_clears_the_gate(capsys):
    """Replays recorded answers: no API call, no cost. See the module docstring."""
    exit_code = harness.main(["--mode", "recorded"])
    printed = capsys.readouterr().out

    assert exit_code == 0, printed
    assert "PASS" in printed
    assert "REPLAYED" in printed


def test_the_gate_fails_loudly_when_the_score_drops(capsys):
    reports = [
        harness.CaseReport(
            name="edital",
            status="ok",
            checks=[CheckResult("a", True, ""), CheckResult("b", False, "errado")],
        )
    ]

    passing = harness.print_report(reports, model="m", mode="recorded", threshold=95)

    printed = capsys.readouterr().out
    assert passing is False
    assert "FAIL" in printed
    assert "✗ edital · b → errado" in printed, "the failing check has to be named"


def test_a_run_that_scored_nothing_is_not_a_pass(capsys):
    """A missing recording or a model that never answered must not look like 100%."""
    reports = [harness.CaseReport(name="edital", status="missing", error="no recorded answer")]
    assert harness.print_report(reports, model="m", mode="recorded", threshold=95) is False
    assert "FAIL" in capsys.readouterr().out


def test_live_mode_refuses_to_run_without_a_key(monkeypatch, capsys):
    monkeypatch.delenv("OPENROUTER_API_KEY", raising=False)
    monkeypatch.setattr(harness.config, "resolve_secret", lambda *a, **k: None)

    assert harness.main(["--mode", "live"]) == 2
    assert "not configured" in capsys.readouterr().out
