"""``sync_files`` against the real database, with PNCP served from memory.

Needs `TEST_DATABASE_URL_B4` (see `worker/README.md`); skips without it, and CI
fails a skip. Every tender these tests write belongs to the fictitious agency
`conftest.B4_CNPJ`, which carries the per-run id, and is deleted before and
after each test; `tender_files` and `ai_analyses` follow it through the
cascade, and the sync markers in `events` are deleted by the same run-scoped
prefix.

The acceptance criterion of card B4 — *an amendment adds a file and invalidates
text and screening* — is
:func:`test_an_amendment_retires_the_cached_screening`, at the bottom. It syncs,
screens, amends, re-syncs, and asserts the cached analysis has stopped being
served. No OpenRouter call is ever made: `ai_tender.call_model` is stubbed and
the key is poisoned.
"""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import psycopg
import pytest

from licitaqui import ai_screening, ai_tender
from licitaqui import breaker as breaker_module
from licitaqui import sync_files as sync_files_module
from licitaqui.absence import DataVanished
from licitaqui.breaker import CircuitOpen, get_breaker
from licitaqui.files import (
    files_hash_for,
    read_files,
    sync_event_name,
)
from licitaqui.pncp import BREAKER_FILES, FILES_PATH, PncpClient, PncpError
from licitaqui.queue import Job
from licitaqui.registry import REGISTRY, JobContext
from licitaqui.sync_files import FILES_TTL_HOURS, read_state, sync_files
from licitaqui.tenders import from_consulta, upsert_tenders

from .conftest import B4_CNPJ

LOG = logging.getLogger("licitaqui.b4test")


@pytest.fixture(autouse=True)
def _fresh_breakers():
    breaker_module.reset_all()
    yield
    breaker_module.reset_all()


@pytest.fixture(autouse=True)
def _never_the_real_key(monkeypatch):
    """A test must never be able to spend money, even if a stub is forgotten."""
    monkeypatch.setenv(ai_tender.OPENROUTER_KEY_VAR, "not-a-real-key")


# -- fixtures in the PNCP shape --------------------------------------------


def tender_id(seq: int = 1) -> str:
    return f"{B4_CNPJ}-1-{seq:06d}/2026"


def files_key(seq: int = 1) -> str:
    return f"{B4_CNPJ}/2026/{seq}"


def document(
    sequence: int,
    *,
    titulo: str = "editais/Edital.pdf",
    tipo: str = "Edital",
    published: str = "2026-09-14T12:23:15",
    ativo: bool = True,
) -> dict[str, Any]:
    """One record in the shape `/…/arquivos` really answers with."""
    return {
        "uri": f"https://pncp.gov.br/pncp-api/v1/…/arquivos/{sequence}",
        "url": f"https://pncp.gov.br/pncp-api/v1/…/arquivos/{sequence}",
        "tipoDocumentoId": 2,
        "statusAtivo": ativo,
        "dataPublicacaoPncp": published,
        "sequencialDocumento": sequence,
        "titulo": titulo,
        "tipoDocumentoNome": tipo,
        "tipoDocumentoDescricao": tipo,
    }


EDITAL = document(1)
TERMO = document(2, titulo="editais/TermoReferencia.pdf", tipo="Termo de Referência")
ERRATA = document(
    3, titulo="editais/Errata_01.pdf", tipo="Outros Documentos", published="2026-09-20T09:15:00"
)


def given_tender(conn: psycopg.Connection, seq: int = 1, *, updated: str = "2026-09-14T10:00:00"):
    upsert_tenders(
        conn,
        [
            from_consulta(
                {
                    "numeroControlePNCP": tender_id(seq),
                    "objetoCompra": "Aquisição de pilhas alcalinas",
                    "orgaoEntidade": {"cnpj": B4_CNPJ, "razaoSocial": "ÓRGÃO DE TESTE B4"},
                    "unidadeOrgao": {"ufSigla": "SP", "municipioNome": "São Paulo"},
                    "modalidadeId": 6,
                    "valorTotalEstimado": 100_000.0,
                    "dataAtualizacaoGlobal": updated,
                }
            )
        ],
    )
    return tender_id(seq)


def serving(lists: dict[str, list], *, status: int = 200) -> Any:
    """A client factory answering the arquivos endpoint from memory."""
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        for key, body in lists.items():
            cnpj, year, sequence = key.split("/")
            if request.url.path == FILES_PATH.format(cnpj=cnpj, year=year, sequence=sequence):
                if status != 200:
                    return httpx.Response(status)
                return httpx.Response(200, json=body)
        return httpx.Response(404, text="not found")

    def factory() -> PncpClient:
        return PncpClient(transport=httpx.MockTransport(handler), rate_limit=0.0, page_delay=0.0)

    factory.calls = calls  # type: ignore[attr-defined]
    return factory


def run_job(monkeypatch, conn: psycopg.Connection, factory, payload: dict) -> None:
    monkeypatch.setattr(sync_files_module, "build_client", factory)
    job = Job(
        id=-1,
        kind="sync_files",
        key=str(payload.get("tender_id", "")),
        priority=5,
        payload=payload,
        attempts=1,
    )
    sync_files(JobContext(job=job, conn=conn, connect=lambda: conn, log=LOG))


def rows(conn: psycopg.Connection, tid: str) -> list[tuple]:
    return conn.execute(
        "select sequence, title, doc_type, url, active, published_at"
        "  from tender_files where tender_id = %s order by sequence",
        (tid,),
    ).fetchall()


# -- the handler end to end ------------------------------------------------


def test_the_kind_is_registered() -> None:
    """Which is also what switches B2's follow-up enqueue on."""
    assert "sync_files" in REGISTRY.kinds()


def test_it_stores_the_columns_the_card_asks_for(b4_conn: psycopg.Connection, monkeypatch) -> None:
    tid = given_tender(b4_conn)

    run_job(monkeypatch, b4_conn, serving({files_key(): [EDITAL, TERMO]}), {"tender_id": tid})

    stored = rows(b4_conn, tid)
    assert [r[0] for r in stored] == [1, 2]
    assert stored[0][1] == "editais/Edital.pdf"
    assert stored[0][2] == "Edital"
    assert stored[0][3].endswith("/arquivos/1")
    assert stored[0][4] is True
    assert stored[1][2] == "Termo de Referência"


def test_the_publication_time_survives_the_round_trip(
    b4_conn: psycopg.Connection, monkeypatch
) -> None:
    """The trap: PNCP sends naive Brasília wall clock into a `timestamptz`.

    Stored without the offset, "published 12:23" would come back as 12:23 UTC —
    09:23 in Brasília — and every document would claim to be three hours older
    than it is. 12:23 BRT is 15:23 UTC, and that is what the column must hold.
    """
    tid = given_tender(b4_conn, seq=2)

    run_job(monkeypatch, b4_conn, serving({files_key(2): [EDITAL]}), {"tender_id": tid})

    published = rows(b4_conn, tid)[0][5]
    assert published.astimezone(UTC) == datetime(2026, 9, 14, 15, 23, 15, tzinfo=UTC)


def test_no_pdf_is_downloaded(b4_conn: psycopg.Connection, monkeypatch) -> None:
    """ "List only" (the card). The only call is to the arquivos endpoint, and
    the download columns are left for the card that owns them."""
    tid = given_tender(b4_conn, seq=3)
    factory = serving({files_key(3): [EDITAL, TERMO]})

    run_job(monkeypatch, b4_conn, factory, {"tender_id": tid})

    assert factory.calls == [FILES_PATH.format(cnpj=B4_CNPJ, year=2026, sequence=3)]
    download_columns = b4_conn.execute(
        "select sha256, s3_key, pages, text_version from tender_files where tender_id = %s",
        (tid,),
    ).fetchall()
    assert all(all(column is None for column in row) for row in download_columns)


def test_running_twice_changes_nothing(b4_conn: psycopg.Connection, monkeypatch) -> None:
    """§7.2: every job can run twice without duplicating — and the second run
    must not report an invalidation, or it would re-screen for ever."""
    tid = given_tender(b4_conn, seq=4)
    factory = serving({files_key(4): [EDITAL, TERMO]})

    run_job(monkeypatch, b4_conn, factory, {"tender_id": tid})
    before = rows(b4_conn, tid)
    hash_before = files_hash_for(b4_conn, tid)
    run_job(monkeypatch, b4_conn, factory, {"tender_id": tid, "force": True})

    assert rows(b4_conn, tid) == before
    assert files_hash_for(b4_conn, tid) == hash_before
    assert marker(b4_conn, tid)["invalidated"] is False


def test_an_unknown_tender_is_not_an_error(b4_conn: psycopg.Connection, monkeypatch) -> None:
    """The row can be gone by the time the follow-up runs; retrying would not
    help, and four attempts over 40 minutes would be spent for nothing."""
    factory = serving({})

    run_job(monkeypatch, b4_conn, factory, {"tender_id": tender_id(99)})

    assert factory.calls == []


def test_a_tender_with_no_documents_is_stored_as_empty(
    b4_conn: psycopg.Connection, monkeypatch
) -> None:
    tid = given_tender(b4_conn, seq=5)

    run_job(monkeypatch, b4_conn, serving({files_key(5): []}), {"tender_id": tid})

    assert rows(b4_conn, tid) == []
    assert read_state(b4_conn, tid).reason == "fresh"  # we looked; there is nothing


# -- the 12 h TTL ----------------------------------------------------------


def marker(conn: psycopg.Connection, tid: str) -> dict[str, Any]:
    row = conn.execute(
        "select props from events where name = %s", (sync_event_name(tid),)
    ).fetchone()
    assert row is not None, "the sync marker is what the TTL reads"
    return row[0]


def test_a_fresh_list_is_not_fetched_again(b4_conn: psycopg.Connection, monkeypatch) -> None:
    """§3.2 gives the file list a 12 h TTL; a duplicate job inside it costs no
    request — which is half of "no retry storm"."""
    tid = given_tender(b4_conn, seq=6)
    factory = serving({files_key(6): [EDITAL]})

    run_job(monkeypatch, b4_conn, factory, {"tender_id": tid})
    after_first = len(factory.calls)
    run_job(monkeypatch, b4_conn, factory, {"tender_id": tid})

    assert len(factory.calls) == after_first
    assert read_state(b4_conn, tid).reason == "fresh"


def test_an_expired_list_is_fetched_again(b4_conn: psycopg.Connection, monkeypatch) -> None:
    tid = given_tender(b4_conn, seq=7)
    factory = serving({files_key(7): [EDITAL]})
    run_job(monkeypatch, b4_conn, factory, {"tender_id": tid})

    b4_conn.execute(
        "update events set created_at = now() - make_interval(hours => %s) where name = %s",
        (FILES_TTL_HOURS + 1, sync_event_name(tid)),
    )

    assert read_state(b4_conn, tid).reason == "ttl"
    run_job(monkeypatch, b4_conn, factory, {"tender_id": tid})
    assert len(factory.calls) == 2


def test_a_tender_that_changed_is_fetched_again_inside_the_ttl(
    b4_conn: psycopg.Connection, monkeypatch
) -> None:
    """B2 enqueues on a moved `dataAtualizacaoGlobal` — which is exactly what an
    amendment moves. The TTL must not be what stops us looking."""
    tid = given_tender(b4_conn, seq=8)
    factory = serving({files_key(8): [EDITAL]})
    run_job(monkeypatch, b4_conn, factory, {"tender_id": tid})
    assert read_state(b4_conn, tid).reason == "fresh"

    later = datetime.now(UTC) + timedelta(minutes=5)
    b4_conn.execute("update tenders set pncp_updated_at = %s where id = %s", (later, tid))

    assert read_state(b4_conn, tid).reason == "tender_changed"
    run_job(monkeypatch, b4_conn, factory, {"tender_id": tid})
    assert len(factory.calls) == 2


def test_a_tender_never_synced_is_not_confused_with_one_that_has_no_files(
    b4_conn: psycopg.Connection,
) -> None:
    tid = given_tender(b4_conn, seq=9)

    assert read_state(b4_conn, tid).reason == "never"


# -- pruning and the text invalidation -------------------------------------


def test_a_withdrawn_document_is_deleted(b4_conn: psycopg.Connection, monkeypatch) -> None:
    tid = given_tender(b4_conn, seq=10)
    run_job(monkeypatch, b4_conn, serving({files_key(10): [EDITAL, TERMO]}), {"tender_id": tid})

    run_job(
        monkeypatch,
        b4_conn,
        serving({files_key(10): [EDITAL]}),
        {"tender_id": tid, "force": True},
    )

    assert [r[0] for r in rows(b4_conn, tid)] == [1]
    assert marker(b4_conn, tid)["removed"] == 1
    assert marker(b4_conn, tid)["invalidated"] is True


def test_only_this_tenders_documents_are_pruned(b4_conn: psycopg.Connection, monkeypatch) -> None:
    first = given_tender(b4_conn, seq=11)
    second = given_tender(b4_conn, seq=12)
    both = [EDITAL, TERMO]
    run_job(monkeypatch, b4_conn, serving({files_key(11): both}), {"tender_id": first})
    run_job(monkeypatch, b4_conn, serving({files_key(12): both}), {"tender_id": second})

    run_job(
        monkeypatch,
        b4_conn,
        serving({files_key(11): [EDITAL]}),
        {"tender_id": first, "force": True},
    )

    assert len(rows(b4_conn, first)) == 1
    assert len(rows(b4_conn, second)) == 2


def extracted(conn: psycopg.Connection, tid: str, sequence: int) -> tuple:
    return conn.execute(
        "select sha256, s3_key, pages, text_version, no_text"
        "  from tender_files where tender_id = %s and sequence = %s",
        (tid, sequence),
    ).fetchone()


def pretend_extracted(conn: psycopg.Connection, tid: str, sequence: int) -> None:
    """What the download/extraction card will eventually write on the row."""
    conn.execute(
        "update tender_files"
        "   set sha256 = 'deadbeef', s3_key = 'tenders/x.pdf', pages = 42,"
        "       text_version = 3, no_text = false"
        " where tender_id = %s and sequence = %s",
        (tid, sequence),
    )


@pytest.mark.parametrize(
    "field,changed",
    [
        ("url", {"sequencialDocumento": 1, "url": "https://pncp.gov.br/…/arquivos/1?v=2"}),
        ("title", {"titulo": "editais/Edital_Retificado.pdf"}),
        ("doc_type", {"tipoDocumentoNome": "Termo de Referência"}),
        ("published_at", {"dataPublicacaoPncp": "2026-09-20T09:15:00"}),
    ],
)
def test_a_replaced_document_loses_its_extracted_text(
    b4_conn: psycopg.Connection, monkeypatch, field: str, changed: dict
) -> None:
    """The "invalidates text" half of §3.2, field by field.

    PNCP serves a replaced document from the same `…/arquivos/1`, so the URL
    alone cannot detect it. Each of these four fields is part of a document's
    identity, and each one moving must clear everything derived from the old
    bytes — otherwise a later reader sees the new document beside the old page
    count and the old extracted text.
    """
    tid = given_tender(b4_conn, seq=13)
    run_job(monkeypatch, b4_conn, serving({files_key(13): [EDITAL]}), {"tender_id": tid})
    pretend_extracted(b4_conn, tid, 1)
    assert extracted(b4_conn, tid, 1) == ("deadbeef", "tenders/x.pdf", 42, 3, False)

    run_job(
        monkeypatch,
        b4_conn,
        serving({files_key(13): [{**EDITAL, **changed}]}),
        {"tender_id": tid, "force": True},
    )

    assert extracted(b4_conn, tid, 1) == (None, None, None, None, None), field
    assert marker(b4_conn, tid)["replaced"] == 1


def test_an_unchanged_document_keeps_its_extracted_text(
    b4_conn: psycopg.Connection, monkeypatch
) -> None:
    """The other side of the same coin: re-syncing an unchanged list must not
    throw away work that is still valid, or every sync would re-extract and
    re-screen the whole country."""
    tid = given_tender(b4_conn, seq=14)
    factory = serving({files_key(14): [EDITAL, TERMO]})
    run_job(monkeypatch, b4_conn, factory, {"tender_id": tid})
    pretend_extracted(b4_conn, tid, 1)

    run_job(monkeypatch, b4_conn, factory, {"tender_id": tid, "force": True})

    assert extracted(b4_conn, tid, 1) == ("deadbeef", "tenders/x.pdf", 42, 3, False)


def test_a_document_going_inactive_keeps_its_text_but_leaves_the_manifest(
    b4_conn: psycopg.Connection, monkeypatch
) -> None:
    """Withdrawal does not change bytes, so the text stays valid — but the
    document stops counting, so the screening key moves."""
    tid = given_tender(b4_conn, seq=15)
    run_job(monkeypatch, b4_conn, serving({files_key(15): [EDITAL, TERMO]}), {"tender_id": tid})
    pretend_extracted(b4_conn, tid, 2)
    before = files_hash_for(b4_conn, tid)

    run_job(
        monkeypatch,
        b4_conn,
        serving({files_key(15): [EDITAL, {**TERMO, "statusAtivo": False}]}),
        {"tender_id": tid, "force": True},
    )

    assert extracted(b4_conn, tid, 2)[2] == 42  # the bytes did not change
    assert files_hash_for(b4_conn, tid) != before  # but it no longer counts
    assert read_files(b4_conn, tid)[1].active is False


# -- failure: the breaker, and never pruning on an outage -------------------


def test_a_failing_endpoint_raises_and_deletes_nothing(
    b4_conn: psycopg.Connection, monkeypatch
) -> None:
    """A 500 is an outage, not "this tender has no documents any more".

    Nothing is written before the call returns, so the stored list — and the
    `files_hash` every cached analysis hangs off — survives an outage intact.
    """
    tid = given_tender(b4_conn, seq=16)
    run_job(monkeypatch, b4_conn, serving({files_key(16): [EDITAL, TERMO]}), {"tender_id": tid})
    before = files_hash_for(b4_conn, tid)

    with pytest.raises(PncpError):
        run_job(
            monkeypatch,
            b4_conn,
            serving({files_key(16): []}, status=500),
            {"tender_id": tid, "force": True},
        )

    assert len(rows(b4_conn, tid)) == 2
    assert files_hash_for(b4_conn, tid) == before


def test_a_404_does_not_prune_either(b4_conn: psycopg.Connection, monkeypatch) -> None:
    """A tender that had an edital yesterday and 404s today has not lost it.

    The **type** of the failure changed on 2026-09-22 and the guarantee did
    not. A 404 is no longer a bare `PncpError`: :mod:`licitaqui.absence` reads
    it against what we already hold, and a 404 for a tender with stored
    documents is a *regression* — `DataVanished`, with the counts, rather than
    an outage indistinguishable from a timeout. What this test exists to
    protect is unchanged and is the line below: the rows are still there, so
    `files_hash` has not moved and no screening was retired on PNCP's say-so.

    `licitaqui.absence` never asks Consulta on this path — the database has
    already settled it — so `serving({})` 404ing every path is not consulted
    about the verdict.
    """
    tid = given_tender(b4_conn, seq=17)
    run_job(monkeypatch, b4_conn, serving({files_key(17): [EDITAL]}), {"tender_id": tid})
    hash_before = files_hash_for(b4_conn, tid)

    with pytest.raises(DataVanished):
        run_job(monkeypatch, b4_conn, serving({}), {"tender_id": tid, "force": True})

    assert len(rows(b4_conn, tid)) == 1
    assert files_hash_for(b4_conn, tid) == hash_before


def test_two_failures_open_the_circuit_and_the_third_call_is_not_made(
    b4_conn: psycopg.Connection, monkeypatch
) -> None:
    """§7.2 and the measured 3-hour outage: the file list has its own breaker,
    so a dead endpoint stops costing a timeout budget per job instead of being
    hammered by every tender in the queue."""
    tid = given_tender(b4_conn, seq=18)
    factory = serving({files_key(18): []}, status=500)

    for _ in range(2):
        with pytest.raises(PncpError):
            run_job(monkeypatch, b4_conn, factory, {"tender_id": tid, "force": True})
    calls_before = len(factory.calls)

    with pytest.raises(CircuitOpen):
        run_job(monkeypatch, b4_conn, factory, {"tender_id": tid, "force": True})

    assert len(factory.calls) == calls_before, "the open circuit must stop the call being made"
    assert get_breaker(BREAKER_FILES).state == "open"


def test_the_file_breaker_is_its_own(b4_conn: psycopg.Connection, monkeypatch) -> None:
    """An arquivos outage must not stop items arriving, nor the sweep that
    feeds every other job."""
    tid = given_tender(b4_conn, seq=19)
    factory = serving({files_key(19): []}, status=500)

    for _ in range(2):
        with pytest.raises(PncpError):
            run_job(monkeypatch, b4_conn, factory, {"tender_id": tid, "force": True})

    assert get_breaker(BREAKER_FILES).state == "open"
    assert get_breaker("pncp-itens").state == "closed"
    assert get_breaker("pncp-consulta").state == "closed"


# -- the acceptance criterion ----------------------------------------------
#
# "An amendment adds a file and invalidates text and screening."

ANSWER = {
    "objeto": "aquisicao de pilhas alcalinas",
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


def model_response(payload: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    return 200, {
        "choices": [{"message": {"content": json.dumps(payload)}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 18_000, "completion_tokens": 900, "cost": 0.00069},
    }


def screen(conn: psycopg.Connection, tid: str, files_hash: str) -> None:
    """Run C1's screening job the way the consumer would, for one file set."""
    job = Job(
        id=-1,
        kind=ai_screening.JOB_KIND,
        key=ai_screening.job_key(tid),
        priority=1,
        payload={"tender_id": tid, "pages": PAGES, "files_hash": files_hash},
        attempts=1,
    )
    REGISTRY.get(ai_screening.JOB_KIND)(
        JobContext(job=job, conn=conn, connect=lambda: conn, log=LOG)
    )


def analyses(conn: psycopg.Connection, tid: str) -> list[tuple]:
    return conn.execute(
        "select files_hash, status from ai_analyses where tender_id = %s order by created_at",
        (tid,),
    ).fetchall()


def test_an_amendment_retires_the_cached_screening(
    b4_conn: psycopg.Connection, monkeypatch
) -> None:
    """Card B4's acceptance criterion, end to end.

    Sync the file list, screen the tender under the hash that list produces,
    then have the agency publish an errata. After the re-sync the cached
    analysis must no longer be served as this tender's current answer — and it
    must still exist, because it is a true reading of the documents that were
    published at the time and the record of what was paid for it.

    The last assertion is the one that matters most: a *second* screening run,
    under the new hash, does not return the cached verdict. That is the
    difference between "the key changed" and "the product actually stopped
    showing a superseded analysis".
    """
    calls: list[int] = []
    monkeypatch.setattr(
        ai_tender, "call_model", lambda *a, **k: (calls.append(1), model_response(ANSWER))[1]
    )
    tid = given_tender(b4_conn, seq=20)

    # 1. the tender as first published: an edital and a termo de referência
    run_job(monkeypatch, b4_conn, serving({files_key(20): [EDITAL, TERMO]}), {"tender_id": tid})
    before = files_hash_for(b4_conn, tid)

    # 2. someone screens it, and the answer is cached against that file set
    screen(b4_conn, tid, before)
    assert analyses(b4_conn, tid) == [(before, "ok")]
    assert len(calls) == 1
    assert ai_screening.cached(b4_conn, tid, before) is not None

    # a second request inside the same file set is free — the cache working
    screen(b4_conn, tid, before)
    assert len(calls) == 1

    # 3. the agency amends the tender: an errata is published
    run_job(
        monkeypatch,
        b4_conn,
        serving({files_key(20): [EDITAL, TERMO, ERRATA]}),
        {"tender_id": tid, "force": True},
    )
    after = files_hash_for(b4_conn, tid)

    assert [r[0] for r in rows(b4_conn, tid)] == [1, 2, 3]
    assert after != before, "a new document must move the screening key"
    assert marker(b4_conn, tid)["invalidated"] is True
    assert marker(b4_conn, tid)["added"] == 1
    # What the job recorded and what the next caller will read must be the same
    # value, or a screening would be keyed on a hash nothing else agrees with.
    assert marker(b4_conn, tid)["files_hash"] == after
    assert marker(b4_conn, tid)["previous_files_hash"] == before

    # 4. the cached analysis is no longer this tender's current answer…
    assert ai_screening.cached(b4_conn, tid, after) is None
    # …while remaining true of, and keyed to, the documents it actually read
    assert ai_screening.cached(b4_conn, tid, before) is not None

    # 5. and screening again really does re-read rather than serve the old row
    screen(b4_conn, tid, after)
    assert len(calls) == 2, "the superseded analysis must not be served as a hit"
    assert analyses(b4_conn, tid) == [(before, "ok"), (after, "ok")]


def test_an_amendment_also_retires_the_extracted_text(
    b4_conn: psycopg.Connection, monkeypatch
) -> None:
    """The other half of the criterion, where the amendment *replaces* the
    edital rather than adding to it — the dangerous shape, because the document
    number and the download URL both stay the same."""
    tid = given_tender(b4_conn, seq=21)
    run_job(monkeypatch, b4_conn, serving({files_key(21): [EDITAL, TERMO]}), {"tender_id": tid})
    pretend_extracted(b4_conn, tid, 1)
    before = files_hash_for(b4_conn, tid)

    amended = document(1, titulo="editais/Edital_Retificado.pdf", published="2026-09-20T09:15:00")
    run_job(
        monkeypatch,
        b4_conn,
        serving({files_key(21): [amended, TERMO]}),
        {"tender_id": tid, "force": True},
    )

    assert extracted(b4_conn, tid, 1) == (None, None, None, None, None)
    assert files_hash_for(b4_conn, tid) != before
