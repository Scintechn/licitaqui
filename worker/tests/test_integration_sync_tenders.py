"""The sweep against the real database: the B2 acceptance criteria.

Criterion 2 — **a rerun creates 0 duplicates** — is not something an upsert can
be asserted to do in a comment, so it is measured here three ways: the row count
does not move, no second row appears under the natural key, and `updated_at` on
an unchanged row is byte-identical after the rerun. That last one matters
because §3.1's freshness clock is `updated_at`: a sweep that rewrote every row
it saw would make every tender look freshly refreshed and defeat the TTLs.

The fallback is exercised here too, not just written — ADR-0001: "an untested
fallback is worse than none".

Skipped when TEST_DATABASE_URL_B2 is not configured. Every row these tests
create belongs to the fictitious agency `conftest.B2_CNPJ` and is deleted before
and after each test.

`licitaqui.handlers` is imported for its side effect: a handler registers itself
when its module is imported, and the follow-up tests below assert what the sweep
enqueues, which depends on which kinds have a handler. Without that import this
file saw whichever kinds another test file happened to have imported first —
they passed in a full suite and failed when this file ran alone. Importing the
one module that assembles the registry is the fix; asserting less would only
have hidden it.
"""

from __future__ import annotations

import logging
from datetime import date, datetime
from zoneinfo import ZoneInfo

import httpx
import psycopg
import pytest

from licitaqui import breaker as breaker_module
from licitaqui import handlers as _handlers  # noqa: F401 - see the note below
from licitaqui import sync_tenders
from licitaqui.pncp import PncpClient
from licitaqui.queue import Job
from licitaqui.registry import REGISTRY, JobContext
from licitaqui.sync_tenders import (
    CYCLE_EVENT,
    CycleStats,
    read_watermark,
    scope_key,
    sync_open_tenders,
    write_watermark,
)
from licitaqui.tenders import from_consulta, upsert_tenders
from tests.conftest import B2_CNPJ, B2_UF

BRT = ZoneInfo("America/Sao_Paulo")
WINDOW = (date(2026, 9, 16), date(2026, 9, 17))
SCOPE = scope_key(B2_UF, (6, 8, 4))


@pytest.fixture(autouse=True)
def _fresh_breakers():
    breaker_module.reset_all()
    yield
    breaker_module.reset_all()


def record(seq: int, *, updated: str = "2026-09-17T10:00:00", **overrides) -> dict:
    """A PNCP record for the fictitious agency the cleanup deletes."""
    base = {
        "numeroControlePNCP": f"{B2_CNPJ}-1-{seq:06d}/2026",
        "anoCompra": 2026,
        "sequencialCompra": seq,
        "objetoCompra": f"Aquisição de item de teste {seq}",
        "orgaoEntidade": {"cnpj": B2_CNPJ, "razaoSocial": "ÓRGÃO DE TESTE B2", "esferaId": "M"},
        "unidadeOrgao": {
            "ufSigla": "SP",
            "municipioNome": "São Paulo",
            "nomeUnidade": "UNIDADE DE TESTE",
        },
        "modalidadeId": 6,
        "modalidadeNome": "Pregão - Eletrônico",
        "situacaoCompraNome": "Divulgada no PNCP",
        "srp": False,
        "orcamentoSigilosoCodigo": 1,
        "valorTotalEstimado": 1000.0 + seq,
        "dataAberturaProposta": "2026-09-17T08:00:00",
        "dataEncerramentoProposta": "2026-09-30T08:30:00",
        "dataAtualizacao": "2026-09-17T09:00:00",
        "dataAtualizacaoGlobal": updated,
    }
    return base | overrides


def count_tenders(conn: psycopg.Connection) -> int:
    row = conn.execute("select count(*) from tenders where agency_cnpj = %s", (B2_CNPJ,)).fetchone()
    return int(row[0])


def snapshot(conn: psycopg.Connection) -> dict[str, tuple]:
    rows = conn.execute(
        "select id, pncp_updated_at, updated_at, estimated_value, price_registration"
        "  from tenders where agency_cnpj = %s order by id",
        (B2_CNPJ,),
    ).fetchall()
    return {r[0]: r[1:] for r in rows}


def context(conn: psycopg.Connection, payload: dict) -> JobContext:
    job = Job(
        id=-1, kind="sync_open_tenders", key="b2-test", priority=5, payload=payload, attempts=1
    )
    return JobContext(
        job=job, conn=conn, connect=lambda: conn, log=logging.getLogger("licitaqui.b2test")
    )


# -- the upsert ------------------------------------------------------------


def test_the_first_sweep_inserts_every_tender(b2_conn: psycopg.Connection):
    result = upsert_tenders(b2_conn, [from_consulta(record(i)) for i in range(1, 6)])

    assert len(result.inserted) == 5
    assert result.updated == ()
    assert result.unchanged == 0
    assert count_tenders(b2_conn) == 5


def test_rerunning_the_same_sweep_creates_zero_duplicates(b2_conn: psycopg.Connection):
    """Acceptance criterion 2, at the level of the upsert."""
    batch = [from_consulta(record(i)) for i in range(1, 21)]
    upsert_tenders(b2_conn, batch)
    before = snapshot(b2_conn)

    second = upsert_tenders(b2_conn, batch)

    assert second.inserted == ()
    assert second.updated == ()
    assert second.unchanged == 20
    assert count_tenders(b2_conn) == 20
    # Not merely the same count: the same rows, untouched.
    assert snapshot(b2_conn) == before


def test_an_unchanged_row_keeps_its_updated_at(b2_conn: psycopg.Connection):
    """§3.1's freshness clock must not be reset by a sweep that changed nothing."""
    upsert_tenders(b2_conn, [from_consulta(record(1))])
    first = snapshot(b2_conn)[f"{B2_CNPJ}-1-000001/2026"][1]

    for _ in range(3):
        upsert_tenders(b2_conn, [from_consulta(record(1))])

    assert snapshot(b2_conn)[f"{B2_CNPJ}-1-000001/2026"][1] == first


def test_a_moved_pncp_timestamp_updates_the_row(b2_conn: psycopg.Connection):
    upsert_tenders(b2_conn, [from_consulta(record(1, updated="2026-09-17T10:00:00"))])
    before = snapshot(b2_conn)[f"{B2_CNPJ}-1-000001/2026"]

    result = upsert_tenders(
        b2_conn,
        [from_consulta(record(1, updated="2026-09-17T11:30:00", objetoCompra="Objeto corrigido"))],
    )

    after = snapshot(b2_conn)[f"{B2_CNPJ}-1-000001/2026"]
    assert result.updated == (f"{B2_CNPJ}-1-000001/2026",)
    assert result.inserted == ()
    assert after[0] == datetime(2026, 9, 17, 11, 30, tzinfo=BRT)
    assert after[1] > before[1]  # updated_at moved, because something changed
    assert count_tenders(b2_conn) == 1
    row = b2_conn.execute(
        "select object from tenders where id = %s", (f"{B2_CNPJ}-1-000001/2026",)
    ).fetchone()
    assert row[0] == "Objeto corrigido"


def test_an_older_timestamp_never_overwrites_a_newer_row(b2_conn: psycopg.Connection):
    """Pages can arrive out of order; the cache must not go backwards."""
    upsert_tenders(b2_conn, [from_consulta(record(1, updated="2026-09-17T11:30:00"))])

    result = upsert_tenders(b2_conn, [from_consulta(record(1, updated="2026-09-17T09:00:00"))])

    assert result.unchanged == 1
    assert snapshot(b2_conn)[f"{B2_CNPJ}-1-000001/2026"][0] == datetime(
        2026, 9, 17, 11, 30, tzinfo=BRT
    )


def test_a_search_sourced_row_does_not_blank_what_only_consulta_knows(
    b2_conn: psycopg.Connection,
):
    """The fallback has no `srp` and no estimated value: COALESCE protects them."""
    from licitaqui.tenders import from_search

    upsert_tenders(b2_conn, [from_consulta(record(1, srp=True, valorTotalEstimado=5000.0))])

    upsert_tenders(
        b2_conn,
        [
            from_search(
                {
                    "numero_controle_pncp": f"{B2_CNPJ}-1-000001/2026",
                    "description": "objeto via busca",
                    "uf": "SP",
                    "data_atualizacao_pncp": "2026-09-18T08:00:00",
                }
            )
        ],
    )

    row = b2_conn.execute(
        "select price_registration, estimated_value from tenders where id = %s",
        (f"{B2_CNPJ}-1-000001/2026",),
    ).fetchone()
    assert row[0] is True
    assert float(row[1]) == 5000.0


def test_a_fallback_sweep_adds_to_raw_rather_than_replacing_it(b2_conn: psycopg.Connection):
    """The consulta payload is the richer one; the index must not overwrite it."""
    from licitaqui.tenders import from_search

    upsert_tenders(b2_conn, [from_consulta(record(1))])
    upsert_tenders(
        b2_conn,
        [
            from_search(
                {
                    "numero_controle_pncp": f"{B2_CNPJ}-1-000001/2026",
                    "description": "objeto via busca",
                    "data_atualizacao_pncp": "2026-09-18T08:00:00",
                }
            )
        ],
    )

    raw = b2_conn.execute(
        "select raw from tenders where id = %s", (f"{B2_CNPJ}-1-000001/2026",)
    ).fetchone()[0]
    assert raw["objetoCompra"] == "Aquisição de item de teste 1"  # consulta, still there
    assert raw["description"] == "objeto via busca"  # search, added alongside


def test_the_natural_key_admits_exactly_one_row(b2_conn: psycopg.Connection):
    """§6.1's unique (agency_cnpj, year, sequence) and the primary key agree."""
    upsert_tenders(b2_conn, [from_consulta(record(7)) for _ in range(4)])

    row = b2_conn.execute(
        "select count(*) from tenders where agency_cnpj = %s and year = 2026 and sequence = 7",
        (B2_CNPJ,),
    ).fetchone()
    assert row[0] == 1


# -- the watermark ---------------------------------------------------------


def test_a_completed_cycle_advances_the_watermark(b2_conn: psycopg.Connection):
    assert read_watermark(b2_conn, SCOPE) is None

    write_watermark(b2_conn, SCOPE, CycleStats(window_start=WINDOW[0], window_end=WINDOW[1]))

    assert read_watermark(b2_conn, SCOPE) == WINDOW[1]


def test_a_degraded_cycle_is_recorded_but_does_not_advance_it(b2_conn: psycopg.Connection):
    """ADR-0001 §4: the next consulta-backed cycle re-queries the skipped window."""
    write_watermark(b2_conn, SCOPE, CycleStats(window_start=WINDOW[0], window_end=WINDOW[1]))
    degraded = CycleStats(window_start=WINDOW[1], window_end=date(2026, 9, 20), degraded=True)
    write_watermark(b2_conn, SCOPE, degraded)

    assert read_watermark(b2_conn, SCOPE) == WINDOW[1]
    logged = b2_conn.execute(
        "select count(*) from events where name = %s and props ->> 'scope' = %s",
        (CYCLE_EVENT, SCOPE),
    ).fetchone()
    assert logged[0] == 2  # the degraded cycle is in the history, just not trusted


def test_watermarks_of_different_scopes_do_not_collide(b2_conn: psycopg.Connection):
    other = scope_key(B2_UF, (6,))
    write_watermark(b2_conn, SCOPE, CycleStats(window_start=WINDOW[0], window_end=WINDOW[1]))

    assert read_watermark(b2_conn, SCOPE) == WINDOW[1]
    assert read_watermark(b2_conn, other) is None


# -- the handler, end to end ----------------------------------------------


def serving(pages_by_modality: dict[int, list[dict]], *, consulta_status: int = 200):
    """A PncpClient factory that serves PNCP from memory."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/api/consulta"):
            if consulta_status != 200:
                return httpx.Response(consulta_status, text="Erro na comunicação com o banco")
            modality = int(request.url.params["codigoModalidadeContratacao"])
            page_no = int(request.url.params["pagina"])
            pages = pages_by_modality.get(modality, [])
            if page_no > len(pages):
                return httpx.Response(204)
            return httpx.Response(
                200,
                json={"data": pages[page_no - 1], "paginasRestantes": len(pages) - page_no},
            )
        items = [
            {
                "numero_controle_pncp": r["numeroControlePNCP"],
                "description": r["objetoCompra"],
                "uf": "SP",
                "modalidade_licitacao_id": r["modalidadeId"],
                "data_atualizacao_pncp": r["dataAtualizacaoGlobal"],
                "data_fim_vigencia": r["dataEncerramentoProposta"],
            }
            for pages in pages_by_modality.values()
            for page in pages
            for r in page
        ]
        return httpx.Response(200, json={"items": items, "total": len(items)})

    def factory() -> PncpClient:
        return PncpClient(transport=httpx.MockTransport(handler), rate_limit=0, page_delay=0)

    return factory


def run_cycle(monkeypatch, conn, factory, **payload) -> None:
    monkeypatch.setattr(sync_tenders, "build_client", factory)
    sync_open_tenders(context(conn, {"uf": B2_UF, "modalities": [6, 8, 4], **payload}))


def last_cycle(conn: psycopg.Connection) -> dict:
    row = conn.execute(
        "select props from events where name = %s and props ->> 'scope' = %s order by id desc"
        " limit 1",
        (CYCLE_EVENT, SCOPE),
    ).fetchone()
    return row[0] if row else {}


def test_a_cycle_sweeps_every_modality_and_advances_the_watermark(
    b2_conn: psycopg.Connection, monkeypatch
):
    pages = {
        6: [[record(i) for i in range(1, 4)]],
        8: [[record(i) for i in range(10, 12)]],
        4: [[record(20)]],
    }

    run_cycle(monkeypatch, b2_conn, serving(pages))

    assert count_tenders(b2_conn) == 6
    props = last_cycle(b2_conn)
    assert props["complete"] is True
    assert props["source"] == "consulta"
    assert props["inserted"] == 6
    assert sorted(props["modalities_done"]) == [4, 6, 8]
    assert read_watermark(b2_conn, SCOPE) is not None


def test_rerunning_the_whole_cycle_creates_zero_duplicates(
    b2_conn: psycopg.Connection, monkeypatch
):
    """Acceptance criterion 2, end to end through the handler."""
    pages = {6: [[record(i) for i in range(1, 26)]], 8: [[record(i) for i in range(30, 40)]], 4: []}
    factory = serving(pages)

    run_cycle(monkeypatch, b2_conn, factory)
    first_count = count_tenders(b2_conn)
    before = snapshot(b2_conn)

    run_cycle(monkeypatch, b2_conn, factory)

    assert count_tenders(b2_conn) == first_count == 35
    assert snapshot(b2_conn) == before
    props = last_cycle(b2_conn)
    assert props["inserted"] == 0
    assert props["updated"] == 0
    assert props["unchanged"] == 35


def test_only_the_tenders_that_changed_are_rewritten(b2_conn: psycopg.Connection, monkeypatch):
    pages = {6: [[record(i) for i in range(1, 6)]], 8: [], 4: []}
    run_cycle(monkeypatch, b2_conn, serving(pages))

    moved = [record(1, updated="2026-09-17T23:00:00"), *[record(i) for i in range(2, 6)]]
    run_cycle(monkeypatch, b2_conn, serving({6: [moved], 8: [], 4: []}))

    props = last_cycle(b2_conn)
    assert props["updated"] == 1
    assert props["unchanged"] == 4
    assert props["inserted"] == 0


def test_a_consulta_outage_falls_back_to_search_and_holds_the_watermark(
    b2_conn: psycopg.Connection, monkeypatch
):
    """ADR-0001 §4, exercised rather than asserted.

    The fallback must do two things at once: keep the cache moving, and refuse
    to pretend the window was swept properly.
    """
    pages = {6: [[record(i) for i in range(1, 4)]], 8: [], 4: []}
    run_cycle(monkeypatch, b2_conn, serving(pages, consulta_status=500))

    props = last_cycle(b2_conn)
    assert props["complete"] is False
    assert props["degraded"] is True
    assert props["source"] == "search-fallback"
    assert sorted(props["modalities_failed"]) == [4, 6, 8]
    # The data still landed, from the search index.
    assert count_tenders(b2_conn) == 3
    # …but the window is still open, so the next healthy cycle re-sweeps it.
    assert read_watermark(b2_conn, SCOPE) is None


def test_the_next_healthy_cycle_resweeps_the_window_the_fallback_covered(
    b2_conn: psycopg.Connection, monkeypatch
):
    pages = {6: [[record(i) for i in range(1, 4)]], 8: [], 4: []}
    run_cycle(monkeypatch, b2_conn, serving(pages, consulta_status=500))
    assert read_watermark(b2_conn, SCOPE) is None

    # The outage opened the consulta circuit. It reopens after a 15-minute
    # cooldown, well inside the 30 minutes before the next scheduled cycle, so
    # the next cycle really does get to try — resetting here is the passage of
    # that time, not a convenience.
    breaker_module.reset_all()
    run_cycle(monkeypatch, b2_conn, serving(pages))

    props = last_cycle(b2_conn)
    assert props["complete"] is True
    assert props["source"] == "consulta"
    assert read_watermark(b2_conn, SCOPE) is not None
    assert count_tenders(b2_conn) == 3


def test_an_explicit_window_does_not_touch_the_watermark(b2_conn: psycopg.Connection, monkeypatch):
    """Re-running a window by hand must not rewrite the schedule's position."""
    write_watermark(b2_conn, SCOPE, CycleStats(window_start=WINDOW[0], window_end=WINDOW[1]))
    pages = {6: [[record(1)]], 8: [], 4: []}

    run_cycle(
        monkeypatch,
        b2_conn,
        serving(pages),
        window_start="2026-08-01",
        window_end="2026-08-02",
    )

    assert read_watermark(b2_conn, SCOPE) == WINDOW[1]
    assert count_tenders(b2_conn) == 1


def test_an_unmappable_record_is_skipped_rather_than_failing_the_cycle(
    b2_conn: psycopg.Connection, monkeypatch
):
    """One malformed record out of 4,000 must not cost the whole sweep."""
    good = [record(1), record(2)]
    bad = {"objetoCompra": "no control number at all"}
    run_cycle(monkeypatch, b2_conn, serving({6: [[*good, bad]], 8: [], 4: []}))

    assert count_tenders(b2_conn) == 2
    assert last_cycle(b2_conn)["complete"] is True


def test_no_followup_jobs_are_queued_for_kinds_that_have_no_handler(
    b2_conn: psycopg.Connection, monkeypatch
):
    """Queuing work nothing can run only fills `failed`.

    This used to point at whichever kind had not landed yet — `sync_items`
    until B3, then `sync_files` until B4. Both are registered now, so the test
    makes its own: a kind in `FOLLOWUP_KINDS` with no handler behind it. That
    keeps the rule under test for good, instead of only until the next card.
    """
    monkeypatch.setattr(
        sync_tenders, "FOLLOWUP_KINDS", (*sync_tenders.FOLLOWUP_KINDS, "sync_not_written_yet")
    )
    run_cycle(monkeypatch, b2_conn, serving({6: [[record(1)]], 8: [], 4: []}))

    queued = b2_conn.execute(
        "select count(*) from jobs where kind = 'sync_not_written_yet' and key like %s",
        (f"{B2_CNPJ}-%",),
    ).fetchone()
    assert queued[0] == 0
    assert "sync_not_written_yet" not in REGISTRY.kinds()
    # …and the kinds that *do* have a handler were still queued.
    assert last_cycle(b2_conn)["followups"] == 2


def test_followups_are_queued_as_soon_as_a_handler_exists(b2_conn: psycopg.Connection, monkeypatch):
    """The seam B3 and B4 arrive through: register, and this starts working.

    It used to stub the handler; B3 and then B4 registered real ones, so this
    now runs against both — which is the seam actually closing.
    """
    assert {"sync_items", "sync_files"} <= set(REGISTRY.kinds())
    run_cycle(monkeypatch, b2_conn, serving({6: [[record(1), record(2)]], 8: [], 4: []}))

    rows = b2_conn.execute(
        "select kind, key, payload from jobs where key like %s order by key, kind",
        (f"{B2_CNPJ}-%",),
    ).fetchall()
    assert [r[0] for r in rows] == ["sync_files", "sync_items", "sync_files", "sync_items"]
    assert rows[0][2] == {"tender_id": f"{B2_CNPJ}-1-000001/2026"}
    assert last_cycle(b2_conn)["followups"] == 4


def test_a_second_cycle_does_not_requeue_followups_for_unchanged_tenders(
    b2_conn: psycopg.Connection, monkeypatch
):
    factory = serving({6: [[record(1)]], 8: [], 4: []})
    run_cycle(monkeypatch, b2_conn, factory)
    run_cycle(monkeypatch, b2_conn, factory)

    assert last_cycle(b2_conn)["followups"] == 0
    rows = b2_conn.execute(
        "select count(*) from jobs where kind = 'sync_items' and key like %s",
        (f"{B2_CNPJ}-%",),
    ).fetchone()
    assert rows[0] == 1
