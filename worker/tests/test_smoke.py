"""Smoke test so the worker test command is green from the skeleton onwards."""

from pathlib import Path

GABARITOS = Path(__file__).resolve().parent.parent / "evaluation" / "gabaritos"


def test_answer_keys_are_present() -> None:
    assert len(list(GABARITOS.glob("*.json"))) == 3
