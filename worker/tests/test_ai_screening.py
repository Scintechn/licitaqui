"""The `ai_screening` job's own logic: where the document comes from, and the breaker.

No database and no network. The row-writing half is
`test_integration_ai_screening.py`, which needs `TEST_DATABASE_URL_C1`.
"""

from __future__ import annotations

import gzip
import hashlib
import json

import pytest

from licitaqui import ai_screening, ai_tender
from licitaqui.ai_tender import Analysis, Attempt, Screening
from licitaqui.registry import REGISTRY

from . import pdfs


@pytest.fixture(autouse=True)
def _never_the_real_key(monkeypatch):
    """A test must never be able to spend money, even if a stub is forgotten."""
    monkeypatch.setenv(ai_tender.OPENROUTER_KEY_VAR, "not-a-real-key")


def test_the_job_kind_is_registered():
    assert ai_screening.JOB_KIND in REGISTRY.kinds()
    assert REGISTRY.get(ai_screening.JOB_KIND) is ai_screening.ai_screening


def test_job_key_is_one_live_screening_per_tender():
    assert ai_screening.job_key("PNCP-1") == "screening:PNCP-1"


# -- Where the document comes from -----------------------------------------


def test_load_document_from_pages_already_extracted():
    payload = {
        "pages": [{"page": 1, "text": "uma pagina"}],
        "extraction_version": 3,
        "files_hash": "abc",
    }
    document, files_hash = ai_screening.load_document(payload)
    assert [p.text for p in document.pages] == ["uma pagina"]
    assert files_hash == "abc"


def test_load_document_from_a_gzipped_cache_file(tmp_path):
    path = tmp_path / "edital.json.gz"
    with gzip.open(path, "wt", encoding="utf-8") as handle:
        json.dump({"extraction_version": 3, "pages": [{"page": 1, "text": "oi"}]}, handle)

    document, files_hash = ai_screening.load_document({"text_path": str(path)})

    assert document.page_count == 1
    assert files_hash == document.text_hash(), "no file bytes to hash: fall back to the text"


def test_load_document_from_a_pdf_hashes_the_bytes(tmp_path):
    data = pdfs.text_pdf(["um edital"])
    path = tmp_path / "edital.pdf"
    path.write_bytes(data)

    document, files_hash = ai_screening.load_document({"pdf_path": str(path)})

    assert [p.text for p in document.pages] == ["um edital"]
    assert files_hash == hashlib.sha256(data).hexdigest()


def test_a_payload_with_no_source_is_a_caller_bug():
    with pytest.raises(ValueError, match="needs 'pages'"):
        ai_screening.load_document({"tender_id": "x"})


# -- What may open the circuit ---------------------------------------------


def _failed(*https: int) -> Screening:
    attempts = tuple(Attempt(reasoning="off", json_mode=True, http=code) for code in https)
    analysis = Analysis(
        model="m", mode="lite", prompt_version="v", ok=False, result=None, attempts=attempts
    )
    return Screening(status="failed", analysis=analysis)


@pytest.mark.parametrize("https", [(0, 0), (502, 503), (429, 429)])
def test_a_broken_endpoint_counts_towards_the_breaker(https):
    assert ai_screening._transport_failed(_failed(*https)) is True


@pytest.mark.parametrize("https", [(200, 200, 200), (200, 0), (400, 400)])
def test_a_model_answering_badly_does_not_open_the_circuit(https):
    """A model that will not produce JSON says nothing about the endpoint's health.

    Tripping the breaker on it would block every other tender for 15 minutes.
    """
    assert ai_screening._transport_failed(_failed(*https)) is False


def test_a_successful_screening_never_counts_as_a_failure():
    analysis = Analysis(model="m", mode="lite", prompt_version="v", ok=True, result={})
    assert ai_screening._transport_failed(Screening(status="ok", analysis=analysis)) is False


def test_no_text_is_decided_before_the_breaker_is_consulted(monkeypatch):
    """A scan must not be blocked by an open circuit, nor open one: it costs nothing."""

    def explode(*_args, **_kwargs):
        raise AssertionError("no breaker and no API for a document with no text")

    monkeypatch.setattr(ai_tender, "call_model", explode)
    monkeypatch.setattr(ai_screening, "get_breaker", explode)
    monkeypatch.setattr(ai_screening, "store", lambda *a, **k: 1)
    monkeypatch.setattr(ai_screening, "cached", lambda *a, **k: None)

    screening = ai_screening.screen_tender(
        conn=None,
        payload={"tender_id": "t", "pages": [{"page": 1, "text": ""}], "files_hash": "h"},
        log=_SilentLog(),
    )
    assert screening.status == ai_tender.NO_TEXT


class _SilentLog:
    def info(self, *_args, **_kwargs) -> None: ...

    def warning(self, *_args, **_kwargs) -> None: ...
