"""What a 404 from PNCP's item and file endpoints does to a job.

The bug this suite pins down, from production on 2026-09-21: tender
`03788239000166-1-000229/2026` (a Dispensa) 404s on both
`/api/pncp/v1/.../itens` and `/.../arquivos`. Its two jobs spent four attempts
each and died `failed`, the tender kept zero items and zero files with nothing
recording that we had ever looked, and the 404 left a failure on the endpoint's
circuit breaker — so the next genuine timeout opened it and stopped *every*
tender's items for fifteen minutes.

Nothing here reaches PNCP: the endpoints are served from memory by an
`httpx.MockTransport`, including the Consulta detail endpoint that settles what
the 404 means. The database is real, and every row belongs to the fictitious
agency `conftest.PN_CNPJ`, which carries the per-run id and is deleted before
and after each test.
"""

from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx
import psycopg
import pytest

from licitaqui import absence
from licitaqui import breaker as breaker_module
from licitaqui import sync_files as sync_files_module
from licitaqui import sync_items as sync_items_module
from licitaqui.absence import DataVanished
from licitaqui.files import files_hash_for
from licitaqui.files import sync_event_name as files_event_name
from licitaqui.items import sync_event_name as items_event_name
from licitaqui.pncp import CONTRATACAO_PATH, FILES_PATH, ITEMS_PATH, PncpClient
from licitaqui.queue import Job
from licitaqui.registry import JobContext
from licitaqui.sync_files import read_state as files_state
from licitaqui.sync_files import sync_files
from licitaqui.sync_items import ITEMS_TTL_HOURS
from licitaqui.sync_items import read_state as items_state
from licitaqui.tenders import from_consulta, upsert_tenders
from tests.conftest import PN_CNPJ, pn_tender_id

LOG = logging.getLogger("licitaqui.pncp404test")


@pytest.fixture(autouse=True)
def _fresh_breakers():
    breaker_module.reset_all()
    yield
    breaker_module.reset_all()


# -- fixtures in the PNCP shape --------------------------------------------


def given_tender(
    conn: psycopg.Connection, seq: int, *, updated: str = "2026-09-21T10:00:00"
) -> str:
    tid = pn_tender_id(seq)
    upsert_tenders(
        conn,
        [
            from_consulta(
                {
                    "numeroControlePNCP": tid,
                    "objetoCompra": "DISP. RAZÃO DE VALOR - AQUISIÇÃO DE ARROZ BRANCO TIPO 1",
                    "orgaoEntidade": {"cnpj": PN_CNPJ, "razaoSocial": "ÓRGÃO DE TESTE PNCP404"},
                    "unidadeOrgao": {"ufSigla": "MT", "municipioNome": "Cuiabá"},
                    "modalidadeId": 8,
                    "valorTotalEstimado": 42_000.0,
                    "dataAtualizacaoGlobal": updated,
                }
            )
        ],
    )
    return tid


def item(number: int) -> dict[str, Any]:
    return {
        "numeroItem": number,
        "descricao": f"Arroz branco tipo 1, pacote de 5 kg — lote {number}",
        "materialOuServico": "M",
        "quantidade": 100,
        "valorUnitarioEstimado": 25.0,
        "valorTotal": 2_500.0,
    }


def document(sequence: int) -> dict[str, Any]:
    return {
        "url": f"https://pncp.gov.br/pncp-api/v1/…/arquivos/{sequence}",
        "tipoDocumentoId": 2,
        "statusAtivo": True,
        "dataPublicacaoPncp": "2026-09-21T09:00:00",
        "sequencialDocumento": sequence,
        "titulo": f"editais/Edital_{sequence}.pdf",
        "tipoDocumentoNome": "Edital",
    }


def pncp(
    seq: int,
    *,
    items: list[dict] | int = 404,
    files: list[dict] | int = 404,
    consulta: int = 200,
) -> Any:
    """A client factory serving one tender's three endpoints from memory.

    ``items`` and ``files`` are either the list to answer with or an HTTP status
    to answer with; ``consulta`` is the status of the Consulta detail endpoint —
    200 for a live contratação, **410** for one the agency excluded, 500 for a
    Consulta that cannot be asked.
    """
    tid = pn_tender_id(seq)
    _, rest = tid.split("-1-", 1)
    sequence, year = rest.split("/")
    paths = {
        ITEMS_PATH.format(cnpj=PN_CNPJ, year=year, sequence=int(sequence)): items,
        FILES_PATH.format(cnpj=PN_CNPJ, year=year, sequence=int(sequence)): files,
        CONTRATACAO_PATH.format(cnpj=PN_CNPJ, year=year, sequence=int(sequence)): consulta,
    }
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        answer = paths.get(request.url.path)
        if answer is None:
            return httpx.Response(404, text='{"message":"unmapped path in the test"}')
        if isinstance(answer, int):
            if answer == 200:
                return httpx.Response(200, json={"numeroControlePNCP": tid})
            return httpx.Response(answer, text=f'{{"status":"{answer}"}}')
        return httpx.Response(200, json=answer)

    def factory() -> PncpClient:
        return PncpClient(transport=httpx.MockTransport(handler), rate_limit=0.0, page_delay=0.0)

    factory.calls = calls  # type: ignore[attr-defined]
    return factory


def run_items(monkeypatch, conn: psycopg.Connection, factory, tid: str, **payload) -> None:
    monkeypatch.setattr(sync_items_module, "build_client", factory)
    job = Job(
        id=-1,
        kind="sync_items",
        key=tid,
        priority=5,
        payload={"tender_id": tid, **payload},
        attempts=1,
    )
    sync_items_module.sync_items(JobContext(job=job, conn=conn, connect=lambda: conn, log=LOG))


def run_files(monkeypatch, conn: psycopg.Connection, factory, tid: str, **payload) -> None:
    monkeypatch.setattr(sync_files_module, "build_client", factory)
    job = Job(
        id=-1,
        kind="sync_files",
        key=tid,
        priority=5,
        payload={"tender_id": tid, **payload},
        attempts=1,
    )
    sync_files(JobContext(job=job, conn=conn, connect=lambda: conn, log=LOG))


def item_rows(conn: psycopg.Connection, tid: str) -> list[int]:
    return [
        r[0]
        for r in conn.execute(
            "select number from tender_items where tender_id = %s order by number", (tid,)
        ).fetchall()
    ]


def file_rows(conn: psycopg.Connection, tid: str) -> list[int]:
    return [
        r[0]
        for r in conn.execute(
            "select sequence from tender_files where tender_id = %s order by sequence", (tid,)
        ).fetchall()
    ]


def marker(conn: psycopg.Connection, name: str) -> dict[str, Any] | None:
    row = conn.execute("select props from events where name = %s", (name,)).fetchone()
    return None if row is None else row[0]


# -- the 404 with no prior rows: information, not a failure ----------------


def test_items_404_on_a_live_tender_is_an_empty_list(
    pn_conn: psycopg.Connection, monkeypatch
) -> None:
    """Consulta still publishes it, so the 404 means "nothing to list"."""
    tid = given_tender(pn_conn, 1)

    run_items(monkeypatch, pn_conn, pncp(1, items=404, consulta=200), tid)

    assert item_rows(pn_conn, tid) == []
    props = marker(pn_conn, items_event_name(tid))
    assert props is not None, "the job must record that it looked"
    assert props["absent"] == absence.EMPTY


def test_items_404_on_a_withdrawn_tender_is_recorded_as_withdrawn(
    pn_conn: psycopg.Connection, monkeypatch
) -> None:
    """The production case: Consulta answers 410 GONE, "foi excluída"."""
    tid = given_tender(pn_conn, 2)

    run_items(monkeypatch, pn_conn, pncp(2, items=404, consulta=410), tid)

    assert item_rows(pn_conn, tid) == []
    assert marker(pn_conn, items_event_name(tid))["absent"] == absence.WITHDRAWN


def test_items_404_with_consulta_down_is_recorded_as_unconfirmed(
    pn_conn: psycopg.Connection, monkeypatch
) -> None:
    """We may not guess. The job still completes: there is nothing to lose."""
    tid = given_tender(pn_conn, 3)

    run_items(monkeypatch, pn_conn, pncp(3, items=404, consulta=500), tid)

    assert marker(pn_conn, items_event_name(tid))["absent"] == absence.UNCONFIRMED


def test_files_404_on_a_live_tender_is_an_empty_list(
    pn_conn: psycopg.Connection, monkeypatch
) -> None:
    tid = given_tender(pn_conn, 4)

    run_files(monkeypatch, pn_conn, pncp(4, files=404, consulta=200), tid)

    assert file_rows(pn_conn, tid) == []
    assert marker(pn_conn, files_event_name(tid))["absent"] == absence.EMPTY


def test_files_404_on_a_withdrawn_tender_is_recorded_as_withdrawn(
    pn_conn: psycopg.Connection, monkeypatch
) -> None:
    tid = given_tender(pn_conn, 5)

    run_files(monkeypatch, pn_conn, pncp(5, files=404, consulta=410), tid)

    assert marker(pn_conn, files_event_name(tid))["absent"] == absence.WITHDRAWN


# -- the 404 with prior rows: a regression, and nothing is deleted ---------


def test_items_404_with_stored_items_fails_loudly_and_deletes_nothing(
    pn_conn: psycopg.Connection, monkeypatch
) -> None:
    """Data we had has vanished. That is never "the list is empty now"."""
    tid = given_tender(pn_conn, 6)
    run_items(monkeypatch, pn_conn, pncp(6, items=[item(1), item(2)]), tid)
    assert item_rows(pn_conn, tid) == [1, 2]

    with pytest.raises(DataVanished) as raised:
        run_items(monkeypatch, pn_conn, pncp(6, items=404, consulta=410), tid, force=True)

    assert item_rows(pn_conn, tid) == [1, 2], "a 404 must not prune stored items"
    assert tid in str(raised.value)
    assert "2 stored row" in str(raised.value)


def test_a_regression_never_asks_consulta(pn_conn: psycopg.Connection, monkeypatch) -> None:
    """The database settles it. Spending a request on a decision already made
    would be a request against a service ADR-0001 measured down for 3 hours."""
    tid = given_tender(pn_conn, 7)
    run_items(monkeypatch, pn_conn, pncp(7, items=[item(1)]), tid)

    factory = pncp(7, items=404, consulta=410)
    with pytest.raises(DataVanished):
        run_items(monkeypatch, pn_conn, factory, tid, force=True)

    assert not any("/api/consulta/" in path for path in factory.calls)


def test_files_404_with_stored_files_fails_loudly_and_prunes_nothing(
    pn_conn: psycopg.Connection, monkeypatch
) -> None:
    """Pruning here would move `files_hash` and retire a screening on a glitch."""
    tid = given_tender(pn_conn, 8)
    run_files(monkeypatch, pn_conn, pncp(8, files=[document(1), document(2)]), tid)
    hash_before = files_hash_for(pn_conn, tid)
    assert file_rows(pn_conn, tid) == [1, 2]

    with pytest.raises(DataVanished):
        run_files(monkeypatch, pn_conn, pncp(8, files=404, consulta=410), tid, force=True)

    assert file_rows(pn_conn, tid) == [1, 2]
    assert files_hash_for(pn_conn, tid) == hash_before, "screening must not be invalidated"


# -- the property that ends the loop: no re-enqueue after an empty sync ----


def test_an_empty_item_list_is_not_fetched_again_on_the_next_sweep(
    pn_conn: psycopg.Connection, monkeypatch
) -> None:
    """The half of the bug the 404 does not explain.

    `tender_items` has no row to age when the list is empty, so a tender with
    zero items read as stale on *every* sweep and went back to PNCP forever —
    whether the 404 raised or not. The marker is what makes "we looked, there is
    nothing" a state of its own.
    """
    tid = given_tender(pn_conn, 9)
    factory = pncp(9, items=404, consulta=200)

    run_items(monkeypatch, pn_conn, factory, tid)
    after_first = len(factory.calls)
    assert items_state(pn_conn, tid).reason == "fresh"

    run_items(monkeypatch, pn_conn, factory, tid)

    assert len(factory.calls) == after_first, "the second sweep must cost no request"


def test_a_genuinely_empty_item_list_is_not_fetched_again_either(
    pn_conn: psycopg.Connection, monkeypatch
) -> None:
    """Same property, without a 404: PNCP answers 204 for "no items"."""
    tid = given_tender(pn_conn, 10)
    factory = pncp(10, items=[])

    run_items(monkeypatch, pn_conn, factory, tid)
    after_first = len(factory.calls)

    run_items(monkeypatch, pn_conn, factory, tid)

    assert items_state(pn_conn, tid).reason == "fresh"
    assert len(factory.calls) == after_first


def test_an_empty_file_list_is_not_fetched_again_on_the_next_sweep(
    pn_conn: psycopg.Connection, monkeypatch
) -> None:
    tid = given_tender(pn_conn, 11)
    factory = pncp(11, files=404, consulta=200)

    run_files(monkeypatch, pn_conn, factory, tid)
    after_first = len(factory.calls)
    assert files_state(pn_conn, tid).reason == "fresh"

    run_files(monkeypatch, pn_conn, factory, tid)

    assert len(factory.calls) == after_first


def test_a_tender_never_synced_is_not_confused_with_one_that_has_no_items(
    pn_conn: psycopg.Connection,
) -> None:
    """The distinction the marker exists to draw."""
    tid = given_tender(pn_conn, 12)

    assert items_state(pn_conn, tid).reason == "never"


def test_the_empty_marker_still_expires_with_the_ttl(
    pn_conn: psycopg.Connection, monkeypatch
) -> None:
    """"Synced, empty" is a 12 h state, not a permanent one: a tender whose
    items arrive late must not be written off forever."""
    tid = given_tender(pn_conn, 13)
    factory = pncp(13, items=404, consulta=200)
    run_items(monkeypatch, pn_conn, factory, tid)

    pn_conn.execute(
        "update events set created_at = now() - make_interval(hours => %s) where name = %s",
        (ITEMS_TTL_HOURS + 1, items_event_name(tid)),
    )

    assert items_state(pn_conn, tid).reason == "ttl"


def test_an_empty_tender_that_changes_is_fetched_again_inside_the_ttl(
    pn_conn: psycopg.Connection, monkeypatch
) -> None:
    """B2 enqueues on a moved `dataAtualizacaoGlobal`; "synced, empty" must not
    be what stops us looking when the agency finally publishes the items."""
    tid = given_tender(pn_conn, 14)
    run_items(monkeypatch, pn_conn, pncp(14, items=404, consulta=200), tid)

    later = datetime.now(UTC) + timedelta(minutes=5)
    pn_conn.execute("update tenders set pncp_updated_at = %s where id = %s", (later, tid))

    assert items_state(pn_conn, tid).reason == "tender_changed"
