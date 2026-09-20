"""The path that was broken end to end: a user asks, and an analysis comes out.

`requestScreening` enqueues `ai_screening` with `{tender_id}` and nothing else.
Until `licitaqui.documents` existed, `load_document` raised on that payload and
the job failed four times. Every test here starts from exactly that payload.

Needs `TEST_DATABASE_URL_DL` (see `worker/README.md`); CI counts a skip as a
failure. Nothing here reaches PNCP, S3 or OpenRouter: the PDFs are built by
`tests/pdfs.py`, the downloads run against an `httpx.MockTransport`, the object
store is an in-memory fake or the suite-wide `NullStore`, and the model call is
stubbed — the tests that must not pay assert the stub was never reached.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import pytest

from licitaqui import ai_screening, ai_tender, breaker, documents, files, queue, storage
from licitaqui.observability import get_logger
from licitaqui.registry import REGISTRY, JobContext

from . import pdfs
from .conftest import DL_CNPJ, dl_tender_id

LOG = get_logger("test")

#: The model's answer. Stubbed at `ai_tender.call_model`, so everything above it
#: — the prompt, the page selection, the citation check, the rules — is real.
ANSWER = {
    "objeto": "aquisicao de pilhas alcalinas",
    "valor_estimado_total": "R$ 100.000,00",
    "vigencia_meses": "12 meses",
    "capital_ou_patrimonio_minimo": {"exige": True, "percentual": "10%", "pagina": 2},
    "beneficio_me_epp": {"situacao": "exclusivo", "pagina": 1},
    "nota_triagem_0_a_10": 8,
}

#: Enough text per page to clear the `no_text` floors (§7.1: 1,500 characters,
#: and 30 per page), and carrying the facts the citation check looks for.
EDITAL_PAGES = [
    "Pregao eletronico exclusivo para ME/EPP e microempresa. " + "situacao " * 120,
    "Capital social minimo de 10% do valor estimado. " + "habilitacao " * 120,
    "Do pagamento em 30 dias corridos. " + "clausula " * 120,
]
TR_PAGES = ["Termo de Referencia: especificacao dos itens. " + "descricao " * 120]


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


@pytest.fixture(autouse=True)
def _no_throttle(monkeypatch):
    monkeypatch.setattr(documents._rate_limiter, "_min_interval", 0.0)


class FakeStore:
    """An object store in a dict. Records every key it is asked for."""

    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.configured = True

    def put(self, key: str, data: bytes, *, content_type: str) -> str | None:
        self.objects[key] = data
        return key

    def get(self, key: str) -> bytes | None:
        return self.objects.get(key)

    def delete(self, key: str) -> bool:
        self.objects.pop(key, None)
        return True


class PncpStub:
    """The documents PNCP would serve, and a count of what was fetched."""

    def __init__(self) -> None:
        self.bodies: dict[str, bytes] = {}
        self.status: dict[str, int] = {}
        self.requested: list[str] = []

    def serve(self, path: str, data: bytes) -> str:
        self.bodies[path] = data
        return f"https://pncp.test{path}"

    def fail(self, path: str, status: int) -> str:
        self.status[path] = status
        return f"https://pncp.test{path}"

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.requested.append(path)
        if path in self.status:
            return httpx.Response(self.status[path])
        return httpx.Response(200, content=self.bodies[path])

    def client(self, *_args, **_kwargs) -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(self.handle))

    @property
    def downloads(self) -> int:
        return len(self.requested)


@pytest.fixture
def pncp(monkeypatch) -> PncpStub:
    stub = PncpStub()
    monkeypatch.setattr(documents, "build_client", stub.client)
    return stub


@pytest.fixture
def tender(dl_conn) -> str:
    """One fictitious tender. Cleaned up by `dl_clean_dsn` (cascades to files)."""
    tender_id = dl_tender_id()
    dl_conn.execute(
        "insert into tenders (id, agency_cnpj, year, sequence, object,"
        "                     proposals_close_at, pncp_updated_at)"
        " values (%s, %s, %s, %s, %s, now() + interval '20 days', now() - interval '1 hour')",
        (tender_id, DL_CNPJ, 2026, 1, "aquisicao de pilhas alcalinas"),
    )
    return tender_id


def publish(conn, tender_id: str, *entries: tuple[int, str, str]) -> files.FileSync:
    """Write a file list the way `sync_files` does, and mark it fetched.

    Timestamps are derived from `now()`, never pinned: a fixture that hard-codes
    a date rots the day production's window moves past it, which is how `main`
    was red for two days.
    """
    published_at = datetime.now(UTC) - timedelta(days=3)
    listed = [
        files.TenderFile(
            tender_id=tender_id,
            sequence=sequence,
            doc_type=doc_type,
            title=f"{doc_type}.pdf",
            url=url,
            active=True,
            published_at=published_at,
        )
        for sequence, doc_type, url in entries
    ]
    result = files.upsert_files(conn, tender_id, listed)
    files.mark_synced(conn, tender_id, result)
    return result


def run_job(conn, payload: dict[str, Any]) -> None:
    """Through the registry, the way the consumer would."""
    job = queue.Job(
        id=1,
        kind=ai_screening.JOB_KIND,
        key=ai_screening.job_key(str(payload.get("tender_id"))),
        priority=1,
        payload=payload,
        attempts=1,
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
)


def analyses(conn, tender_id: str) -> list[dict[str, Any]]:
    with conn.cursor() as cur:
        cur.execute(
            f"select {', '.join(COLUMNS)} from ai_analyses where tender_id = %s"
            " order by created_at, id",
            (tender_id,),
        )
        return [dict(zip(COLUMNS, row, strict=True)) for row in cur.fetchall()]


def file_rows(conn, tender_id: str) -> dict[int, dict[str, Any]]:
    keys = ("sha256", "s3_key", "pages", "text_version", "no_text")
    with conn.cursor() as cur:
        cur.execute(
            f"select sequence, {', '.join(keys)} from tender_files"
            " where tender_id = %s order by sequence",
            (tender_id,),
        )
        return {row[0]: dict(zip(keys, row[1:], strict=True)) for row in cur.fetchall()}


# ──────────────────────────────────────────────────────────────────────────
# The test that matters
# ──────────────────────────────────────────────────────────────────────────


def test_a_user_request_now_yields_an_analysis(dl_conn, tender, pncp, monkeypatch):
    """The whole broken path, from the payload the web actually enqueues.

    `{tender_id}` and nothing else: no pages, no path, no URL. Before this card
    that raised `ValueError` in `load_document` and the job landed `failed`.
    """
    monkeypatch.setattr(ai_tender, "call_model", lambda *a, **k: response(ANSWER))
    edital = pncp.serve("/arquivos/1", pdfs.text_pdf(EDITAL_PAGES))
    tr = pncp.serve("/arquivos/2", pdfs.text_pdf(TR_PAGES))
    publish(dl_conn, tender, (1, "Edital", edital), (2, "Termo de Referência", tr))

    run_job(dl_conn, {"tender_id": tender})

    stored = analyses(dl_conn, tender)
    assert len(stored) == 1
    row = stored[0]
    assert row["status"] == "ok"
    assert row["model"] == ai_tender.SCREENING_MODEL
    assert row["extraction_version"] == ai_tender.EXTRACTION_VERSION
    assert row["result"]["objeto"] == "aquisicao de pilhas alcalinas"
    # The arithmetic is ours, not the model's (§7.2).
    assert row["rules"]["minimum_capital_brl"] == 10_000.0
    assert row["rules"]["term_months"] == 12
    assert row["citation_check"]["rate"] == 1.0
    assert float(row["cost_brl"]) == round(0.00069 * ai_tender.USD_BRL, 4)

    # It is keyed on B4's digest of the active list, so an amendment retires it.
    assert row["files_hash"] == files.files_hash_for(dl_conn, tender)

    # Both documents were fetched, and what was read is recorded per file (§6.1).
    assert pncp.requested == ["/arquivos/1", "/arquivos/2"]
    rows = file_rows(dl_conn, tender)
    assert set(rows) == {1, 2}
    assert rows[1]["pages"] == len(EDITAL_PAGES)
    assert rows[2]["pages"] == len(TR_PAGES)
    for state in rows.values():
        assert len(state["sha256"]) == 64
        assert state["text_version"] == ai_tender.EXTRACTION_VERSION
        assert state["no_text"] is False


def test_the_pages_of_both_documents_reach_the_model_numbered_continuously(
    dl_conn, tender, pncp, monkeypatch
):
    """A citation to "page 4" must mean the Termo de Referência's only page."""
    seen: dict[str, Any] = {}

    def capture(model, mode, text, key, **_kwargs):
        seen["text"] = text
        return response(ANSWER)

    monkeypatch.setattr(ai_tender, "call_model", capture)
    edital = pncp.serve("/arquivos/1", pdfs.text_pdf(EDITAL_PAGES))
    tr = pncp.serve("/arquivos/2", pdfs.text_pdf(TR_PAGES))
    publish(dl_conn, tender, (1, "Edital", edital), (2, "Termo de Referência", tr))

    run_job(dl_conn, {"tender_id": tender})

    assert "Termo de Referencia" in seen["text"]
    # `select_pages` labels each page `[[página N]]`. Page 4 is the TR's only
    # page: the edital's three came first and the numbering ran straight on.
    assert "[[página 4]]\nTermo de Referencia" in seen["text"]


# ──────────────────────────────────────────────────────────────────────────
# What must not happen
# ──────────────────────────────────────────────────────────────────────────


def test_a_scanned_edital_reaches_no_text_without_an_api_call(dl_conn, tender, pncp, monkeypatch):
    """§7.2, and C1's acceptance criterion. The download path must not route
    around the guard that keeps a scan from costing anything."""

    def explode(*_args, **_kwargs):
        raise AssertionError("the API must not be called for a PDF with no text layer")

    monkeypatch.setattr(ai_tender, "call_model", explode)
    scan = pncp.serve("/arquivos/1", pdfs.scanned_pdf(12))
    publish(dl_conn, tender, (1, "Edital", scan))

    run_job(dl_conn, {"tender_id": tender})

    row = analyses(dl_conn, tender)[0]
    assert row["status"] == "no_text"
    assert row["model"] is None
    assert float(row["cost_brl"]) == 0
    assert (row["input_tokens"], row["output_tokens"]) == (0, 0)
    # …and the per-document verdict a future OCR card will select on.
    assert file_rows(dl_conn, tender)[1]["no_text"] is True


def test_the_second_request_costs_neither_a_download_nor_the_model(
    dl_conn, tender, pncp, monkeypatch
):
    """§3.2: the answer is cached permanently and shared across users.

    The cache key is a function of rows already in the database, so the poll in
    §3.1 step 4 is one query — not two PDFs fetched again to discover that the
    answer was there all along.
    """
    monkeypatch.setattr(ai_tender, "call_model", lambda *a, **k: response(ANSWER))
    edital = pncp.serve("/arquivos/1", pdfs.text_pdf(EDITAL_PAGES))
    publish(dl_conn, tender, (1, "Edital", edital))
    run_job(dl_conn, {"tender_id": tender})
    first = analyses(dl_conn, tender)
    downloads_after_first = pncp.downloads

    def explode(*_args, **_kwargs):
        raise AssertionError("a cached analysis must not be paid for again")

    monkeypatch.setattr(ai_tender, "call_model", explode)
    screening = ai_screening.screen_tender(dl_conn, {"tender_id": tender}, log=LOG)

    assert screening.cached is True
    assert screening.called_api is False
    assert pncp.downloads == downloads_after_first, "nothing was fetched a second time"
    assert analyses(dl_conn, tender) == first, "the cached row is returned, not rewritten"


def test_a_document_that_cannot_be_fetched_never_becomes_a_partial_analysis(
    dl_conn, tender, pncp, monkeypatch
):
    """All-or-nothing, and this is why: `files_hash` digests the file *list*, so
    an analysis written from half the documents would be served for ever under a
    key claiming it read all of them."""
    monkeypatch.setattr(ai_tender, "call_model", lambda *a, **k: response(ANSWER))
    edital = pncp.serve("/arquivos/1", pdfs.text_pdf(EDITAL_PAGES))
    broken = pncp.fail("/arquivos/2", 500)
    publish(dl_conn, tender, (1, "Edital", edital), (2, "Termo de Referência", broken))

    with pytest.raises(documents.DocumentError):
        run_job(dl_conn, {"tender_id": tender})

    assert analyses(dl_conn, tender) == [], "nothing is written when a document is missing"


def test_a_document_nothing_can_parse_is_no_text_and_not_four_retries(
    dl_conn, tender, pncp, monkeypatch
):
    """A `.doc` is a permanent fact about the bytes, not an outage.

    Retrying it four times over forty minutes buys nothing, and because the
    outcome is deterministic for this list the cache key stays honest. The
    edital beside it is still read.
    """
    monkeypatch.setattr(ai_tender, "call_model", lambda *a, **k: response(ANSWER))
    edital = pncp.serve("/arquivos/1", pdfs.text_pdf(EDITAL_PAGES))
    word = pncp.serve("/arquivos/2", b"\xd0\xcf\x11\xe0 an old Word document")
    publish(dl_conn, tender, (1, "Edital", edital), (2, "Termo de Referência", word))

    run_job(dl_conn, {"tender_id": tender})

    assert analyses(dl_conn, tender)[0]["status"] == "ok", "the edital was still read"
    rows = file_rows(dl_conn, tender)
    assert rows[2]["no_text"] is True
    assert rows[2]["pages"] == 0
    assert len(rows[2]["sha256"]) == 64, "we know exactly which bytes we could not read"


def test_a_tender_whose_only_document_is_unreadable_is_no_text(dl_conn, tender, pncp, monkeypatch):
    def explode(*_args, **_kwargs):
        raise AssertionError("there is nothing to send")

    monkeypatch.setattr(ai_tender, "call_model", explode)
    word = pncp.serve("/arquivos/1", b"\xd0\xcf\x11\xe0 an old Word document")
    publish(dl_conn, tender, (1, "Edital", word))

    run_job(dl_conn, {"tender_id": tender})

    assert analyses(dl_conn, tender)[0]["status"] == "no_text"


def test_the_empty_list_answer_is_found_again_on_the_next_request(dl_conn, tender, monkeypatch):
    """The one place FH's `EMPTY_MANIFEST_DIGEST -> None` rule had to be narrowed.

    `resolve_files_hash` refuses that digest, because for a payload carrying its
    own PDF it would claim a file list we do not have. But when the *documents
    come from the list itself*, the empty list is exactly what was read — so
    that is the key the `no_text` row is stored under, and the cheap cache probe
    has to look it up under the same one or the answer is never found again.
    """
    monkeypatch.setattr(ai_tender, "call_model", lambda *a, **k: response(ANSWER))
    publish(dl_conn, tender)  # a complete fetch that returned no documents

    run_job(dl_conn, {"tender_id": tender})
    stored = analyses(dl_conn, tender)
    assert len(stored) == 1
    assert stored[0]["files_hash"] == files.EMPTY_MANIFEST_DIGEST

    # FH's resolver says "no digest"; the probe must still find the row.
    assert ai_screening.resolve_files_hash(dl_conn, tender, {}) is None
    screening = ai_screening.screen_tender(dl_conn, {"tender_id": tender}, log=LOG)

    assert screening.cached is True and screening.status == "no_text"
    assert analyses(dl_conn, tender) == stored, "no second row, and no rewrite"


def test_the_cheap_probe_answers_before_anything_is_read(dl_conn, tender, pncp, monkeypatch):
    """§3.1 step 4 polls every 3 s. Each poll must cost one query, not two PDFs.

    Proved by breaking the reader: once the answer is cached, a screening that
    reached `ensure_documents` at all would raise.
    """
    monkeypatch.setattr(ai_tender, "call_model", lambda *a, **k: response(ANSWER))
    url = pncp.serve("/arquivos/1", pdfs.text_pdf(EDITAL_PAGES))
    publish(dl_conn, tender, (1, "Edital", url))
    run_job(dl_conn, {"tender_id": tender})

    def explode(*_args, **_kwargs):
        raise AssertionError("the cache key is knowable without reading a document")

    monkeypatch.setattr(documents, "ensure_documents", explode)
    for _ in range(3):  # the poll
        screening = ai_screening.screen_tender(dl_conn, {"tender_id": tender}, log=LOG)
        assert screening.cached is True and screening.status == "ok"


def test_a_pinned_payload_hash_still_wins_over_the_tenders_own_list(
    dl_conn, tender, pncp, monkeypatch
):
    """Both designs agree an explicit pin wins; the fifth source must not be the
    exception. It overrides only the *resolver's* value, never the caller's."""
    monkeypatch.setattr(ai_tender, "call_model", lambda *a, **k: response(ANSWER))
    url = pncp.serve("/arquivos/1", pdfs.text_pdf(EDITAL_PAGES))
    publish(dl_conn, tender, (1, "Edital", url))

    run_job(dl_conn, {"tender_id": tender, "files_hash": "pinned-by-the-operator"})

    assert analyses(dl_conn, tender)[0]["files_hash"] == "pinned-by-the-operator"


def test_a_file_list_nobody_has_fetched_is_not_an_empty_one(dl_conn, tender, monkeypatch):
    """The trap: "no rows" means *we have not looked*, not *there are none*.

    Reading it as the second would store a permanent `no_text` — §3.2 keeps an
    AI result for ever and C1 never overwrites one — for a tender whose edital
    is sitting on PNCP unread.
    """

    def explode(*_args, **_kwargs):
        raise AssertionError("nothing may be decided before the list has been fetched")

    monkeypatch.setattr(ai_tender, "call_model", explode)

    with pytest.raises(documents.DocumentsNotReady):
        run_job(dl_conn, {"tender_id": tender})

    assert analyses(dl_conn, tender) == []
    with dl_conn.cursor() as cur:
        cur.execute(
            "select priority, payload from jobs where kind = 'sync_files' and key = %s", (tender,)
        )
        queued = cur.fetchall()
    assert len(queued) == 1, "the list is fetched instead, and this job comes back"
    assert queued[0][0] == 1, "a user is on screen waiting (§7.3)"


def test_a_tender_that_genuinely_has_no_documents_is_a_permanent_no_text(
    dl_conn, tender, monkeypatch
):
    """Once PNCP *has* been asked and answered "none", the honest answer is
    "there is nothing to read here" — not four retries over forty minutes."""

    def explode(*_args, **_kwargs):
        raise AssertionError("there is nothing to send")

    monkeypatch.setattr(ai_tender, "call_model", explode)
    publish(dl_conn, tender)  # a complete fetch that returned no documents

    run_job(dl_conn, {"tender_id": tender})

    assert analyses(dl_conn, tender)[0]["status"] == "no_text"


# ──────────────────────────────────────────────────────────────────────────
# An amendment
# ──────────────────────────────────────────────────────────────────────────


def test_a_replaced_edital_is_re_read_and_analysed_again(dl_conn, tender, pncp, monkeypatch):
    """§3.2: an amendment invalidates text *and* screening.

    PNCP's download address is `…/arquivos/{sequencialDocumento}`, so a
    re-published edital serves different bytes from the same URL under the same
    document number. B4 moves `published_at`, which clears the extraction state
    and moves the digest; this card is what then fetches the new bytes.
    """
    monkeypatch.setattr(ai_tender, "call_model", lambda *a, **k: response(ANSWER))
    url = pncp.serve("/arquivos/1", pdfs.text_pdf(EDITAL_PAGES))
    publish(dl_conn, tender, (1, "Edital", url))
    run_job(dl_conn, {"tender_id": tender})

    first = analyses(dl_conn, tender)[0]
    first_sha = file_rows(dl_conn, tender)[1]["sha256"]

    # The same URL, different bytes, and a new publication date.
    pncp.serve("/arquivos/1", pdfs.text_pdf([*EDITAL_PAGES, "Retificacao: " + "novo " * 200]))
    amended = files.TenderFile(
        tender_id=tender,
        sequence=1,
        doc_type="Edital",
        title="Edital_Retificado.pdf",
        url=url,
        active=True,
        published_at=datetime.now(UTC),
    )
    result = files.upsert_files(dl_conn, tender, [amended])
    files.mark_synced(dl_conn, tender, result)

    assert result.replaced == 1
    assert result.changed is True
    assert file_rows(dl_conn, tender)[1]["sha256"] is None, "B4 cleared the stale extraction"

    run_job(dl_conn, {"tender_id": tender})

    stored = analyses(dl_conn, tender)
    assert len(stored) == 2, "the old analysis stays; it is simply no longer current"
    assert stored[1]["files_hash"] != first["files_hash"]
    assert file_rows(dl_conn, tender)[1]["sha256"] != first_sha, "the new bytes were read"


# ──────────────────────────────────────────────────────────────────────────
# The object store
# ──────────────────────────────────────────────────────────────────────────


def test_with_a_bucket_the_text_is_read_back_instead_of_downloaded_again(dl_conn, tender, pncp):
    """§3.2 caches the PDF and the text "until the file list changes"."""
    store = FakeStore()
    url = pncp.serve("/arquivos/1", pdfs.text_pdf(EDITAL_PAGES))
    publish(dl_conn, tender, (1, "Edital", url))

    first = documents.ensure_documents(dl_conn, tender, store=store, log=LOG)
    second = documents.ensure_documents(dl_conn, tender, store=store, log=LOG)

    assert first.downloaded == 1
    assert second.downloaded == 0, "the second reading came out of the store"
    assert pncp.downloads == 1
    assert second.document.as_dict() == first.document.as_dict()


def test_the_pdf_and_the_text_are_two_objects_so_one_can_be_deleted(dl_conn, tender, pncp):
    """The 90-day sweep deletes the PDF and keeps the text, and must be able to
    find the text afterwards with nothing but the columns that survive."""
    store = FakeStore()
    url = pncp.serve("/arquivos/1", pdfs.text_pdf(EDITAL_PAGES))
    publish(dl_conn, tender, (1, "Edital", url))

    documents.ensure_documents(dl_conn, tender, store=store, log=LOG)
    row = file_rows(dl_conn, tender)[1]

    assert row["s3_key"] in store.objects
    text = storage.text_key(tender, 1, row["sha256"])
    assert text in store.objects and text != row["s3_key"]

    # What the sweep will do: delete the object, null the column, touch nothing else.
    store.delete(row["s3_key"])
    dl_conn.execute(
        "update tender_files set s3_key = null where tender_id = %s and sequence = 1", (tender,)
    )

    after = file_rows(dl_conn, tender)[1]
    assert after["s3_key"] is None
    assert after["sha256"] == row["sha256"]
    assert storage.text_key(tender, 1, after["sha256"]) in store.objects


def test_the_extract_text_job_warms_the_cache_without_calling_the_model(
    dl_conn, tender, pncp, monkeypatch
):
    """§7.1 names `extract_text` as its own job: sampling wants the text, not
    the answer. Both paths go through `ensure_documents`, so they cannot drift."""

    def explode(*_args, **_kwargs):
        raise AssertionError("extract_text must not call the model")

    monkeypatch.setattr(ai_tender, "call_model", explode)
    url = pncp.serve("/arquivos/1", pdfs.text_pdf(EDITAL_PAGES))
    publish(dl_conn, tender, (1, "Edital", url))

    job = queue.Job(id=1, kind=documents.JOB_KIND, key=tender, priority=9, payload={}, attempts=1)
    REGISTRY.get(documents.JOB_KIND)(
        JobContext(job=job, conn=dl_conn, connect=lambda: None, log=LOG)
    )

    assert analyses(dl_conn, tender) == []
    assert file_rows(dl_conn, tender)[1]["text_version"] == ai_tender.EXTRACTION_VERSION


def test_extract_text_does_not_retry_a_tender_that_no_longer_exists(dl_conn):
    """Deleted between the enqueue and the run. `sync_files` set this precedent:
    four retries over forty minutes against a row that is not coming back."""
    job = queue.Job(
        id=1, kind=documents.JOB_KIND, key=dl_tender_id(99), priority=9, payload={}, attempts=1
    )
    REGISTRY.get(documents.JOB_KIND)(
        JobContext(job=job, conn=dl_conn, connect=lambda: None, log=LOG)
    )


def test_a_screening_of_a_tender_that_does_not_exist_still_fails(dl_conn):
    """The other half of the same rule: the user asked about something that is
    not there, and `ai_analyses.tender_id` references `tenders(id)` anyway."""
    with pytest.raises(ValueError, match="unknown tender"):
        run_job(dl_conn, {"tender_id": dl_tender_id(98)})


def test_enqueueing_an_extraction_keeps_one_live_job_per_tender(dl_conn, tender):
    assert documents.enqueue(dl_conn, tender) is not None
    assert documents.enqueue(dl_conn, tender) is None, "the dedupe index is the point"
