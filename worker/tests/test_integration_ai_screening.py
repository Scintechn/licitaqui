"""`ai_analyses` against a real database: the cache key, and what a row costs.

Needs `TEST_DATABASE_URL_C1` (see `worker/README.md`); skips without it. No
OpenRouter call is ever made — the transport is stubbed, and the cache tests
assert the stub was *not* reached.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from licitaqui import ai_screening, ai_tender, breaker, queue
from licitaqui.observability import get_logger
from licitaqui.registry import REGISTRY, JobContext

from .conftest import C1_CNPJ, c1_tender_id

LOG = get_logger("test")

ANSWER = {
    "objeto": "aquisicao de pilhas",
    "valor_estimado_total": "R$ 100.000,00",
    "vigencia_meses": "12 meses",
    "capital_ou_patrimonio_minimo": {"exige": True, "percentual": "10%", "pagina": 2},
    "beneficio_me_epp": {"situacao": "exclusivo", "pagina": 1},
    "nota_triagem_0_a_10": 8,
}

PAGES = [
    {"page": 1, "text": "Pregao exclusivo para ME/EPP e microempresa " + "z" * 800},
    {"page": 2, "text": "Capital social minimo de 10% do valor estimado " + "z" * 800},
    {"page": 3, "text": "Do pagamento em 30 dias " + "z" * 800},
]


def response(payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    return 200, {
        "choices": [{"message": {"content": json.dumps(payload)}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 18_000, "completion_tokens": 900, "cost": 0.00069},
    }


@pytest.fixture(autouse=True)
def _never_the_real_key(monkeypatch):
    """A test must never be able to spend money, even if a stub is forgotten."""
    monkeypatch.setenv(ai_tender.OPENROUTER_KEY_VAR, "not-a-real-key")


@pytest.fixture(autouse=True)
def _no_open_circuits():
    breaker.reset_all()
    yield
    breaker.reset_all()


@pytest.fixture
def tender(c1_conn) -> str:
    """One fictitious tender to hang the analyses off. Cleaned up by `c1_clean_dsn`."""
    tender_id = c1_tender_id()
    c1_conn.execute(
        "insert into tenders (id, agency_cnpj, year, sequence, object) values (%s, %s, %s, %s, %s)",
        (tender_id, C1_CNPJ, 2026, 1, "aquisicao de pilhas"),
    )
    return tender_id


def run_job(conn, payload: dict[str, Any]) -> None:
    """Through the registry, the way the consumer would."""
    job = queue.Job(
        id=1, kind=ai_screening.JOB_KIND, key="k", priority=1, payload=payload, attempts=1
    )
    REGISTRY.get(ai_screening.JOB_KIND)(
        JobContext(job=job, conn=conn, connect=lambda: None, log=LOG)
    )


COLUMNS = (
    "status",
    "model",
    "prompt_version",
    "extraction_version",
    "files_hash",
    "result",
    "citation_check",
    "rules",
    "input_tokens",
    "output_tokens",
    "cost_brl",
    "seconds",
)


def row(conn, tender_id: str) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute(
            f"select {', '.join(COLUMNS)} from ai_analyses where tender_id = %s",
            (tender_id,),
        )
        found = cur.fetchall()
    assert len(found) == 1, f"expected exactly one analysis, found {len(found)}"
    return dict(zip(COLUMNS, found[0], strict=True))


def test_a_screening_writes_the_answer_the_rules_and_what_it_cost(c1_conn, tender, monkeypatch):
    monkeypatch.setattr(ai_tender, "call_model", lambda *a, **k: response(ANSWER))

    run_job(c1_conn, {"tender_id": tender, "pages": PAGES, "files_hash": "hash-a"})

    stored = row(c1_conn, tender)
    assert stored["status"] == "ok"
    assert stored["model"] == ai_tender.SCREENING_MODEL
    assert stored["prompt_version"] == ai_tender.PROMPT_VERSION_LITE
    assert stored["extraction_version"] == ai_tender.EXTRACTION_VERSION
    assert stored["files_hash"] == "hash-a"
    assert stored["result"]["objeto"] == "aquisicao de pilhas"
    # The arithmetic is ours, and it is stored as such (§6.3).
    assert stored["rules"]["minimum_capital_brl"] == 10_000.0
    assert stored["rules"]["term_months"] == 12
    assert stored["result"]["vigencia_meses_normalizada"] == 12
    assert stored["citation_check"]["rate"] == 1.0
    # Cost logging (§14: "AI cost today and this month").
    assert (stored["input_tokens"], stored["output_tokens"]) == (18_000, 900)
    assert float(stored["cost_brl"]) == round(0.00069 * ai_tender.USD_BRL, 4)
    assert stored["seconds"] is not None


def test_the_second_request_for_the_same_file_is_free(c1_conn, tender, monkeypatch):
    """§3.2: cached permanently and shared across users — so it is paid for once."""
    monkeypatch.setattr(ai_tender, "call_model", lambda *a, **k: response(ANSWER))
    payload = {"tender_id": tender, "pages": PAGES, "files_hash": "hash-a"}
    run_job(c1_conn, payload)
    first = row(c1_conn, tender)

    def explode(*_args, **_kwargs):
        raise AssertionError("a cached analysis must not be paid for again")

    monkeypatch.setattr(ai_tender, "call_model", explode)
    screening = ai_screening.screen_tender(c1_conn, payload, log=LOG)

    assert screening.cached is True
    assert screening.called_api is False
    assert row(c1_conn, tender) == first, "the cached row is returned, not rewritten"


def test_an_amended_edital_is_a_new_analysis_not_an_overwrite(c1_conn, tender, monkeypatch):
    """§3.2: a new file list invalidates the text and the screening."""
    monkeypatch.setattr(ai_tender, "call_model", lambda *a, **k: response(ANSWER))
    run_job(c1_conn, {"tender_id": tender, "pages": PAGES, "files_hash": "hash-a"})
    run_job(c1_conn, {"tender_id": tender, "pages": PAGES, "files_hash": "hash-b"})

    with c1_conn.cursor() as cur:
        cur.execute(
            "select files_hash from ai_analyses where tender_id = %s order by files_hash",
            (tender,),
        )
        assert [r[0] for r in cur.fetchall()] == ["hash-a", "hash-b"]


def test_a_scanned_pdf_is_recorded_as_no_text_and_costs_nothing(c1_conn, tender, monkeypatch):
    def explode(*_args, **_kwargs):
        raise AssertionError("the API must not be called for a PDF with no text layer")

    monkeypatch.setattr(ai_tender, "call_model", explode)
    blank = [{"page": n, "text": ""} for n in range(1, 26)]

    run_job(c1_conn, {"tender_id": tender, "pages": blank, "files_hash": "scan"})

    stored = row(c1_conn, tender)
    assert stored["status"] == "no_text"
    assert stored["model"] is None
    assert float(stored["cost_brl"]) == 0
    assert (stored["input_tokens"], stored["output_tokens"]) == (0, 0)
    assert stored["result"] is None


def test_a_scan_is_not_re_extracted_or_retried_by_the_queue(c1_conn, tender, monkeypatch):
    """`no_text` is a final answer, not a failure: the handler must not raise."""
    monkeypatch.setattr(ai_tender, "call_model", lambda *a, **k: response(ANSWER))
    blank = [{"page": n, "text": ""} for n in range(1, 26)]
    payload = {"tender_id": tender, "pages": blank, "files_hash": "scan"}

    run_job(c1_conn, payload)
    screening = ai_screening.screen_tender(c1_conn, payload, log=LOG)

    assert screening.cached is True and screening.status == "no_text"


def test_a_failed_analysis_is_retried_and_then_replaced(c1_conn, tender, monkeypatch):
    monkeypatch.setattr(ai_tender, "call_model", lambda *a, **k: (500, {"error": "upstream"}))
    with pytest.raises(RuntimeError, match="ai_screening failed"):
        run_job(c1_conn, {"tender_id": tender, "pages": PAGES, "files_hash": "hash-a"})
    assert row(c1_conn, tender)["status"] == "failed"

    monkeypatch.setattr(ai_tender, "call_model", lambda *a, **k: response(ANSWER))
    run_job(c1_conn, {"tender_id": tender, "pages": PAGES, "files_hash": "hash-a"})

    stored = row(c1_conn, tender)
    assert stored["status"] == "ok"
    assert stored["result"]["objeto"] == "aquisicao de pilhas"


def test_two_failures_in_a_row_open_the_circuit(c1_conn, tender, monkeypatch):
    monkeypatch.setattr(ai_tender, "call_model", lambda *a, **k: (0, {"error": "ReadTimeout"}))
    payload = {"tender_id": tender, "pages": PAGES, "files_hash": "hash-a"}

    for _ in range(2):
        with pytest.raises(RuntimeError):
            run_job(c1_conn, payload)

    assert breaker.get_breaker(ai_tender.BREAKER_NAME).state == "open"
    with pytest.raises(breaker.CircuitOpen):
        run_job(c1_conn, payload)


def test_enqueue_keeps_one_live_screening_per_tender(c1_conn, tender):
    first = ai_screening.enqueue(c1_conn, tender, payload={"files_hash": "hash-a"})
    second = ai_screening.enqueue(c1_conn, tender, payload={"files_hash": "hash-a"})

    assert first is not None
    assert second is None, "the dedupe index is what keeps a waiting user to one job"

    with c1_conn.cursor() as cur:
        cur.execute("select priority, payload from jobs where id = %s", (first,))
        priority, payload = cur.fetchone()
    assert priority == 1, "a user is on screen waiting (§7.3)"
    assert payload["tender_id"] == tender
