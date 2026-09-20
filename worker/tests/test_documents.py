"""`licitaqui.documents` without a database: selection, the download budget, the
breaker, and how several documents become one.

Every download here runs against an `httpx.MockTransport`. Nothing reaches PNCP,
S3 or OpenRouter.
"""

from __future__ import annotations

import time

import httpx
import pytest

from licitaqui import ai_tender, breaker, documents, storage
from licitaqui.files import TenderFile
from licitaqui.registry import REGISTRY

from . import pdfs


@pytest.fixture(autouse=True)
def _no_open_circuits():
    breaker.reset_all()
    yield
    breaker.reset_all()


@pytest.fixture(autouse=True)
def _no_throttle(monkeypatch):
    """The 2 req/s pace is real in production and only slows the suite down."""
    monkeypatch.setattr(documents._rate_limiter, "_min_interval", 0.0)


def file(sequence: int, *, doc_type=None, title=None, url="https://pncp/x", active=True):
    return TenderFile(
        tender_id="t", sequence=sequence, doc_type=doc_type, title=title, url=url, active=active
    )


def client_serving(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


# -- what gets read --------------------------------------------------------


def test_the_job_kind_is_registered():
    assert documents.JOB_KIND in REGISTRY.kinds()
    assert REGISTRY.get(documents.JOB_KIND) is documents.extract_text


def test_the_edital_and_the_termo_de_referencia_are_what_a_screening_reads():
    listed = [
        file(1, doc_type="Edital"),
        file(2, doc_type="Anexo"),
        file(3, doc_type="Termo de Referência"),
        file(4, doc_type="Ata de Registro de Preços"),
    ]
    assert [f.sequence for f in documents.wanted_files(listed)] == [1, 3]


def test_an_edital_typed_outros_is_still_found_by_its_file_name():
    """Agencies publish the edital under a generic type more often than the
    taxonomy suggests; the `titulo` is a file name and is checked too."""
    listed = [file(1, doc_type="Outros", title="editais/Edital_Pregao_12_2026.pdf")]
    assert [f.sequence for f in documents.wanted_files(listed)] == [1]


def test_a_tender_with_no_edital_falls_back_to_every_active_document():
    """Refusing to read a tender whose only file is "Anexo I" would be a worse
    failure than reading one document too many."""
    listed = [file(1, doc_type="Anexo I"), file(2, doc_type="Projeto Básico")]
    assert [f.sequence for f in documents.wanted_files(listed)] == [1, 2]


def test_an_inactive_document_is_never_read():
    listed = [file(1, doc_type="Edital", active=False), file(2, doc_type="Edital")]
    assert [f.sequence for f in documents.wanted_files(listed)] == [2]


def test_a_document_with_no_address_is_not_a_document_anybody_can_read():
    listed = [file(1, doc_type="Edital", url=None), file(2, doc_type="Edital")]
    assert [f.sequence for f in documents.wanted_files(listed)] == [2]


def test_the_selection_is_capped_and_deterministic():
    """The cap must not make two screenings of the *same* list read different
    sets — that is what lets `files_hash` keep digesting the list."""
    listed = [file(n, doc_type="Edital") for n in range(1, 40)]
    first = documents.wanted_files(listed)
    second = documents.wanted_files(list(reversed(listed)))

    assert len(first) == documents.MAX_DOCUMENTS
    assert [f.sequence for f in first] == [f.sequence for f in second]


# -- the download budget ---------------------------------------------------


def test_a_download_returns_the_bytes():
    data = pdfs.text_pdf(["um edital"])
    http = client_serving(lambda _r: httpx.Response(200, content=data))

    assert documents.download("https://pncp/x", client=http) == data


def test_a_stall_is_cut_off_by_the_wall_clock_and_not_by_the_read_timeout():
    """The 929 s case. Every individual read arrives; the transfer never ends.

    An `httpx` read timeout cannot catch this, which is why `download` keeps its
    own deadline over the whole transfer.
    """

    def dribble(_request):
        def stream():
            for _ in range(100):
                time.sleep(0.01)
                yield b"x" * 8

        return httpx.Response(200, content=stream())

    http = client_serving(dribble)
    with pytest.raises(documents.DocumentError, match="did not finish inside"):
        documents.download("https://pncp/x", timeout=0.05, client=http)


def test_a_file_too_large_to_hold_is_refused_before_it_is_held():
    http = client_serving(lambda _r: httpx.Response(200, content=b"x" * 5_000))
    with pytest.raises(documents.DocumentError, match="larger than"):
        documents.download("https://pncp/x", max_bytes=1_000, client=http)


def test_a_server_error_opens_the_circuit_after_two_tries():
    http = client_serving(lambda _r: httpx.Response(503))

    for _ in range(2):
        with pytest.raises(documents.DocumentError):
            documents.download("https://pncp/x", client=http)

    assert breaker.get_breaker(documents.BREAKER_NAME).state == "open"
    with pytest.raises(breaker.CircuitOpen):
        documents.download("https://pncp/x", client=http)


def test_a_missing_document_does_not_take_the_download_path_down():
    """A 404 is a quick, healthy answer about one document. Counting it against
    the breaker would stop every other tender's download for fifteen minutes."""
    http = client_serving(lambda _r: httpx.Response(404))

    for _ in range(3):
        with pytest.raises(documents.DocumentError, match="HTTP 404"):
            documents.download("https://pncp/x", client=http)

    assert breaker.get_breaker(documents.BREAKER_NAME).state == "closed"


def test_a_transport_failure_is_a_document_error_and_not_an_httpx_error():
    """Left as `httpx.ReadTimeout` it would sail past every caller here."""

    def boom(_request):
        raise httpx.ConnectError("no route to host")

    http = client_serving(boom)
    with pytest.raises(documents.DocumentError, match="ConnectError"):
        documents.download("https://pncp/x", client=http)


def test_a_large_file_that_arrives_whole_is_not_refused():
    http = client_serving(lambda _r: httpx.Response(200, content=b"y" * 2_000))
    assert len(documents.download("https://pncp/x", max_bytes=4_000, client=http)) == 2_000


# -- several documents, one reading ---------------------------------------


def _part(sequence: int, texts: list[str]) -> documents.FileText:
    pages = tuple(ai_tender.Page(n, t) for n, t in enumerate(texts, 1))
    return documents.FileText(
        sequence=sequence,
        document=ai_tender.Document(pages=pages),
        sha256="0" * 64,
        s3_key=None,
        no_text=False,
        downloaded=True,
    )


def test_pages_are_numbered_continuously_across_documents():
    """A citation to "page 4" has to mean the same thing whether the edital came
    as one PDF or as an edital plus a Termo de Referência."""
    combined = documents._combine([_part(1, ["a", "b"]), _part(3, ["c", "d"])])

    assert [(p.number, p.text) for p in combined.pages] == [
        (1, "a"),
        (2, "b"),
        (3, "c"),
        (4, "d"),
    ]


def test_the_text_object_round_trips_through_the_cache_format():
    document = ai_tender.extract_text(pdfs.text_pdf(["pagina um", "pagina dois"]))
    restored = documents._unpack(documents._pack(document))

    assert restored.as_dict() == document.as_dict()
    assert restored.extraction_version == ai_tender.EXTRACTION_VERSION


def test_a_scan_is_recognised_per_document_without_anything_being_called():
    """`no_text` is a fact about the bytes, decided by the extractor alone."""
    document = ai_tender.extract_text(pdfs.scanned_pdf(3))
    assert document.has_text is False
    assert documents.is_scan(document) is True


def test_a_short_but_readable_document_is_not_recorded_as_a_scan():
    """§6.1's `no_text` means "no text layer", not "too short to screen".

    A four-page Termo de Referência of ~1,200 characters fails the screening's
    absolute 1,500-character floor and is plainly not a scan; recording it as
    one would hand a future OCR card a queue of readable documents.
    """
    document = ai_tender.extract_text(pdfs.text_pdf(["Termo de Referencia " * 15] * 4))

    assert document.has_text is False, "too short to screen on its own"
    assert documents.is_scan(document) is False, "but it has a text layer"


def test_a_document_with_no_pages_at_all_counts_as_a_scan():
    assert documents.is_scan(ai_tender.Document(pages=())) is True


def test_the_retention_contract_is_reachable_from_the_job_side():
    assert documents.retention() == storage.describe_retention()
